/**
 * Adobe Firefly 直连派发（mode=direct）：用本仓库移植的逆向逻辑
 * （@repo/shared/adobe/firefly-direct）直连 Adobe Firefly，经 Go TLS 旁路过风控，
 * 不依赖外部 adobe2api 进程。
 *
 * 职责：
 * - 账号/token 池（adobe_account / adobe_token）：cookie → IMS access_token 刷新、
 *   token 轮换选取、失效/配额错误标记。
 * - 出图：选 token → 选模型族/尺寸 → 图生图先 uploadImage → generateImage → 返回 base64。
 */

import { db } from "@repo/database";
import { adobeAccount, adobeToken } from "@repo/database/schema";
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
  fetchAccountInfo,
  fetchCreditsBalance,
  fireflyVideoSize,
  isAdobeRotatableError,
  isTokenExpired,
  ProxyFireflyTransport,
  QuotaExhaustedError,
  refreshAccessTokenFromCookie,
  resolveFireflyImageModel,
  resolveFireflyVideoModel,
} from "@repo/shared/adobe/firefly-direct";
import { logError, logWarn } from "@repo/shared/logger";
import { and, asc, eq, sql } from "drizzle-orm";

import { nanoid } from "nanoid";
import {
  fetchMediaUpstreamDownload,
  MAX_IMAGE_UPSTREAM_DOWNLOAD_BYTES,
  MAX_VIDEO_UPSTREAM_DOWNLOAD_BYTES,
} from "@/features/image-backend-pool/media-upstream-fetch";
import { parseAdobeCookieEntries } from "./adobe-cookie-parser";
import type { ApiConfig, GenerateImageResult } from "./types";
import { requireOriginalAcceptedVideoToken } from "./video-recovery-policy";

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
      "Cookie 对应 Firefly 访客会话（GuestID），不是已登录 Adobe 账号。请在已登录 firefly.adobe.com 的标签页用 tools/adobe-cookie-exporter 重新导出（需含 HttpOnly 会话 cookie，例如 aux_sid）。"
    );
  }
  if (!account?.userId && !account?.email && !account?.displayName) {
    throw new Error(
      "Cookie 能刷新 token，但读不到 Adobe 账号信息。请确认浏览器已登录 Adobe ID，并用 cookie 导出扩展重新导出完整 cookie。"
    );
  }
}

/**
 * 用某账号的 cookie 刷新出 access_token，并 upsert 到 adobe_token（一个账号一行
 * auto_refresh token）。同时回写账号信息/状态。
 */
