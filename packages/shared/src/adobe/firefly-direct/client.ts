/**
 * Adobe Firefly 直连客户端（移植自 adobe2api core/adobe_client.py 的图像生成路径）。
 *
 * 流程（异步）：
 *   1. 用多候选 payload 依次 POST /v2/3p-images/generate-async（命中 200 即停）。
 *   2. 从响应头 x-override-status-link 或 body.links.result 取轮询 URL。
 *   3. 轮询直到 outputs[0].image.presignedUrl 出现 → 下载字节返回。
 * 图生图：先 uploadImage 拿 image id，放进 payload 的 referenceBlobs/referenceImages。
 *
 * API 调用（提交/轮询/上传）走可插拔传输（生产走 Go TLS 旁路）；产物下载用直连
 * （presigned URL 无需 TLS 伪装）。
 */

import {
  AdobeAcceptedVideoError,
  AdobeRequestError,
  AdobeVideoSubmissionUncertainError,
  AuthError,
  isRetryableStatus,
  QuotaExhaustedError,
  UpstreamTemporaryError,
} from "./errors";
import {
  buildFireflyImagePayloadCandidates,
  buildFireflyVideoPayload,
  type FireflyImagePayload,
  type FireflyVideoPayload,
} from "./payloads";
import { buildArpSessionId, buildSubmitNonce } from "./signing";
import {
  FetchFireflyTransport,
  type FireflyTransport,
  type FireflyTransportResponse,
} from "./transport";

const SUBMIT_URL = "https://firefly-3p.ff.adobe.io/v2/3p-images/generate-async";
const VIDEO_SUBMIT_URL =
  "https://firefly-3p.ff.adobe.io/v2/3p-videos/generate-async";
const UPLOAD_URL = "https://firefly-3p.ff.adobe.io/v2/storage/image";

export type AdobeFireflyWebApp = "express" | "firefly";

type AdobeFireflyWebAppProfile = {
  apiKey: string;
  origin: string;
  referer: string;
};

/** Adobe 两个网页入口各自发送的公开客户端标识和来源头。 */
const WEB_APP_PROFILES: Record<AdobeFireflyWebApp, AdobeFireflyWebAppProfile> =
  {
    express: {
      apiKey: "projectx_webapp",
      origin: "https://new.express.adobe.com",
      referer: "https://new.express.adobe.com/",
    },
    firefly: {
      apiKey: "clio-playground-web",
      origin: "https://firefly.adobe.com",
      referer: "https://firefly.adobe.com/",
    },
  };
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";
const DEFAULT_SEC_CH_UA =
  '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"';

export type AdobeFireflyClientConfig = {
  /** 所模拟的 Adobe 网页入口；默认保持既有 Express 行为。 */
  webApp?: AdobeFireflyWebApp;
  apiKey?: string;
  userAgent?: string;
  secChUa?: string;
  /** API 调用（提交/轮询/上传）的传输；默认直连 fetch（生产应传 Go 旁路传输）。 */
  transport?: FireflyTransport;
  /** 产物下载传输；默认直连 fetch。 */
  downloadTransport?: FireflyTransport;
};

export type GenerateImageInput = {
  token: string;
  prompt: string;
  aspectRatio: string;
  outputResolution: string;
  upstreamModelId: string;
  upstreamModelVersion: string;
  qualityLevel?: string | null;
  detailLevel?: number | null;
  sourceImageIds?: string[] | null;
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
};

export type GenerateImageOutput = {
  bytes: Buffer;
  raw: Record<string, unknown>;
};

export type GenerateVideoInput = {
  token: string;
  prompt: string;
  upstreamModel: string;
  upstreamModelId: string;
  upstreamModelVersion: string;
  engine: string;
  duration: number;
  aspectRatio: string;
  outputResolution: string;
  size: { width: number; height: number };
  generateAudio: boolean;
  referenceMode?: "image";
  negativePrompt?: string | null;
  /** 已上传的输入图 id（图生视频首帧/尾帧/参考）。 */
  sourceImageIds?: string[] | null;
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
};

export type GenerateVideoOutput = {
  bytes: Buffer;
  raw: Record<string, unknown>;
};

