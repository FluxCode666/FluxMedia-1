/**
 * Adobe Firefly 直连派发（mode=direct）：用本仓库移植的逆向逻辑
 * （@repo/shared/adobe/firefly-direct）直连 Adobe Firefly，经 Go TLS 旁路过风控，
 * 不依赖外部 adobe2api 进程。
 *
 * 职责：
 * - 一对一凭据：每个 Adobe direct 顶层成员持有一个 cookie 与短期 IMS token。
 * - 出图：取成员 token → 选模型族/尺寸 → 图生图先 uploadImage → generateImage。
 */

import { db } from "@repo/database";
import { imageBackendMemberAdobeConfig } from "@repo/database/schema";
import {
  type AdobeImageResolution,
  type AdobeRatio,
  canAdobeBackendServeModel,
  composeAdobeImageModelId,
  mapSizeToAdobe,
  resolveAdobeImageFamily,
} from "@repo/shared/adobe";
import {
  AdobeAcceptedVideoError,
  AdobeFireflyClient,
  AdobeVideoSubmissionUncertainError,
  AuthError,
  decodeJwtExp,
  decodeJwtPayload,
  type FireflyTransport,
  type FireflyTransportRequest,
  type FireflyTransportResponse,
  fetchCreditsBalance,
  fireflyVideoMaxInputImages,
  fireflyVideoSize,
  isAdobeMemberSwitchableError,
  isTokenExpired,
  ProxyFireflyTransport,
  QuotaExhaustedError,
  refreshAccessTokenFromCookie,
  resolveFireflyImageModel,
  resolveFireflyVideoModel,
} from "@repo/shared/adobe/firefly-direct";
import { logError, logWarn } from "@repo/shared/logger";
import { and, eq, sql } from "drizzle-orm";
import {
  fetchMediaUpstreamDownload,
  MAX_IMAGE_UPSTREAM_DOWNLOAD_BYTES,
  MAX_VIDEO_UPSTREAM_DOWNLOAD_BYTES,
} from "@/features/image-backend-pool/media-upstream-fetch";
import type { ApiConfig, GenerateImageResult } from "./types";
import { prepareAdobeVideoSourceImage } from "./adobe-video-source";
import { requireAcceptedVideoCredential } from "./video-recovery-policy";

// IMS access_token 距过期多久内视为需要刷新（秒）。
const TOKEN_REFRESH_SKEW_SECONDS = 120;

/** 读取 Adobe direct 专用代理配置；缺失时显式失败，禁止绕过固定出口直连。 */
function getAdobeDirectProxyConfig(): {
  url: string;
  secret: string;
} {
  const rawUrl = process.env.ADOBE_DIRECT_PROXY_URL?.trim();
  const url = rawUrl?.replace(/\/+$/, "");
  const secret = process.env.ADOBE_DIRECT_PROXY_SECRET?.trim();
  if (!url || !secret) {
    throw new Error(
      "Adobe direct 需要配置 ADOBE_DIRECT_PROXY_URL 和 ADOBE_DIRECT_PROXY_SECRET"
    );
  }
  return { url, secret };
}

/** 把安全下载响应适配为 Firefly client 使用的惰性字节响应。 */
function toFireflyTransportResponse(
  response: Response
): FireflyTransportResponse {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  let cached: Buffer | null = null;
  const readBytes = async (): Promise<Buffer> => {
    cached ??= Buffer.from(await response.arrayBuffer());
    return cached;
  };
  return {
    status: response.status,
    headers,
    bytes: readBytes,
    text: async () => (await readBytes()).toString("utf-8"),
    json: async () => JSON.parse((await readBytes()).toString("utf-8")),
  };
}

/** Adobe 产物下载传输；逐跳 DNS pin 且按媒体类型限制真实响应字节。 */
class SecureAdobeDownloadTransport implements FireflyTransport {
  constructor(private readonly maxResponseBytes: number) {}

  async request(
    request: FireflyTransportRequest
  ): Promise<FireflyTransportResponse> {
    if (request.method !== "GET" || request.body !== undefined) {
      throw new Error("Adobe 安全下载传输只允许无正文 GET 请求");
    }
    const response = await fetchMediaUpstreamDownload(request.url, {
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
      maxResponseBytes: this.maxResponseBytes,
    });
    return toFireflyTransportResponse(response);
  }
}