async function refreshAccountToken(
  memberId: string,
  account: { id: string; cookie: string; scope: string | null },
  transport: FireflyTransport,
  signal?: AbortSignal
): Promise<{ id: string; value: string } | null> {
  try {
    const result = await refreshAccessTokenFromCookie(
      transport,
      account.cookie,
      {
        scope: account.scope ?? undefined,
        signal,
        fetchAccount: true,
      }
    );
    const now = new Date();
    const accountUserId = result.account?.userId || "";

    await db
      .update(adobeAccount)
      .set({
        status: "active",
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
      .where(eq(adobeAccount.id, account.id));

    // 该账号已有的 auto_refresh token？有则更新，无则插入。
    const existing = await db
      .select({ id: adobeToken.id })
      .from(adobeToken)
      .where(
        and(
          eq(adobeToken.accountId, account.id),
          eq(adobeToken.source, "auto_refresh")
        )
      )
      .limit(1);

    const expiresAt = tokenExpiresAt(result.accessToken);
    let tokenId: string;
    if (existing[0]) {
      await db
        .update(adobeToken)
        .set({
          value: result.accessToken,
          accountUserId: accountUserId || null,
          status: "active",
          fails: 0,
          expiresAt,
          updatedAt: now,
        })
        .where(eq(adobeToken.id, existing[0].id));
      tokenId = existing[0].id;
    } else {
      tokenId = nanoid();
      await db.insert(adobeToken).values({
        id: tokenId,
        memberId,
        accountId: account.id,
        value: result.accessToken,
        accountUserId: accountUserId || null,
        status: "active",
        source: "auto_refresh",
        expiresAt,
      });
    }
    // best-effort 拉 Firefly 余额写入 token（失败不影响刷新结果）。
    await storeTokenCredits(
      transport,
      tokenId,
      result.accessToken,
      signal
    ).catch((error) =>
      logError(error, { source: "adobe-credits-balance", memberId })
    );
    return { id: tokenId, value: result.accessToken };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(adobeAccount)
      .set({
        status: "error",
        lastRefreshError: message.slice(0, 500),
        consecutiveFailures: sql`${adobeAccount.consecutiveFailures} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(adobeAccount.id, account.id));
    logError(error, { source: "adobe-direct-refresh", memberId });
    return null;
  }
}

// best-effort 拉取 Firefly 余额并写入 adobe_token 的 credits 列；失败只记 creditsError,
// 不抛出（余额是运营展示用，不应影响刷新/生成主流程）。
async function storeTokenCredits(
  transport: FireflyTransport,
  tokenId: string,
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
      .update(adobeToken)
      .set({
        creditsTotal: toInt(balance.total),
        creditsUsed: toInt(balance.used),
        creditsAvailable: toInt(balance.available),
        creditsUpdatedAt: new Date(),
        creditsError: null,
        updatedAt: new Date(),
      })
      .where(eq(adobeToken.id, tokenId));
  } catch (error) {
    await db
      .update(adobeToken)
      .set({
        creditsError: (error instanceof Error
          ? error.message
          : String(error)
        ).slice(0, 300),
        creditsUpdatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(adobeToken.id, tokenId))
      .catch(() => {});
  }
}

/**
 * 为某 adobe 后端取一个可用 access_token：
 * 1. 现有 active 且未过期的 token → 轮换选取（lastUsedAt 最旧优先）。
 * 2. 否则用某个 enabled 账号的 cookie 刷新出新 token。
 */
async function acquireToken(
  memberId: string,
  transport: FireflyTransport,
  signal?: AbortSignal,
  // 换号重试用：跳过本次已试过的 token / 账号（被 429 等限流的账号本次不再重选）。
  exclude?: { tokenIds?: Set<string>; accountIds?: Set<string> }
): Promise<{ id: string; value: string; accountId: string | null } | null> {
  const candidates = await db
    .select({
      id: adobeToken.id,
      value: adobeToken.value,
      expiresAt: adobeToken.expiresAt,
      accountId: adobeToken.accountId,
    })
    .from(adobeToken)
    .where(
      and(eq(adobeToken.memberId, memberId), eq(adobeToken.status, "active"))
    )
    .orderBy(asc(adobeToken.lastUsedAt), asc(adobeToken.createdAt));

  for (const candidate of candidates) {
    if (exclude?.tokenIds?.has(candidate.id)) continue;
    if (candidate.accountId && exclude?.accountIds?.has(candidate.accountId)) {
      continue;
    }
    const expired = candidate.expiresAt
      ? candidate.expiresAt.getTime() - TOKEN_REFRESH_SKEW_SECONDS * 1000 <=
        Date.now()
      : isTokenExpired(candidate.value, TOKEN_REFRESH_SKEW_SECONDS);
    if (expired) continue;
    await db
      .update(adobeToken)
      .set({ lastUsedAt: new Date() })
      .where(eq(adobeToken.id, candidate.id));
    return {
      id: candidate.id,
      value: candidate.value,
      accountId: candidate.accountId,
    };
  }

  // 没有可用 token：用一个 enabled 账号刷新（同样跳过本次已试过的账号）。
  const accounts = await db
    .select({
      id: adobeAccount.id,
      cookie: adobeAccount.cookie,
      scope: adobeAccount.scope,
    })
    .from(adobeAccount)
    .where(
      and(eq(adobeAccount.memberId, memberId), eq(adobeAccount.isEnabled, true))
    )
    .orderBy(asc(adobeAccount.lastRefreshAt), asc(adobeAccount.createdAt));

  for (const account of accounts) {
    if (exclude?.accountIds?.has(account.id)) continue;
    const refreshed = await refreshAccountToken(
      memberId,
      account,
      transport,
      signal
    );
    if (refreshed) {
      await db
        .update(adobeToken)
        .set({ lastUsedAt: new Date() })
        .where(eq(adobeToken.id, refreshed.id));
      return {
        id: refreshed.id,
        value: refreshed.value,
        accountId: account.id,
      };
    }
  }
  return null;
}

async function markTokenStatus(
  tokenId: string,
  status: "error" | "exhausted" | "invalid"
): Promise<void> {
  await db
    .update(adobeToken)
    .set({
      status,
      fails: sql`${adobeToken.fails} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(adobeToken.id, tokenId));
}

// 单个 Adobe 后端（伪账号）内换号重试的账号数上限。实际收口由「本后端可用账号数」与
// 「整单 signal（20 分钟）」共同决定；此常数仅作防御性兜底，避免账号池极大时空转过久。
const MAX_ADOBE_TOKEN_ROTATION = 24;

/**
 * 在一个 Adobe 后端（伪账号）内带 token/账号轮换地执行一次直连调用。
 * - 每次取一个本次未试过的可用账号 token，执行 run（用该 token 完成上传+生成）；
 * - 遇「可轮换错误」（429/5xx 上游临时、配额耗尽、鉴权失效）就标记当前 token、把该
 *   token+账号本次排除，换下一个账号重试；
 * - 直到成功、本后端内已无更多可用账号、或 signal 取消。
 * WHY：池层换号是「整个 Adobe 后端」粒度——一旦本后端被排除就轮到下一个后端。故必须先在
 * 本后端内把所有可用账号都试完（重试完毕）才返回错误上抛，才能满足
 * 「伪账号内部重试完毕 → 再由外层切换其它 Adobe 后端继续轮换」的两级语义。
 * 非可轮换错误（请求本身 4xx、内容拒绝、模型不支持等）换号无用，立即上抛。
 */
async function runWithAdobeTokenRotation<T>(
  memberId: string,
  transport: FireflyTransport,
  signal: AbortSignal | undefined,
  run: (token: string, tokenId: string) => Promise<T>
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
  const triedTokenIds = new Set<string>();
  const triedAccountIds = new Set<string>();
  let lastError =
    "Adobe 直连无可用账号/token（请在 admin 导入 Adobe cookie 账号）";
  for (let attempt = 1; attempt <= MAX_ADOBE_TOKEN_ROTATION; attempt++) {
    if (signal?.aborted) break;
    const acquired = await acquireToken(memberId, transport, signal, {
      tokenIds: triedTokenIds,
      accountIds: triedAccountIds,
    });
    if (!acquired) break; // 本后端内已无更多未试过的可用账号
    triedTokenIds.add(acquired.id);
    if (acquired.accountId) triedAccountIds.add(acquired.accountId);
    try {
      return {
        ok: true,
        value: await run(acquired.value, acquired.id),
      };
    } catch (error) {
      // 配额耗尽/鉴权失效是持久态，落库标记便于后续请求跳过；429 等临时态不改 token 状态，
      // 仅本次排除（lastUsedAt 已更新，下次自然排到队尾）。
      if (error instanceof QuotaExhaustedError) {
        await markTokenStatus(acquired.id, "exhausted").catch(() => {});
      } else if (error instanceof AuthError) {
        await markTokenStatus(acquired.id, "invalid").catch(() => {});
      }
      lastError = error instanceof Error ? error.message : "Adobe 直连生成失败";
      if (isAdobeRotatableError(error) && !signal?.aborted) {
        logWarn("Adobe 直连账号失败，换下一个账号重试", {
          source: "adobe-direct-rotate",
          memberId,
          attempt,
          triedAccounts: triedAccountIds.size,
          error: lastError.slice(0, 160),
        });
        continue;
      }
      logError(error, { source: "adobe-direct-rotate", memberId, attempt });
      const upstreamAccepted = error instanceof AdobeAcceptedVideoError;
      const submissionUncertain =
        error instanceof AdobeVideoSubmissionUncertainError;
      return {
        ok: false,
        error: lastError,
        switchable: false,
        upstreamAccepted,
        terminal: !upstreamAccepted && !submissionUncertain,
        submissionUncertain,
      };
    }
  }
  return {
    ok: false,
    error: lastError,
    switchable: !signal?.aborted,
    upstreamAccepted: false,
    terminal: Boolean(signal?.aborted),
    submissionUncertain: false,
  };
}

/**
 * mode=direct 的 adobe 派发：选 token → 选模型族/尺寸 → 图生图先上传 → generateImage。
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

  // 模型族 + 宽高比/分辨率（与 token 无关，放轮换外只算一次）：family 优先取请求 model
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

  // 伪账号内换号重试：撞 429/配额/鉴权就换本后端下一个账号，轮完才上抛（交外层切后端）。
  const result = await runWithAdobeTokenRotation(
    memberId,
    apiTransport,
    params.signal,
    async (token) => {
      // 图生图：先上传输入图拿 Adobe image id（与 token 绑定，故放轮换内、每次换号重传）。
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
  tokenId: string;
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
 * 只有明确未接受的账号级错误会在当前成员内换 token；提交响应不确定时立即停止，
 * 防止向同一成员或其他成员重投并重复消耗上游额度。
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

  const result = await runWithAdobeTokenRotation(
    prepared.memberId,
    prepared.apiTransport,
    params.signal,
    async (token, tokenId) => {
      let sourceImageIds: string[] | undefined;
      if (params.inputImages && params.inputImages.length > 0) {
        sourceImageIds = [];
        for (const image of params.inputImages) {
          sourceImageIds.push(
            await prepared.client.uploadImage(
              token,
              image.data,
              image.type || "image/png",
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
        tokenId,
        ...submitted,
      };
    }
  );
  return result.ok ? result.value : result;
}

/**
 * 使用持久化的原成员和原 token 轮询一次已接受任务。
 *
 * token 不存在或不属于该成员时 fail closed；绝不选择替代 token。
 */
export async function pollAdobeDirectVideoRequest(input: {
  memberId: string;
  tokenId: string;
  pollUrl: string;
  signal?: AbortSignal;
}): Promise<AdobeVideoPollResult> {
  const [token] = await db
    .select({
      value: adobeToken.value,
      memberId: adobeToken.memberId,
      accountId: adobeToken.accountId,
      expiresAt: adobeToken.expiresAt,
      source: adobeToken.source,
    })
    .from(adobeToken)
    .where(
      and(
        eq(adobeToken.id, input.tokenId),
        eq(adobeToken.memberId, input.memberId)
      )
    )
    .limit(1);
  if (!token || token.memberId !== input.memberId) {
    throw new AdobeAcceptedVideoError("Adobe 视频恢复 token 与原成员不匹配", {
      errorType: "status",
    });
  }
  const { apiTransport, downloadTransport } = await buildAdobeTransports();
  const client = new AdobeFireflyClient({
    transport: apiTransport,
    downloadTransport,
  });
  let tokenValue = token.value;

  /** 只刷新原 token 绑定的原账号，绝不选择另一个账号或 token。 */
  const refreshOriginalToken = async (): Promise<string> => {
    if (!token.accountId || token.source !== "auto_refresh") {
      throw new AdobeAcceptedVideoError(
        "Adobe 视频恢复 token 无法由原账号刷新，任务将保留重试",
        { errorType: "network" }
      );
    }
    const [account] = await db
      .select({
        id: adobeAccount.id,
        cookie: adobeAccount.cookie,
        scope: adobeAccount.scope,
      })
      .from(adobeAccount)
      .where(
        and(
          eq(adobeAccount.id, token.accountId),
          eq(adobeAccount.memberId, input.memberId),
          eq(adobeAccount.isEnabled, true)
        )
      )
      .limit(1);
    const refreshed = account
      ? await refreshAccountToken(
          input.memberId,
          account,
          apiTransport,
          input.signal
        )
      : null;
    tokenValue = requireOriginalAcceptedVideoToken({
      tokenId: input.tokenId,
      refreshed,
    });
    return tokenValue;
  };

  const expired = token.expiresAt
    ? token.expiresAt.getTime() - TOKEN_REFRESH_SKEW_SECONDS * 1000 <=
      Date.now()
    : isTokenExpired(token.value, TOKEN_REFRESH_SKEW_SECONDS);
  if (expired) await refreshOriginalToken();

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
      await refreshOriginalToken();
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
 * mode=direct 的 adobe 视频派发：解析视频模型 → 选 token → 图生视频先上传输入图 →
 * generateVideo（submit→轮询→下载）→ 返回视频字节。产物持久化（video_generation 落库、
 * re-host、扣费）由调用方完成。出错返回 { error }，token 级错误标记 token 状态便于轮换。
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

  // 伪账号内换号重试：撞 429/配额/鉴权就换本后端下一个账号，轮完才上抛（交外层切后端）。
  const result = await runWithAdobeTokenRotation(
    memberId,
    apiTransport,
    params.signal,
    async (token) => {
      // 图生视频：先上传输入图拿 id（与 token 绑定，故放轮换内、每次换号重传）。
      let sourceImageIds: string[] | undefined;
      if (params.inputImages && params.inputImages.length > 0) {
        sourceImageIds = [];
        for (const image of params.inputImages) {
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

      const output = await client.generateVideo({
        token,
        prompt: params.prompt,
        upstreamModel: conf.upstreamModel,
        upstreamModelId: conf.upstreamModelId,
        upstreamModelVersion: conf.upstreamModelVersion,
        engine: conf.engine,
        duration: conf.duration,
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
 * 供 admin 调用：导入一个 Adobe cookie 账号并立即刷新一次（验证 cookie 有效）。
 * 返回账号信息或抛错。
 */
type AdobeCookieValidation = Awaited<
  ReturnType<typeof refreshAccessTokenFromCookie>
>;

// 验证一个 Adobe cookie：刷新一次拿 access_token + 账号信息，并断言为已登录（非 guest）。
async function validateAdobeCookie(
  cookie: string,
  scope?: string | null
): Promise<AdobeCookieValidation> {
  const { apiTransport } = await buildAdobeTransports();
  const result = await refreshAccessTokenFromCookie(apiTransport, cookie, {
    scope: scope ?? undefined,
    fetchAccount: true,
  });
  assertLoggedInAdobeCookie(result.accessToken, result.account);
  return result;
}

// 持久化一个已验证的 Adobe 账号：写 adobeAccount + 初始 auto_refresh adobeToken。
// 额外回传 accountUserId（IMS 稳定身份），供批量导入去重使用。
async function persistAdobeAccount(
  input: {
    memberId: string;
    name?: string;
    cookie: string;
    scope?: string | null;
  },
  validated: AdobeCookieValidation
): Promise<{
  id: string;
  displayName: string;
  email: string;
  accountUserId: string | null;
}> {
  const id = nanoid();
  const account = validated.account;
  const now = new Date();

  await db.insert(adobeAccount).values({
    id,
    memberId: input.memberId,
    name: input.name?.trim() || account?.displayName || account?.email || id,
    cookie: input.cookie,
    scope: input.scope ?? null,
    isEnabled: true,
    displayName: account?.displayName || null,
    email: account?.email || null,
    accountUserId: account?.userId || null,
    status: "active",
    lastRefreshAt: now,
  });

  await db.insert(adobeToken).values({
    id: nanoid(),
    memberId: input.memberId,
    accountId: id,
    value: validated.accessToken,
    accountUserId: account?.userId || null,
    status: "active",
    source: "auto_refresh",
    expiresAt: tokenExpiresAt(validated.accessToken),
  });

  return {
    id,
    displayName: account?.displayName || "",
    email: account?.email || "",
    accountUserId: account?.userId || null,
  };
}

export async function importAdobeAccount(input: {
  memberId: string;
  name?: string;
  cookie: string;
  scope?: string | null;
}): Promise<{ id: string; displayName: string; email: string }> {
  const validated = await validateAdobeCookie(input.cookie, input.scope);
  const { id, displayName, email } = await persistAdobeAccount(
    input,
    validated
  );
  return { id, displayName, email };
}

export type AdobeAccountImportOutcome = {
  index: number;
  status: "imported" | "skipped" | "failed";
  accountId?: string;
  displayName?: string;
  email?: string;
  reason?: string;
};

export type AdobeAccountBatchImportResult = {
  total: number;
  imported: number;
  skipped: number;
  failed: number;
  results: AdobeAccountImportOutcome[];
  firstError?: string;
};

/**
 * 供 admin 调用：在某个 Adobe 后端（伪账号）下批量导入真实 Adobe 账号。
 * - 解析 cookie 文本（每行一个 / JSON 数组，见 adobe-cookie-parser）。
 * - 逐条刷新验证（best-effort）：单条失败不影响其余，逐条回报原因。
 * - 去重：同一 Adobe 用户（accountUserId，IMS 稳定身份；cookie 会轮换）或同邮箱已存在则
 *   跳过——既防重复粘贴，也防同一批内重复。
 * 串行执行：避免对 Adobe IMS 造成突发压力，并保证去重集一致。每条成功即落库（非单一大
 * 事务），因此即便整体请求中途超时也不丢已导入数据，重新粘贴会按身份自动跳过已导入项。
 */
export async function importAdobeAccountsBatch(input: {
  memberId: string;
  cookiesText: string;
  namePrefix?: string;
  scope?: string | null;
}): Promise<AdobeAccountBatchImportResult> {
  const entries = parseAdobeCookieEntries(input.cookiesText);
  if (entries.length === 0) {
    return { total: 0, imported: 0, skipped: 0, failed: 0, results: [] };
  }

  // 预取该后端已存在账号的稳定身份，用于跨次/批内去重。
  const existing = await db
    .select({
      accountUserId: adobeAccount.accountUserId,
      email: adobeAccount.email,
    })
    .from(adobeAccount)
    .where(eq(adobeAccount.memberId, input.memberId));
  const seenUserIds = new Set<string>();
  const seenEmails = new Set<string>();
  for (const row of existing) {
    if (row.accountUserId) seenUserIds.add(row.accountUserId);
    if (row.email) seenEmails.add(row.email.toLowerCase());
  }

  const results: AdobeAccountImportOutcome[] = [];
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  let firstError: string | undefined;

  for (const [index, entry] of entries.entries()) {
    const scope = entry.scope ?? input.scope ?? null;
    const fallbackName = input.namePrefix?.trim()
      ? `${input.namePrefix.trim()}-${index + 1}`
      : undefined;
    const name = entry.name?.trim() || fallbackName;
    try {
      const validated = await validateAdobeCookie(entry.cookie, scope);
      const userId = validated.account?.userId || null;
      const email = validated.account?.email?.toLowerCase() || null;
      if (
        (userId && seenUserIds.has(userId)) ||
        (email && seenEmails.has(email))
      ) {
        skipped++;
        results.push({
          index,
          status: "skipped",
          reason: "已存在相同 Adobe 账号，已跳过",
          displayName: validated.account?.displayName || undefined,
          email: validated.account?.email || undefined,
        });
        continue;
      }
      const persisted = await persistAdobeAccount(
        { memberId: input.memberId, name, cookie: entry.cookie, scope },
        validated
      );
      if (userId) seenUserIds.add(userId);
      if (email) seenEmails.add(email);
      imported++;
      results.push({
        index,
        status: "imported",
        accountId: persisted.id,
        displayName: persisted.displayName || undefined,
        email: persisted.email || undefined,
      });
    } catch (error) {
      failed++;
      const reason = error instanceof Error ? error.message : "导入失败";
      if (!firstError) firstError = reason;
      results.push({ index, status: "failed", reason });
      logError(error, {
        source: "adobe-direct-batch-import",
        memberId: input.memberId,
        index,
      });
    }
  }

  return {
    total: entries.length,
    imported,
    skipped,
    failed,
    results,
    ...(firstError ? { firstError } : {}),
  };
}

/** 列出某 Adobe direct 成员的账号（admin 用）。不返回 cookie 明文。 */
export async function listAdobeAccounts(memberId: string): Promise<
  Array<{
    id: string;
    name: string;
    displayName: string | null;
    email: string | null;
    isEnabled: boolean;
    status: string;
    lastRefreshAt: Date | null;
    lastRefreshError: string | null;
    consecutiveFailures: number;
    creditsTotal: number | null;
    creditsUsed: number | null;
    creditsAvailable: number | null;
    creditsUpdatedAt: Date | null;
    creditsError: string | null;
  }>
> {
  // 左连账号的 auto_refresh token，带出最新的 Firefly 余额（运营展示）。
  return db
    .select({
      id: adobeAccount.id,
      name: adobeAccount.name,
      displayName: adobeAccount.displayName,
      email: adobeAccount.email,
      isEnabled: adobeAccount.isEnabled,
      status: adobeAccount.status,
      lastRefreshAt: adobeAccount.lastRefreshAt,
      lastRefreshError: adobeAccount.lastRefreshError,
      consecutiveFailures: adobeAccount.consecutiveFailures,
      creditsTotal: adobeToken.creditsTotal,
      creditsUsed: adobeToken.creditsUsed,
      creditsAvailable: adobeToken.creditsAvailable,
      creditsUpdatedAt: adobeToken.creditsUpdatedAt,
      creditsError: adobeToken.creditsError,
    })
    .from(adobeAccount)
    .leftJoin(
      adobeToken,
      and(
        eq(adobeToken.accountId, adobeAccount.id),
        eq(adobeToken.source, "auto_refresh")
      )
    )
    .where(eq(adobeAccount.memberId, memberId))
    .orderBy(asc(adobeAccount.createdAt));
}

/** 删除一个 Adobe 账号（其 token 经 FK cascade 一并删除）。 */
export async function deleteAdobeAccount(id: string): Promise<void> {
  await db.delete(adobeAccount).where(eq(adobeAccount.id, id));
}

/** 启用/停用一个 Adobe 账号。停用即不再参与刷新/出图。 */
export async function setAdobeAccountEnabled(
  id: string,
  isEnabled: boolean
): Promise<void> {
  await db
    .update(adobeAccount)
    .set({
      isEnabled,
      ...(isEnabled
        ? { status: "active", lastRefreshError: null, consecutiveFailures: 0 }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(adobeAccount.id, id));
}

export { fetchAccountInfo };