/** 视频提交成功后持久化所需的恢复上下文。 */
export type SubmitVideoOutput = {
  pollUrl: string;
  upstreamJobId: string | null;
  raw: Record<string, unknown>;
};

/** 单次视频轮询结果；pending 由持久 worker 决定下次执行时间。 */
export type PollVideoOutput =
  | { status: "pending"; raw: Record<string, unknown> }
  | {
      status: "completed";
      videoUrl: string;
      raw: Record<string, unknown>;
    };

const ADOBE_STATIC_POLL_HOSTS = new Set([
  "firefly-3p.ff.adobe.io",
  "firefly.adobe.io",
  "firefly.adobe.com",
]);
const ADOBE_FIREFLY_EPO_HOST_PATTERN =
  /^firefly-epo(\d{4})(?:\d{2})?(?:-prod)?\.adobe\.io$/;
const ADOBE_BKS_EPO_HOST_PATTERN = /^bks-epo(\d{4})\.adobe\.io$/;
const ADOBE_EPO_JOB_PATH_PATTERN =
  /^\/(?:v2\/)?(?:jobs(?:\/result)?|status)\/([^/]+)$/;
const ADOBE_BKS_JOB_PATH_PATTERN = /^\/v2\/jobs\/result\/([^/]+)$/;

/**
 * 解析并校验 Adobe 轮询 URL 的通用 HTTPS 安全边界。
 *
 * @param value Adobe 提交响应返回或数据库恢复的轮询地址。
 * @returns 已完成协议、端口、凭据与 fragment 校验的 URL。
 * @throws 地址非法或可能跨越 Adobe 主机边界时抛出 AdobeRequestError。
 */
function parseSecureAdobePollUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AdobeRequestError("Adobe 轮询地址不受信任");
  }
  if (
    url.protocol !== "https:" ||
    (url.port !== "" && url.port !== "443") ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new AdobeRequestError("Adobe 轮询地址不受信任");
  }
  return url;
}

/**
 * 提取受支持 Firefly EPO 主机对应的四位 BKS 分片号。
 *
 * @param hostname 已转为小写的目标主机名。
 * @returns 合法四位或六位 EPO 主机的前四位分片号，否则为 null。
 */
function getFireflyEpoShard(hostname: string): string | null {
  return hostname.match(ADOBE_FIREFLY_EPO_HOST_PATTERN)?.[1] ?? null;
}

/**
 * 从 Adobe 支持的 EPO 轮询路径提取单段任务 ID。
 *
 * @param pathname URL 解析器规范化后的路径。
 * @returns 合法 jobs、jobs/result 或 status 路径中的任务 ID，否则为 null。
 */
function getAdobeEpoJobId(pathname: string): string | null {
  const jobId = pathname.match(ADOBE_EPO_JOB_PATH_PATTERN)?.[1];
  return jobId && jobId !== "result" ? jobId : null;
}

/**
 * 校验或规范化 Adobe 提交响应中的轮询地址。
 *
 * Adobe 会返回动态 `firefly-epo` 主机；浏览器实际通过同分片 `bks-epo`
 * 端点查询任务。这里只接受四位或六位数字加可选 prod 后缀的 EPO 形态，并验证
 * BKS 查询中的 host 与分片一致，避免重新放宽到任意 adobe.io 子域。
 *
 * @param value Adobe 返回或持久化的轮询地址。
 * @returns 可安全交给 API 代理调用的规范化地址。
 * @throws 非 Adobe 主机、相似域或分片不一致时抛出 AdobeRequestError。
 */