/** 构造 API/下载传输：Adobe API 固定走专用旁路，产物下载安全直连。 */
async function buildAdobeTransports(
  maxDownloadBytes = MAX_IMAGE_UPSTREAM_DOWNLOAD_BYTES
): Promise<{
  apiTransport: FireflyTransport;
  downloadTransport: FireflyTransport;
}> {
  const proxy = getAdobeDirectProxyConfig();
  const downloadTransport = new SecureAdobeDownloadTransport(maxDownloadBytes);
  return {
    apiTransport: new ProxyFireflyTransport({
      proxyUrl: proxy.url,
      secret: proxy.secret,
    }),
    downloadTransport,
  };
}

function tokenExpiresAt(value: string): Date | null {
  const exp = decodeJwtExp(value);
  return exp === null ? null : new Date(exp * 1000);
}

/** 拒绝 Guest 会话 cookie：能 refresh 但 Firefly 生图会 401。 */
function assertLoggedInAdobeCookie(
  accessToken: string,
  account: { displayName: string; email: string; userId: string } | null
): void {
  const sub = String(decodeJwtPayload(accessToken).sub || "").trim();
  if (sub.includes("@GuestID")) {
    throw new Error(
      "Cookie 对应 Firefly 访客会话（GuestID），不是已登录 Adobe 账号。请在已登录 new.express.adobe.com 的标签页用 tools/adobe-cookie-exporter 重新导出（需含 HttpOnly 会话 cookie，例如 aux_sid）。"
    );
  }
  if (!account?.userId && !account?.email && !account?.displayName) {
    throw new Error(
      "Cookie 能刷新 token，但读不到 Adobe 账号信息。请确认浏览器已登录 Adobe ID，并用 cookie 导出扩展重新导出完整 cookie。"
    );
  }
}