function normalizeAdobePollUrl(value: string): string {
  const url = parseSecureAdobePollUrl(value);
  const hostname = url.hostname.toLowerCase();
  if (ADOBE_STATIC_POLL_HOSTS.has(hostname)) return url.toString();

  const fireflyShard = getFireflyEpoShard(hostname);
  if (fireflyShard) {
    const jobId = getAdobeEpoJobId(url.pathname);
    if (!jobId) {
      throw new AdobeRequestError("Adobe 轮询地址不受信任");
    }
    return `https://bks-epo${fireflyShard}.adobe.io/v2/jobs/result/${jobId}?host=${hostname}/`;
  }

  const bksShard = hostname.match(ADOBE_BKS_EPO_HOST_PATTERN)?.[1];
  if (bksShard) {
    const hostValues = url.searchParams.getAll("host");
    const upstreamHost = hostValues[0]?.replace(/\/$/, "").toLowerCase();
    const queryKeys = [...url.searchParams.keys()];
    if (
      hostValues.length !== 1 ||
      queryKeys.length !== 1 ||
      !upstreamHost ||
      getFireflyEpoShard(upstreamHost) !== bksShard ||
      !ADOBE_BKS_JOB_PATH_PATTERN.test(url.pathname)
    ) {
      throw new AdobeRequestError("Adobe 轮询地址不受信任");
    }
    return `${url.origin}${url.pathname}?host=${upstreamHost}/`;
  }

  throw new AdobeRequestError("Adobe 轮询地址不受信任");
}

/**
 * 校验将被持久化和重复调用的视频轮询地址。
 *
 * 只接受代码内 Adobe 精确主机和 HTTPS 默认端口，阻断相似域、用户信息与协议降级。
 */
export function assertAdobeVideoPollUrl(value: string): string {
  try {
    return normalizeAdobePollUrl(value);
  } catch {
    throw new AdobeRequestError("Adobe 视频轮询地址不受信任");
  }
}

/** 从 Adobe 提交响应提取不含凭据的任务标识。 */
function extractVideoJobId(data: Record<string, unknown>): string | null {
  for (const key of ["id", "jobId", "taskId"] as const) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new Error("aborted"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class AdobeFireflyClient {
  private readonly apiKey: string;
  private readonly origin: string;
  private readonly referer: string;
  private readonly userAgent: string;
  private readonly secChUa: string;
  private readonly transport: FireflyTransport;
  private readonly downloadTransport: FireflyTransport;

  constructor(config: AdobeFireflyClientConfig = {}) {
    const profile = WEB_APP_PROFILES[config.webApp ?? "express"];
    this.apiKey = config.apiKey?.trim() || profile.apiKey;
    this.origin = profile.origin;
    this.referer = profile.referer;
    this.userAgent = config.userAgent?.trim() || DEFAULT_USER_AGENT;
    this.secChUa = config.secChUa?.trim() || DEFAULT_SEC_CH_UA;
    this.transport = config.transport ?? new FetchFireflyTransport();
    this.downloadTransport =
      config.downloadTransport ?? new FetchFireflyTransport();
  }

  private browserHeaders(): Record<string, string> {
    return {
      "user-agent": this.userAgent,
      origin: this.origin,
      referer: this.referer,
      "accept-language": "en-US,en;q=0.9",
      "sec-ch-ua": this.secChUa,
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
    };
  }

  private submitHeaders(token: string): Record<string, string> {
    return {
      ...this.browserHeaders(),
      Authorization: `Bearer ${token}`,
      "x-api-key": this.apiKey,
      "content-type": "application/json",
      accept: "*/*",
    };
  }

  /**
   * 构造当前 Adobe 网页 Profile 的视频提交请求头。
   *
   * @param token 当前成员的短期 IMS Token。
   * @param prompt 本次提交提示词，最多前 256 字符参与 nonce。
   * @returns 浏览器基础头、Bearer、API Key、ARP 会话及可生成时的 nonce。
   * @sideEffects 每次调用都会生成新的随机 ARP 会话标识。
   * @failure Token 无账号 claim 时省略 nonce，由上游返回明确鉴权错误。
   */
  private videoSubmitHeaders(
    token: string,
    prompt: string
  ): Record<string, string> {
    const nonce = buildSubmitNonce(token, prompt);
    return {
      ...this.submitHeaders(token),
      "x-arp-session-id": buildArpSessionId(),
      ...(nonce ? { "x-nonce": nonce } : {}),
    };
  }

  private pollHeaders(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      accept: "*/*",
      referer: this.referer,
      origin: this.origin,
      "user-agent": this.userAgent,
      "x-api-key": this.apiKey,
      "content-type": "application/json",
    };
  }

  /** 上传图（图生图前置），返回 Adobe image id。移植 upload_image。 */
  async uploadImage(
    token: string,
    imageBytes: Buffer | Uint8Array,
    mimeType = "image/jpeg",
    signal?: AbortSignal
  ): Promise<string> {
    if (!imageBytes || imageBytes.length === 0) {
      throw new AdobeRequestError("image is empty");
    }
    const resp = await this.transport.request({
      method: "POST",
      url: UPLOAD_URL,
      headers: {
        authorization: `Bearer ${token}`,
        "x-api-key": this.apiKey,
        "content-type": mimeType,
        accept: "application/json",
      },
      body: imageBytes,
      signal,
      timeoutMs: 60_000,
    });
    await this.throwForStatus(resp, "upload image");
    const data = (await resp.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const images = (data?.images as Array<Record<string, unknown>>) || [];
    const imageId = images[0]?.id;
    if (!imageId) {
      throw new AdobeRequestError(
        "upload image succeeded but no image id returned"
      );
    }
    return String(imageId);
  }

  /** 文生图/图生图：提交→轮询→下载。移植 generate（图像路径）。 */
  async generateImage(input: GenerateImageInput): Promise<GenerateImageOutput> {
    const candidates = buildFireflyImagePayloadCandidates({
      prompt: input.prompt,
      aspectRatio: input.aspectRatio,
      outputResolution: input.outputResolution,
      upstreamModelId: input.upstreamModelId,
      upstreamModelVersion: input.upstreamModelVersion,
      qualityLevel: input.qualityLevel,
      detailLevel: input.detailLevel,
      sourceImageIds: input.sourceImageIds,
    });

    let submitResp: FireflyTransportResponse | null = null;
    let lastError = "";
    for (const payload of candidates) {
      submitResp = await this.transport.request({
        method: "POST",
        url: SUBMIT_URL,
        headers: this.submitHeaders(input.token),
        body: JSON.stringify(payload as FireflyImagePayload),
        signal: input.signal,
        timeoutMs: 60_000,
      });
      if (submitResp.status === 200) break;
      if (submitResp.status === 401 || submitResp.status === 403) break;
      lastError = (await submitResp.text().catch(() => "")).slice(0, 300);
    }

    if (!submitResp) throw new AdobeRequestError("submit failed: no response");

    if (submitResp.status === 401 || submitResp.status === 403) {
      const accessError = submitResp.headers["x-access-error"];
      if (accessError === "taste_exhausted") {
        throw new QuotaExhaustedError("Adobe quota exhausted for this account");
      }
      throw new AuthError("Token invalid or expired", {
        statusCode: submitResp.status,
      });
    }

    if (submitResp.status !== 200) {
      const body =
        lastError || (await submitResp.text().catch(() => "")).slice(0, 300);
      if (isRetryableStatus(submitResp.status)) {
        throw new UpstreamTemporaryError(
          `submit failed: ${submitResp.status} ${body}`,
          { statusCode: submitResp.status, errorType: "status" }
        );
      }
      throw new AdobeRequestError(
        `submit failed: ${submitResp.status} ${body}`
      );
    }

    const submitData = (await submitResp.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const rawPollUrl = extractResultLink(submitResp.headers, submitData);
    if (!rawPollUrl) {
      throw new AdobeRequestError("submit succeeded but no poll url returned");
    }
    const pollUrl = normalizeAdobePollUrl(rawPollUrl);

    const timeoutMs = input.timeoutMs ?? 180_000;
    const pollIntervalMs = input.pollIntervalMs ?? 3_000;
    const start = Date.now();

    for (;;) {
      const pollResp = await this.transport.request({
        method: "GET",
        url: pollUrl,
        headers: this.pollHeaders(input.token),
        signal: input.signal,
        timeoutMs: 60_000,
      });
      if (pollResp.status !== 200) {
        const body = (await pollResp.text().catch(() => "")).slice(0, 300);
        if (pollResp.status === 401 || pollResp.status === 403) {
          throw new AuthError("Token invalid or expired", {
            statusCode: pollResp.status,
          });
        }
        if (isRetryableStatus(pollResp.status)) {
          throw new UpstreamTemporaryError(
            `poll failed: ${pollResp.status} ${body}`,
            { statusCode: pollResp.status, errorType: "status" }
          );
        }
        throw new AdobeRequestError(`poll failed: ${pollResp.status} ${body}`);
      }

      const latest = (await pollResp.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const statusHeader = String(
        pollResp.headers["x-task-status"] || ""
      ).toUpperCase();
      const statusVal =
        String(latest.status || "").toUpperCase() || statusHeader;

      const outputs = (latest.outputs as Array<Record<string, unknown>>) || [];
      if (outputs.length > 0) {
        const image = outputs[0]?.image as Record<string, unknown> | undefined;
        const imageUrl = image?.presignedUrl;
        if (!imageUrl || typeof imageUrl !== "string") {
          throw new AdobeRequestError("job finished without image url");
        }
        const bytes = await this.download(imageUrl, input.signal);
        return { bytes, raw: latest };
      }

      if (
        statusVal === "FAILED" ||
        statusVal === "CANCELLED" ||
        statusVal === "ERROR"
      ) {
        throw new AdobeRequestError(
          `image job failed: ${JSON.stringify(latest).slice(0, 300)}`
        );
      }

      if (Date.now() - start > timeoutMs) {
        throw new AdobeRequestError("generation timed out");
      }
      await sleep(pollIntervalMs, input.signal);
    }
  }

  /** 提交一次视频任务；网络/5xx/缺少 poll URL 均按结果不确定处理，禁止自动重投。 */
  async submitVideo(input: GenerateVideoInput): Promise<SubmitVideoOutput> {
    const payload: FireflyVideoPayload = buildFireflyVideoPayload({
      prompt: input.prompt,
      upstreamModel: input.upstreamModel,
      upstreamModelId: input.upstreamModelId,
      upstreamModelVersion: input.upstreamModelVersion,
      engine: input.engine,
      duration: input.duration,
      aspectRatio: input.aspectRatio,
      outputResolution: input.outputResolution,
      size: input.size,
      generateAudio: input.generateAudio,
      ...(input.referenceMode ? { referenceMode: input.referenceMode } : {}),
      ...(input.negativePrompt != null
        ? { negativePrompt: input.negativePrompt }
        : {}),
      ...(input.sourceImageIds ? { sourceImageIds: input.sourceImageIds } : {}),
    });

    let submitResp: FireflyTransportResponse;
    try {
      submitResp = await this.transport.request({
        method: "POST",
        url: VIDEO_SUBMIT_URL,
        headers: this.videoSubmitHeaders(input.token, input.prompt),
        body: JSON.stringify(payload),
        signal: input.signal,
        timeoutMs: 60_000,
      });
    } catch (error) {
      throw new AdobeVideoSubmissionUncertainError(
        error instanceof Error
          ? `video submit response was not observed: ${error.message}`
          : "video submit response was not observed",
        { errorType: "network" }
      );
    }

    if (submitResp.status === 401 || submitResp.status === 403) {
      const accessError = submitResp.headers["x-access-error"];
      if (accessError === "taste_exhausted") {
        throw new QuotaExhaustedError("Adobe quota exhausted for this account");
      }
      throw new AuthError("Token invalid or expired", {
        statusCode: submitResp.status,
      });
    }
    if (submitResp.status !== 200) {
      const body = (await submitResp.text().catch(() => "")).slice(0, 300);
      if (submitResp.status >= 500) {
        throw new AdobeVideoSubmissionUncertainError(
          `video submit returned uncertain HTTP ${submitResp.status}: ${body}`,
          { statusCode: submitResp.status, errorType: "status" }
        );
      }
      if (isRetryableStatus(submitResp.status)) {
        throw new UpstreamTemporaryError(
          `video submit failed: ${submitResp.status} ${body}`,
          { statusCode: submitResp.status, errorType: "status" }
        );
      }
      throw new AdobeRequestError(
        `video submit failed: ${submitResp.status} ${body}`
      );
    }

    const submitData = (await submitResp.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const rawPollUrl = extractResultLink(submitResp.headers, submitData);
    if (!rawPollUrl) {
      throw new AdobeVideoSubmissionUncertainError(
        "video submit succeeded but no poll url returned"
      );
    }
    let pollUrl: string;
    try {
      pollUrl = assertAdobeVideoPollUrl(rawPollUrl);
    } catch (error) {
      throw new AdobeVideoSubmissionUncertainError(
        error instanceof Error ? error.message : "Adobe 视频轮询地址不受信任",
        { errorType: "status" }
      );
    }
    return {
      pollUrl,
      upstreamJobId: extractVideoJobId(submitData),
      raw: submitData,
    };
  }

  /** 对已接受的原视频任务执行一次轮询，不在本方法内睡眠或重新提交。 */
  async pollVideo(input: {
    token: string;
    pollUrl: string;
    signal?: AbortSignal;
  }): Promise<PollVideoOutput> {
    const pollUrl = assertAdobeVideoPollUrl(input.pollUrl);
    return this.pollValidatedVideo({
      token: input.token,
      pollUrl,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }

  /**
   * 对已经过信任边界校验的视频地址执行一次轮询。
   *
   * @param input 令牌、规范化轮询地址及可选取消信号。
   * @returns 当前任务状态；上游请求或结果异常时抛出已接受任务错误。
   */
  private async pollValidatedVideo(input: {
    token: string;
    pollUrl: string;
    signal?: AbortSignal;
  }): Promise<PollVideoOutput> {
    let pollResp: FireflyTransportResponse;
    try {
      pollResp = await this.transport.request({
        method: "GET",
        url: input.pollUrl,
        headers: this.pollHeaders(input.token),
        signal: input.signal,
        timeoutMs: 60_000,
      });
    } catch (error) {
      throw new AdobeAcceptedVideoError(
        error instanceof Error
          ? `video polling failed after submission: ${error.message}`
          : "video polling failed after submission",
        { errorType: "network" }
      );
    }
    if (pollResp.status !== 200) {
      const body = (await pollResp.text().catch(() => "")).slice(0, 300);
      throw new AdobeAcceptedVideoError(
        `video poll failed after submission: ${pollResp.status} ${body}`,
        { statusCode: pollResp.status, errorType: "status" }
      );
    }

    const latest = (await pollResp.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const statusHeader = String(
      pollResp.headers["x-task-status"] || ""
    ).toUpperCase();
    const statusValue =
      String(latest.status || "").toUpperCase() || statusHeader;
    const outputs = (latest.outputs as Array<Record<string, unknown>>) || [];
    const video = outputs[0]?.video as Record<string, unknown> | undefined;
    const videoUrl = video?.presignedUrl;
    if (
      statusValue === "FAILED" ||
      statusValue === "CANCELLED" ||
      statusValue === "ERROR"
    ) {
      throw new AdobeAcceptedVideoError(
        `video job failed after submission: ${JSON.stringify(latest).slice(0, 300)}`,
        { errorType: "status" }
      );
    }
    if (statusValue === "COMPLETED" || statusValue === "SUCCEEDED") {
      if (!videoUrl || typeof videoUrl !== "string") {
        throw new AdobeAcceptedVideoError(
          "video job completed without output",
          { errorType: "status" }
        );
      }
      return { status: "completed", videoUrl, raw: latest };
    }
    if (!statusValue && typeof videoUrl === "string") {
      return { status: "completed", videoUrl, raw: latest };
    }
    return { status: "pending", raw: latest };
  }

  /** 下载已完成视频的短期上游 URL；调用方负责持久化到本站存储。 */
  async downloadVideo(url: string, signal?: AbortSignal): Promise<Buffer> {
    return this.download(url, signal);
  }

  /** 文生视频/图生视频兼容闭环；新恢复状态机应直接调用三个独立阶段。 */
  async generateVideo(input: GenerateVideoInput): Promise<GenerateVideoOutput> {
    const submitted = await this.submitVideo(input);

    // 视频生成耗时较长，默认 600s 超时、3s 轮询（移植视频规格）。
    const timeoutMs = input.timeoutMs ?? 600_000;
    const pollIntervalMs = input.pollIntervalMs ?? 3_000;
    const start = Date.now();

    for (;;) {
      try {
        const polled = await this.pollValidatedVideo({
          token: input.token,
          pollUrl: submitted.pollUrl,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        if (polled.status === "completed") {
          try {
            const bytes = await this.downloadVideo(
              polled.videoUrl,
              input.signal
            );
            return { bytes, raw: polled.raw };
          } catch (error) {
            throw new AdobeAcceptedVideoError(
              error instanceof Error
                ? `video download failed after submission: ${error.message}`
                : "video download failed after submission",
              { errorType: "network" }
            );
          }
        }
      } catch (error) {
        if (error instanceof AdobeAcceptedVideoError) {
          if (
            error.statusCode !== undefined &&
            !isRetryableStatus(error.statusCode)
          ) {
            throw error;
          }
        }
        if (input.signal?.aborted) {
          throw new AdobeAcceptedVideoError(
            "video polling aborted after submission",
            { errorType: "network" }
          );
        }
        if (Date.now() - start > timeoutMs) {
          throw new AdobeAcceptedVideoError(
            "video generation timed out after submission",
            { errorType: "timeout" }
          );
        }
        await sleep(pollIntervalMs, input.signal).catch(() => {
          throw new AdobeAcceptedVideoError(
            "video polling aborted after submission",
            { errorType: "network" }
          );
        });
        continue;
      }
      if (Date.now() - start > timeoutMs) {
        throw new AdobeAcceptedVideoError(
          "video generation timed out after submission",
          { errorType: "timeout" }
        );
      }
      await sleep(pollIntervalMs, input.signal).catch(() => {
        throw new AdobeAcceptedVideoError(
          "video polling aborted after submission",
          { errorType: "network" }
        );
      });
    }
  }

  private async download(url: string, signal?: AbortSignal): Promise<Buffer> {
    const resp = await this.downloadTransport.request({
      method: "GET",
      url,
      headers: { accept: "*/*" },
      signal,
      timeoutMs: 60_000,
    });
    if (resp.status !== 200) {
      throw new AdobeRequestError(
        `media download failed: HTTP ${resp.status}`,
        { statusCode: resp.status }
      );
    }
    return resp.bytes();
  }

  private async throwForStatus(
    resp: FireflyTransportResponse,
    context: string
  ): Promise<void> {
    if (resp.status === 200 || resp.status === 201) return;
    const body = (await resp.text().catch(() => "")).slice(0, 300);
    if (resp.status === 401 || resp.status === 403) {
      throw new AuthError("Token invalid or expired", {
        statusCode: resp.status,
      });
    }
    if (isRetryableStatus(resp.status)) {
      throw new UpstreamTemporaryError(
        `${context} failed: ${resp.status} ${body}`,
        { statusCode: resp.status, errorType: "status" }
      );
    }
    throw new AdobeRequestError(`${context} failed: ${resp.status} ${body}`);
  }
}

/** 移植 _extract_result_link：先取响应头 x-override-status-link，再取 body.links.result。 */
export function extractResultLink(
  headers: Record<string, string>,
  submitData: Record<string, unknown>
): string {
  const headerLink = String(headers["x-override-status-link"] || "").trim();
  if (headerLink) return headerLink;

  const links = submitData.links as Record<string, unknown> | undefined;
  if (!links || typeof links !== "object") return "";
  const resultLink = links.result;
  if (typeof resultLink === "string") return resultLink.trim();
  if (resultLink && typeof resultLink === "object") {
    return String((resultLink as Record<string, unknown>).href || "").trim();
  }
  return "";
}

/** 将 Firefly 分片返回的 firefly-epo 任务地址转换为 bks-epo 查询地址。 */
export function normalizeVideoPollUrl(rawUrl: string): string {
  if (!rawUrl) return rawUrl;
  try {
    const parsed = new URL(rawUrl);
    const hostname = parsed.hostname.toLowerCase();
    const match = /^firefly-epo(\d{4})-prod\.adobe\.io$/.exec(hostname);
    const pathParts = parsed.pathname.split("/").filter(Boolean);
    const jobId = pathParts.at(-1);
    if (!match || !jobId || parsed.port) return rawUrl;
    return `https://bks-epo${match[1]}.adobe.io/v2/jobs/result/${jobId}?host=${hostname}/`;
  } catch {
    return rawUrl;
  }
}