/** 使用 direct 成员自己的 Cookie 刷新并回写其一对一短期凭据。 */
async function refreshMemberCredential(
  memberId: string,
  credential: { cookie: string; scope: string | null },
  transport: FireflyTransport,
  signal?: AbortSignal
): Promise<{ value: string } | null> {
  try {
    const result = await refreshAccessTokenFromCookie(
      transport,
      credential.cookie,
      {
        scope: credential.scope ?? undefined,
        signal,
        fetchAccount: true,
      }
    );
    const now = new Date();
    await db
      .update(imageBackendMemberAdobeConfig)
      .set({
        accessToken: result.accessToken,
        tokenExpiresAt: tokenExpiresAt(result.accessToken),
        credentialStatus: "active",
        tokenFails: 0,
        lastRefreshAt: now,
        lastRefreshError: null,
        consecutiveFailures: 0,
        ...(result.account
          ? {
              displayName: result.account.displayName || null,
              email: result.account.email || null,
              accountUserId: result.account.userId || null,
            }
          : {}),
        updatedAt: now,
      })
      .where(eq(imageBackendMemberAdobeConfig.memberId, memberId));
    await storeMemberCredits(
      transport,
      memberId,
      result.accessToken,
      signal
    ).catch((error) =>
      logError(error, { source: "adobe-credits-balance", memberId })
    );
    return { value: result.accessToken };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(imageBackendMemberAdobeConfig)
      .set({
        credentialStatus: "error",
        lastRefreshError: message.slice(0, 500),
        consecutiveFailures: sql`${imageBackendMemberAdobeConfig.consecutiveFailures} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(imageBackendMemberAdobeConfig.memberId, memberId));
    logError(error, { source: "adobe-direct-refresh", memberId });
    return null;
  }
}

// best-effort 拉取 Firefly 余额并写入成员配置；失败只记 creditsError，
// 不抛出（余额是运营展示用，不应影响刷新/生成主流程）。
async function storeMemberCredits(
  transport: FireflyTransport,
  memberId: string,
  accessToken: string,
  signal?: AbortSignal
): Promise<void> {
  const toInt = (value: number | null) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.round(value)
      : null;
  try {
    const balance = await fetchCreditsBalance(transport, accessToken, signal);
    await db
      .update(imageBackendMemberAdobeConfig)
      .set({
        creditsTotal: toInt(balance.total),
        creditsUsed: toInt(balance.used),
        creditsAvailable: toInt(balance.available),
        creditsUpdatedAt: new Date(),
        creditsError: null,
        updatedAt: new Date(),
      })
      .where(eq(imageBackendMemberAdobeConfig.memberId, memberId));
  } catch (error) {
    await db
      .update(imageBackendMemberAdobeConfig)
      .set({
        creditsError: (error instanceof Error
          ? error.message
          : String(error)
        ).slice(0, 300),
        creditsUpdatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(imageBackendMemberAdobeConfig.memberId, memberId))
      .catch((persistError) =>
        logError(persistError, {
          source: "adobe-credits-balance-persist-error",
          memberId,
        })
      );
  }
}

/**
 * 读取 direct 成员唯一凭据；短期 token 不可用时只刷新这个成员自己的 Cookie。
 */
async function acquireMemberCredential(
  memberId: string,
  transport: FireflyTransport,
  signal?: AbortSignal
): Promise<{ value: string } | null> {
  const [credential] = await db
    .select({
      cookie: imageBackendMemberAdobeConfig.cookie,
      scope: imageBackendMemberAdobeConfig.scope,
      value: imageBackendMemberAdobeConfig.accessToken,
      status: imageBackendMemberAdobeConfig.credentialStatus,
      expiresAt: imageBackendMemberAdobeConfig.tokenExpiresAt,
    })
    .from(imageBackendMemberAdobeConfig)
    .where(
      and(
        eq(imageBackendMemberAdobeConfig.memberId, memberId),
        eq(imageBackendMemberAdobeConfig.mode, "direct")
      )
    )
    .limit(1);
  if (!credential?.cookie || !credential.value) return null;
  const expired = credential.expiresAt
    ? credential.expiresAt.getTime() - TOKEN_REFRESH_SKEW_SECONDS * 1000 <=
      Date.now()
    : isTokenExpired(credential.value, TOKEN_REFRESH_SKEW_SECONDS);
  if (credential.status === "active" && !expired) {
    return { value: credential.value };
  }
  return refreshMemberCredential(
    memberId,
    { cookie: credential.cookie, scope: credential.scope },
    transport,
    signal
  );
}

/** 将成员唯一短期凭据标记为不可用，由统一顶层调度切换成员。 */
async function markCredentialStatus(
  memberId: string,
  status: "error" | "exhausted" | "invalid"
): Promise<void> {
  await db
    .update(imageBackendMemberAdobeConfig)
    .set({
      credentialStatus: status,
      tokenFails: sql`${imageBackendMemberAdobeConfig.tokenFails} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(imageBackendMemberAdobeConfig.memberId, memberId));
}

/**
 * 使用一个 direct 顶层成员的一对一凭据执行一次调用。
 * 可切换错误直接交还统一调度器，禁止在成员内部再次选账号。
 */
async function runWithAdobeCredential<T>(
  memberId: string,
  transport: FireflyTransport,
  signal: AbortSignal | undefined,
  run: (token: string) => Promise<T>
): Promise<
  | { ok: true; value: T }
  | {
      ok: false;
      error: string;
      switchable: boolean;
      upstreamAccepted: boolean;
      terminal: boolean;
      submissionUncertain: boolean;
    }
> {
  const acquired = await acquireMemberCredential(memberId, transport, signal);
  if (!acquired) {
    return {
      ok: false,
      error: "Adobe 直连成员没有可用凭据",
      switchable: !signal?.aborted,
      upstreamAccepted: false,
      terminal: Boolean(signal?.aborted),
      submissionUncertain: false,
    };
  }
  try {
    return { ok: true, value: await run(acquired.value) };
  } catch (error) {
    if (error instanceof QuotaExhaustedError) {
      await markCredentialStatus(memberId, "exhausted").catch((persistError) =>
        logError(persistError, {
          source: "adobe-direct-credential-status",
          memberId,
        })
      );
    } else if (error instanceof AuthError) {
      await markCredentialStatus(memberId, "invalid").catch((persistError) =>
        logError(persistError, {
          source: "adobe-direct-credential-status",
          memberId,
        })
      );
    }
    const message =
      error instanceof Error ? error.message : "Adobe 直连生成失败";
    const upstreamAccepted = error instanceof AdobeAcceptedVideoError;
    const submissionUncertain =
      error instanceof AdobeVideoSubmissionUncertainError;
    const switchable =
      isAdobeMemberSwitchableError(error) &&
      !signal?.aborted &&
      !upstreamAccepted;
    if (switchable) {
      logWarn("Adobe 直连成员失败，交由统一号池切换", {
        source: "adobe-direct-switch",
        memberId,
        error: message.slice(0, 160),
      });
    } else {
      logError(error, { source: "adobe-direct", memberId });
    }
    return {
      ok: false,
      error: message,
      switchable,
      upstreamAccepted,
      terminal: !switchable && !upstreamAccepted && !submissionUncertain,
      submissionUncertain,
    };
  }
}

/**
 * mode=direct 的 adobe 派发：读取成员凭据 → 选模型族/尺寸 → 图生图先上传 → generateImage。
 * 出错返回 { error }，由上层管线统一处理（含池上报）。
 */
export async function runAdobeDirectImageRequest(
  config: ApiConfig,
  params: {
    prompt: string;
    model?: string | null;
    size?: string | null;
    quality?: string | null;
    images?: Array<{ data: Buffer; type?: string | null }>;
    signal?: AbortSignal;
  }
): Promise<GenerateImageResult> {
  const memberId = config.backend?.id;
  if (!memberId) return { error: "Adobe 直连成员缺少 id" };
  if (
    !canAdobeBackendServeModel({
      enabledModels: config.backend?.adobeEnabledModels,
      supportsVideo: config.backend?.adobeSupportsVideo ?? false,
      requestedModel: params.model,
    })
  ) {
    return { error: "此 Adobe 后端未开放所请求的模型" };
  }

  const { apiTransport, downloadTransport } = await buildAdobeTransports();

  // 模型族 + 宽高比/分辨率与凭据无关，只需计算一次：family 优先取请求 model
  // （创作页/接口选的 Firefly 或裸 Nano Banana 模型），普通/未知模型落 gpt-image-2；
  // ratio/res 由 size 映射，缺省走后端默认。
  const family = resolveAdobeImageFamily(params.model);
  const fallbackRatio = (config.backend?.adobeDefaultRatio ||
    "1x1") as AdobeRatio;
  const fallbackResolution = (config.backend?.adobeDefaultResolution ||
    "2k") as AdobeImageResolution;
  const mapped = mapSizeToAdobe(params.size, {
    ratio: fallbackRatio,
    resolution: fallbackResolution,
  });
  const modelId = composeAdobeImageModelId({
    family,
    resolution: mapped.resolution,
    ratio: mapped.ratio,
  });
  const modelConf = resolveFireflyImageModel(modelId);
  if (!modelConf) {
    return { error: `Adobe 直连不支持的模型组合: ${modelId}` };
  }

  const client = new AdobeFireflyClient({
    transport: apiTransport,
    downloadTransport,
  });

  const result = await runWithAdobeCredential(
    memberId,
    apiTransport,
    params.signal,
    async (token) => {
      // 图生图上传与生成必须使用同一次成员凭据，确保 Adobe image id 归属一致。
      let sourceImageIds: string[] | undefined;
      if (params.images && params.images.length > 0) {
        sourceImageIds = [];
        for (const image of params.images) {
          sourceImageIds.push(
            await client.uploadImage(
              token,
              image.data,
              image.type || "image/png",
              params.signal
            )
          );
        }
      }

      const output = await client.generateImage({
        token,
        prompt: params.prompt,
        aspectRatio: modelConf.aspectRatio,
        outputResolution: modelConf.outputResolution,
        upstreamModelId: modelConf.upstreamModelId,
        upstreamModelVersion: modelConf.upstreamModelVersion,
        // gpt-image 质量改用户操控：用户显式选的 low/medium/high 优先;auto/未选则回退
        // 后端默认或 high。builder 把 low/medium/high → detailLevel 1/3/5,对 nano-banana
        // 忽略,故无条件透传安全。
        qualityLevel:
          params.quality && params.quality !== "auto"
            ? params.quality
            : (config.backend?.adobeGptImageQuality ?? "high"),
        ...(sourceImageIds ? { sourceImageIds } : {}),
        signal: params.signal,
      });
      return output.bytes.toString("base64");
    }
  );
  if (!result.ok) return { error: result.error };
  return { imageBase64: result.value };
}

export type AdobeVideoResult =
  | { bytes: Buffer; contentType: string; raw: Record<string, unknown> }
  | {
      error: string;
      switchable: boolean;
      upstreamAccepted: boolean;
      terminal: boolean;
      submissionUncertain?: boolean;
    };

/** Adobe 视频提交成功后供持久状态机保存的固定上游身份。 */
export type AdobeVideoSubmission = {
  memberId: string;
  pollUrl: string;
  upstreamJobId: string | null;
  raw: Record<string, unknown>;
};

/** Adobe 视频单次轮询结果，不在适配器内等待或重投。 */
export type AdobeVideoPollResult =
  | { status: "pending"; raw: Record<string, unknown> }
  | {
      status: "completed";
      videoUrl: string;
      raw: Record<string, unknown>;
    };

/** 适配器失败结果，供状态机区分切换、人工核对与固定任务恢复。 */
export type AdobeVideoStageError = {
  error: string;
  switchable: boolean;
  upstreamAccepted: boolean;
  terminal: boolean;
  submissionUncertain: boolean;
};

/**
 * 校验 direct 视频模型并构造分阶段客户端。
 *
 * @param config 已获租 Adobe direct 成员配置。
 * @param model 公开 Firefly 视频模型 ID。
 * @returns 固定成员、模型配置与客户端；失败时返回可安全展示的错误。
 */
async function createAdobeVideoStageClient(
  config: ApiConfig,
  model: string
): Promise<
  | { ok: false; error: string }
  | {
      ok: true;
      memberId: string;
      conf: NonNullable<ReturnType<typeof resolveFireflyVideoModel>>;
      size: { width: number; height: number };
      apiTransport: FireflyTransport;
      client: AdobeFireflyClient;
    }
> {
  const memberId = config.backend?.id;
  if (!memberId) return { ok: false, error: "Adobe 直连成员缺少 id" };
  if (
    !canAdobeBackendServeModel({
      enabledModels: config.backend?.adobeEnabledModels,
      supportsVideo: config.backend?.adobeSupportsVideo ?? false,
      requestedModel: model,
    })
  ) {
    return { ok: false, error: "此 Adobe 后端未开放所请求的模型" };
  }
  const conf = resolveFireflyVideoModel(model);
  if (!conf) {
    return {
      ok: false,
      error: `Adobe 直连不支持的视频模型: ${model}`,
    };
  }
  const size = fireflyVideoSize(conf.outputResolution, conf.aspectRatio);
  if (!size) {
    return {
      ok: false,
      error: `视频尺寸映射失败: ${conf.outputResolution}/${conf.aspectRatio}`,
    };
  }
  const transports = await buildAdobeTransports();
  return {
    ok: true,
    memberId,
    conf,
    size,
    apiTransport: transports.apiTransport,
    client: new AdobeFireflyClient({
      transport: transports.apiTransport,
      downloadTransport: transports.downloadTransport,
    }),
  };
}

/**
 * 提交一次 Adobe 视频任务并返回持久恢复身份。
 *
 * 明确未接受的账号级错误交由统一号池切换成员；提交响应不确定时立即停止，防止重投。
 */
export async function submitAdobeDirectVideoRequest(
  config: ApiConfig,
  params: {
    prompt: string;
    model: string;
    inputImages?: Array<{ data: Buffer; type?: string | null }>;
    negativePrompt?: string | null;
    signal?: AbortSignal;
  }
): Promise<AdobeVideoSubmission | AdobeVideoStageError> {
  const prepared = await createAdobeVideoStageClient(config, params.model);
  if (!prepared.ok) {
    return {
      error: prepared.error,
      switchable: false,
      upstreamAccepted: false,
      terminal: true,
      submissionUncertain: false,
    };
  }

  const result = await runWithAdobeCredential(
    prepared.memberId,
    prepared.apiTransport,
    params.signal,
    async (token) => {
      let sourceImageIds: string[] | undefined;
      if (params.inputImages && params.inputImages.length > 0) {
        sourceImageIds = [];
        const maxInputs = fireflyVideoMaxInputImages(prepared.conf);
        for (const image of params.inputImages.slice(0, maxInputs)) {
          const preparedImage = await prepareAdobeVideoSourceImage(
            image.data,
            prepared.size
          );
          sourceImageIds.push(
            await prepared.client.uploadImage(
              token,
              preparedImage.data,
              preparedImage.type,
              params.signal
            )
          );
        }
      }
      const submitted = await prepared.client.submitVideo({
        token,
        prompt: params.prompt,
        upstreamModel: prepared.conf.upstreamModel,
        upstreamModelId: prepared.conf.upstreamModelId,
        upstreamModelVersion: prepared.conf.upstreamModelVersion,
        engine: prepared.conf.engine,
        duration: prepared.conf.duration,
        aspectRatio: prepared.conf.aspectRatio,
        size: prepared.size,
        generateAudio: prepared.conf.generateAudio,
        ...(prepared.conf.referenceMode
          ? { referenceMode: prepared.conf.referenceMode }
          : {}),
        ...(params.negativePrompt != null
          ? { negativePrompt: params.negativePrompt }
          : {}),
        ...(sourceImageIds ? { sourceImageIds } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
      });
      return {
        memberId: prepared.memberId,
        ...submitted,
      };
    }
  );
  return result.ok ? result.value : result;
}

/**
 * 使用持久化的原成员及其一对一凭据轮询一次已接受任务。
 *
 * 成员凭据不存在时 fail closed；绝不选择替代成员。
 */
export async function pollAdobeDirectVideoRequest(input: {
  memberId: string;
  pollUrl: string;
  signal?: AbortSignal;
}): Promise<AdobeVideoPollResult> {
  const [credential] = await db
    .select({
      cookie: imageBackendMemberAdobeConfig.cookie,
      scope: imageBackendMemberAdobeConfig.scope,
      value: imageBackendMemberAdobeConfig.accessToken,
      expiresAt: imageBackendMemberAdobeConfig.tokenExpiresAt,
    })
    .from(imageBackendMemberAdobeConfig)
    .where(
      and(
        eq(imageBackendMemberAdobeConfig.memberId, input.memberId),
        eq(imageBackendMemberAdobeConfig.mode, "direct")
      )
    )
    .limit(1);
  if (!credential?.cookie || !credential.value) {
    throw new AdobeAcceptedVideoError("Adobe 视频恢复成员缺少凭据", {
      errorType: "status",
    });
  }
  const cookie = credential.cookie;
  const { apiTransport, downloadTransport } = await buildAdobeTransports();
  const client = new AdobeFireflyClient({
    transport: apiTransport,
    downloadTransport,
  });
  let tokenValue = credential.value;

  /** 只刷新持久化的原成员，绝不选择另一个顶层成员。 */
  const refreshOriginalMember = async (): Promise<string> => {
    const refreshed = await refreshMemberCredential(
      input.memberId,
      { cookie, scope: credential.scope },
      apiTransport,
      input.signal
    );
    tokenValue = requireAcceptedVideoCredential(refreshed);
    return tokenValue;
  };

  const expired = credential.expiresAt
    ? credential.expiresAt.getTime() - TOKEN_REFRESH_SKEW_SECONDS * 1000 <=
      Date.now()
    : isTokenExpired(credential.value, TOKEN_REFRESH_SKEW_SECONDS);
  if (expired) await refreshOriginalMember();

  try {
    return await client.pollVideo({
      token: tokenValue,
      pollUrl: input.pollUrl,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    if (
      error instanceof AdobeAcceptedVideoError &&
      (error.statusCode === 401 || error.statusCode === 403)
    ) {
      await refreshOriginalMember();
      return client.pollVideo({
        token: tokenValue,
        pollUrl: input.pollUrl,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    }
    throw error;
  }
}

/** 下载已完成视频；存储键和最终落库由状态机负责。 */
export async function downloadAdobeDirectVideoRequest(input: {
  memberId: string;
  videoUrl: string;
  signal?: AbortSignal;
}): Promise<Buffer> {
  const { apiTransport, downloadTransport } = await buildAdobeTransports(
    MAX_VIDEO_UPSTREAM_DOWNLOAD_BYTES
  );
  const client = new AdobeFireflyClient({
    transport: apiTransport,
    downloadTransport,
  });
  return client.downloadVideo(input.videoUrl, input.signal);
}

/**
 * mode=direct 的 adobe 视频派发：解析视频模型 → 读取成员凭据 → 图生视频先上传输入图 →
 * generateVideo（submit→轮询→下载）→ 返回视频字节。产物持久化（video_generation 落库、
 * re-host、扣费）由调用方完成。凭据级错误会标记成员状态，并交由统一调度切换成员。
 */
export async function runAdobeDirectVideoRequest(
  config: ApiConfig,
  params: {
    prompt: string;
    model: string;
    inputImages?: Array<{ data: Buffer; type?: string | null }>;
    negativePrompt?: string | null;
    signal?: AbortSignal;
  }
): Promise<AdobeVideoResult> {
  const memberId = config.backend?.id;
  if (!memberId) {
    return {
      error: "Adobe 直连成员缺少 id",
      switchable: true,
      upstreamAccepted: false,
      terminal: false,
    };
  }
  if (
    !canAdobeBackendServeModel({
      enabledModels: config.backend?.adobeEnabledModels,
      supportsVideo: config.backend?.adobeSupportsVideo ?? false,
      requestedModel: params.model,
    })
  ) {
    return {
      error: "此 Adobe 后端未开放所请求的模型",
      switchable: false,
      upstreamAccepted: false,
      terminal: true,
    };
  }

  const conf = resolveFireflyVideoModel(params.model);
  if (!conf) {
    return {
      error: `Adobe 直连不支持的视频模型: ${params.model}`,
      switchable: false,
      upstreamAccepted: false,
      terminal: true,
    };
  }
  const size = fireflyVideoSize(conf.outputResolution, conf.aspectRatio);
  if (!size) {
    return {
      error: `视频尺寸映射失败: ${conf.outputResolution}/${conf.aspectRatio}`,
      switchable: false,
      upstreamAccepted: false,
      terminal: true,
    };
  }

  const { apiTransport, downloadTransport } = await buildAdobeTransports(
    MAX_VIDEO_UPSTREAM_DOWNLOAD_BYTES
  );
  const client = new AdobeFireflyClient({
    transport: apiTransport,
    downloadTransport,
  });

  const result = await runWithAdobeCredential(
    memberId,
    apiTransport,
    params.signal,
    async (token) => {
      // 图生视频上传与提交必须使用同一次成员凭据，确保 Adobe image id 归属一致。
      let sourceImageIds: string[] | undefined;
      if (params.inputImages && params.inputImages.length > 0) {
        sourceImageIds = [];
        const maxInputs = fireflyVideoMaxInputImages(conf);
        for (const image of params.inputImages.slice(0, maxInputs)) {
          const preparedImage = await prepareAdobeVideoSourceImage(
            image.data,
            size
          );
          sourceImageIds.push(
            await client.uploadImage(
              token,
              preparedImage.data,
              preparedImage.type,
              params.signal
            )
          );
        }
      }

      const output = await client.generateVideo({
        token,
        prompt: params.prompt,
        upstreamModel: conf.upstreamModel,
        upstreamModelId: conf.upstreamModelId,
        upstreamModelVersion: conf.upstreamModelVersion,
        engine: conf.engine,
        duration: conf.duration,
        aspectRatio: conf.aspectRatio,
        size,
        generateAudio: conf.generateAudio,
        ...(conf.referenceMode ? { referenceMode: conf.referenceMode } : {}),
        ...(params.negativePrompt != null
          ? { negativePrompt: params.negativePrompt }
          : {}),
        ...(sourceImageIds ? { sourceImageIds } : {}),
        signal: params.signal,
      });
      return {
        bytes: output.bytes,
        contentType: "video/mp4",
        raw: output.raw,
      };
    }
  );
  if (!result.ok) return result;
  return result.value;
}

/**
 * 校验一个 Adobe direct Cookie，并返回成员服务可持久化的一对一凭据。
 *
 * Cookie 和 token 只在服务端内存与成员配置中流转；失败时不写数据库。传入值可为
 * Cookie 字符串或导出扩展 JSON，实际持久化前由成员服务归一化为 Cookie 字符串。
 */
export async function prepareAdobeDirectCredential(
  cookie: string,
  scope?: string
): Promise<{
  accessToken: string;
  accountUserId: string | null;
  displayName: string | null;
  email: string | null;
  expiresAt: Date | null;
}> {
  const { apiTransport } = await buildAdobeTransports();
  const result = await refreshAccessTokenFromCookie(apiTransport, cookie, {
    scope,
    fetchAccount: true,
  });
  assertLoggedInAdobeCookie(result.accessToken, result.account);
  return {
    accessToken: result.accessToken,
    accountUserId: result.account?.userId || null,
    displayName: result.account?.displayName || null,
    email: result.account?.email || null,
    expiresAt: tokenExpiresAt(result.accessToken),
  };
}
