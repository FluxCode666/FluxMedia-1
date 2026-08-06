/**
 * Adobe Firefly 直连派发（mode=direct）：用本仓库移植的逆向逻辑
 * （@repo/shared/adobe/firefly-direct）直连 Adobe Firefly，经 Go TLS 旁路过风控，
 * 不依赖外部 adobe2api 进程。
 *
 * 职责：
 * - 一对一账号：每个 Adobe direct 顶层成员持有一个 Cookie；现行媒体请求统一使用
 *   Express Token，历史已接受任务仍可按持久 Profile 恢复。
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
  AdobeContentSafetyError,
  AdobeFireflyClient,
  type AdobeFireflyWebApp,
  AdobeVideoSubmissionUncertainError,
  AuthError,
  decodeJwtExp,
  decodeJwtPayload,
  type FireflyTransport,
  type FireflyTransportRequest,
  type FireflyTransportResponse,
  type FireflyVideoProviderModel,
  fetchCreditsBalance,
  fireflyVideoSize,
  isAdobeMemberSwitchableError,
  isTokenExpired,
  ProxyFireflyTransport,
  QuotaExhaustedError,
  refreshAccessTokenFromCookie,
  resolveFireflyImageModel,
  resolveFireflyVideoProviderModel,
} from "@repo/shared/adobe/firefly-direct";
import { logError, logWarn } from "@repo/shared/logger";
import {
  type VideoModelCapabilityDescriptor,
  validateVideoModelParameters,
  videoAspectRatioSchema,
  videoResolutionSchema,
} from "@repo/shared/video-generation";
import { and, eq, sql } from "drizzle-orm";
import {
  fetchMediaUpstreamDownload,
  MAX_IMAGE_UPSTREAM_DOWNLOAD_BYTES,
  MAX_VIDEO_UPSTREAM_DOWNLOAD_BYTES,
} from "@/features/image-backend-pool/media-upstream-fetch";
import { runAdobeBeforeAcceptanceWithAuthRetry } from "./adobe-auth-retry";
import { synchronizeAdobeCredentialHealthAfterRuntimeStatus } from "./adobe-credential-passive-health";
import {
  type AdobeVideoSourceInputs,
  prepareAndUploadAdobeVideoSourceInputs,
} from "./adobe-video-source";
import type { ApiConfig, GenerateImageResult } from "./types";
import { requireAcceptedVideoCredential } from "./video-recovery-policy";

// IMS access_token 距过期多久内视为需要刷新（秒）。
const TOKEN_REFRESH_SKEW_SECONDS = 120;

/** 将 Adobe 余额数值收敛为数据库可持久化的整数，非法值保留为空。 */
function normalizeAdobeCreditValue(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value)
    : null;
}

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

/**
 * 构造只用于 Adobe API 调用的专用代理 transport。
 *
 * @returns 复用生产 TLS 旁路与部署密钥的 transport。
 * @throws 专用代理配置缺失时显式失败；调用方不得降级为服务器直连。
 */
export async function buildAdobeDirectApiTransport(): Promise<FireflyTransport> {
  return (await buildAdobeTransports()).apiTransport;
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

type AdobeCredentialRecord = {
  cookie: string;
  scope: string | null;
  accountUserId: string | null;
  express: {
    value: string | null;
    status: string | null;
    expiresAt: Date | null;
  };
  firefly: {
    value: string | null;
    status: string | null;
    expiresAt: Date | null;
  };
};

/** 读取一个成员的两套网页 Profile 凭据；Cookie 和账号身份仍为成员级共享数据。 */
async function loadMemberCredential(
  memberId: string
): Promise<AdobeCredentialRecord | null> {
  const [credential] = await db
    .select({
      cookie: imageBackendMemberAdobeConfig.cookie,
      scope: imageBackendMemberAdobeConfig.scope,
      accountUserId: imageBackendMemberAdobeConfig.accountUserId,
      expressValue: imageBackendMemberAdobeConfig.accessToken,
      expressStatus: imageBackendMemberAdobeConfig.credentialStatus,
      expressExpiresAt: imageBackendMemberAdobeConfig.tokenExpiresAt,
      fireflyValue: imageBackendMemberAdobeConfig.fireflyAccessToken,
      fireflyStatus: imageBackendMemberAdobeConfig.fireflyCredentialStatus,
      fireflyExpiresAt: imageBackendMemberAdobeConfig.fireflyTokenExpiresAt,
    })
    .from(imageBackendMemberAdobeConfig)
    .where(
      and(
        eq(imageBackendMemberAdobeConfig.memberId, memberId),
        eq(imageBackendMemberAdobeConfig.mode, "direct")
      )
    )
    .limit(1);
  if (!credential?.cookie) return null;
  return {
    cookie: credential.cookie,
    scope: credential.scope,
    accountUserId: credential.accountUserId,
    express: {
      value: credential.expressValue,
      status: credential.expressStatus,
      expiresAt: credential.expressExpiresAt,
    },
    firefly: {
      value: credential.fireflyValue,
      status: credential.fireflyStatus,
      expiresAt: credential.fireflyExpiresAt,
    },
  };
}

/** 使用 direct 成员自己的 Cookie 刷新并回写指定网页 Profile 的短期凭据。 */
async function refreshMemberCredential(
  memberId: string,
  credential: {
    cookie: string;
    scope: string | null;
    accountUserId: string | null;
  },
  profile: AdobeCredentialProfile,
  transport: FireflyTransport,
  signal?: AbortSignal
): Promise<{ value: string } | null> {
  try {
    const result = await refreshAccessTokenFromCookie(
      transport,
      credential.cookie,
      {
        profile,
        ...(profile === "express" && credential.scope
          ? { scope: credential.scope }
          : {}),
        signal,
        fetchAccount: profile === "express",
      }
    );
    const refreshedAccountUserId = String(
      decodeJwtPayload(result.accessToken).user_id || ""
    ).trim();
    if (
      profile === "firefly" &&
      credential.accountUserId &&
      refreshedAccountUserId &&
      refreshedAccountUserId !== credential.accountUserId
    ) {
      throw new Error("Firefly Token 与成员 Adobe 账号不一致");
    }
    const now = new Date();
    const profileValues =
      profile === "express"
        ? {
            accessToken: result.accessToken,
            tokenExpiresAt: tokenExpiresAt(result.accessToken),
            credentialStatus: "active" as const,
            tokenFails: 0,
            lastRefreshAt: now,
            lastRefreshError: null,
            consecutiveFailures: 0,
          }
        : {
            fireflyAccessToken: result.accessToken,
            fireflyTokenExpiresAt: tokenExpiresAt(result.accessToken),
            fireflyCredentialStatus: "active" as const,
            fireflyTokenFails: 0,
            fireflyLastRefreshAt: now,
            fireflyLastRefreshError: null,
            fireflyConsecutiveFailures: 0,
          };
    const [persisted] = await db
      .update(imageBackendMemberAdobeConfig)
      .set({
        ...profileValues,
        ...(profile === "express" && result.account
          ? {
              displayName: result.account.displayName || null,
              email: result.account.email || null,
              accountUserId: result.account.userId || null,
            }
          : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(imageBackendMemberAdobeConfig.memberId, memberId),
          eq(imageBackendMemberAdobeConfig.cookie, credential.cookie)
        )
      )
      .returning({ memberId: imageBackendMemberAdobeConfig.memberId });
    if (!persisted) return null;
    if (profile === "express") {
      await storeMemberCredits(
        transport,
        memberId,
        result.accessToken,
        credential.cookie,
        signal
      ).catch((error) =>
        logError(error, { source: "adobe-credits-balance", memberId })
      );
    }
    return { value: result.accessToken };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failureValues =
      profile === "express"
        ? {
            credentialStatus: "error" as const,
            lastRefreshError: message.slice(0, 500),
            consecutiveFailures: sql`${imageBackendMemberAdobeConfig.consecutiveFailures} + 1`,
          }
        : {
            fireflyCredentialStatus: "error" as const,
            fireflyLastRefreshError: message.slice(0, 500),
            fireflyConsecutiveFailures: sql`${imageBackendMemberAdobeConfig.fireflyConsecutiveFailures} + 1`,
          };
    const persistedFailures = await db
      .update(imageBackendMemberAdobeConfig)
      .set({
        ...failureValues,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(imageBackendMemberAdobeConfig.memberId, memberId),
          eq(imageBackendMemberAdobeConfig.cookie, credential.cookie)
        )
      )
      .returning({ memberId: imageBackendMemberAdobeConfig.memberId });
    if (persistedFailures[0]) {
      await synchronizeAdobeCredentialHealthAfterRuntimeStatus({
        memberId,
        status: "error",
      });
    }
    logError(error, { source: "adobe-direct-refresh", memberId, profile });
    return null;
  }
}

type AdobeCredentialProfile = AdobeFireflyWebApp;

/** 强制刷新指定成员的指定 Profile，供明确 401/403 的一次性安全重试使用。 */
async function refreshMemberCredentialById(
  memberId: string,
  profile: AdobeCredentialProfile,
  transport: FireflyTransport,
  signal?: AbortSignal
): Promise<{ value: string } | null> {
  const credential = await loadMemberCredential(memberId);
  if (!credential) return null;
  return refreshMemberCredential(
    memberId,
    {
      cookie: credential.cookie,
      scope: credential.scope,
      accountUserId: credential.accountUserId,
    },
    profile,
    transport,
    signal
  );
}

// best-effort 拉取 Firefly 余额并写入成员配置；失败只记 creditsError，
// 不抛出（余额是运营展示用，不应影响刷新/生成主流程）。
async function storeMemberCredits(
  transport: FireflyTransport,
  memberId: string,
  accessToken: string,
  expectedCookie: string,
  signal?: AbortSignal
): Promise<void> {
  try {
    const balance = await fetchCreditsBalance(transport, accessToken, signal);
    await db
      .update(imageBackendMemberAdobeConfig)
      .set({
        creditsTotal: normalizeAdobeCreditValue(balance.total),
        creditsUsed: normalizeAdobeCreditValue(balance.used),
        creditsAvailable: normalizeAdobeCreditValue(balance.available),
        creditsUpdatedAt: new Date(),
        creditsError: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(imageBackendMemberAdobeConfig.memberId, memberId),
          eq(imageBackendMemberAdobeConfig.cookie, expectedCookie)
        )
      );
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
      .where(
        and(
          eq(imageBackendMemberAdobeConfig.memberId, memberId),
          eq(imageBackendMemberAdobeConfig.cookie, expectedCookie)
        )
      )
      .catch((persistError) =>
        logError(persistError, {
          source: "adobe-credits-balance-persist-error",
          memberId,
        })
      );
  }
}

/**
 * 读取 direct 成员指定 Profile 凭据；短期 Token 不可用时只刷新这个成员自己的 Cookie。
 */
async function acquireMemberCredential(
  memberId: string,
  profile: AdobeCredentialProfile,
  transport: FireflyTransport,
  signal?: AbortSignal
): Promise<{ value: string } | null> {
  const credential = await loadMemberCredential(memberId);
  if (!credential) return null;
  const selected = credential[profile];
  const expired = selected.expiresAt
    ? selected.expiresAt.getTime() - TOKEN_REFRESH_SKEW_SECONDS * 1000 <=
      Date.now()
    : selected.value
      ? isTokenExpired(selected.value, TOKEN_REFRESH_SKEW_SECONDS)
      : true;
  if (selected.status === "active" && selected.value && !expired) {
    return { value: selected.value };
  }
  return refreshMemberCredential(
    memberId,
    {
      cookie: credential.cookie,
      scope: credential.scope,
      accountUserId: credential.accountUserId,
    },
    profile,
    transport,
    signal
  );
}

/** 将成员指定 Profile 的短期凭据标记为不可用，由统一顶层调度切换成员。 */
async function markCredentialStatus(
  memberId: string,
  profile: AdobeCredentialProfile,
  status: "error" | "exhausted" | "invalid",
  expectedToken?: string
): Promise<void> {
  const values =
    profile === "express"
      ? {
          credentialStatus: status,
          tokenFails: sql`${imageBackendMemberAdobeConfig.tokenFails} + 1`,
        }
      : {
          fireflyCredentialStatus: status,
          fireflyTokenFails: sql`${imageBackendMemberAdobeConfig.fireflyTokenFails} + 1`,
        };
  const tokenColumn =
    profile === "express"
      ? imageBackendMemberAdobeConfig.accessToken
      : imageBackendMemberAdobeConfig.fireflyAccessToken;
  const persistedStatuses = await db
    .update(imageBackendMemberAdobeConfig)
    .set({
      ...values,
      updatedAt: new Date(),
    })
    .where(
      expectedToken
        ? and(
            eq(imageBackendMemberAdobeConfig.memberId, memberId),
            eq(tokenColumn, expectedToken)
          )
        : eq(imageBackendMemberAdobeConfig.memberId, memberId)
    )
    .returning({ memberId: imageBackendMemberAdobeConfig.memberId });
  if (persistedStatuses[0]) {
    await synchronizeAdobeCredentialHealthAfterRuntimeStatus({
      memberId,
      status,
    });
  }
}

/**
 * 使用一个 direct 顶层成员的指定 Profile 凭据执行一次调用。
 * 可切换错误直接交还统一调度器，禁止在成员内部再次选账号。
 */
async function runWithAdobeCredential<T>(
  memberId: string,
  profile: AdobeCredentialProfile,
  transport: FireflyTransport,
  signal: AbortSignal | undefined,
  retryAuthBeforeAcceptance: boolean,
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
  const acquired = await acquireMemberCredential(
    memberId,
    profile,
    transport,
    signal
  );
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
  const attempted = await runAdobeBeforeAcceptanceWithAuthRetry({
    token: acquired.value,
    retryEnabled: retryAuthBeforeAcceptance,
    ...(signal ? { signal } : {}),
    run,
    refresh: async () =>
      (await refreshMemberCredentialById(memberId, profile, transport, signal))
        ?.value ?? null,
  });
  if (attempted.ok) return attempted;
  {
    const failure = attempted.error;
    if (failure instanceof QuotaExhaustedError && !attempted.refreshFailed) {
      await markCredentialStatus(
        memberId,
        profile,
        "exhausted",
        attempted.rejectedToken
      ).catch((persistError) =>
        logError(persistError, {
          source: "adobe-direct-credential-status",
          memberId,
          profile,
        })
      );
    } else if (failure instanceof AuthError && !attempted.refreshFailed) {
      await markCredentialStatus(
        memberId,
        profile,
        "invalid",
        attempted.rejectedToken
      ).catch((persistError) =>
        logError(persistError, {
          source: "adobe-direct-credential-status",
          memberId,
          profile,
        })
      );
    }
    const diagnosticMessage =
      failure instanceof Error ? failure.message : "Adobe 直连生成失败";
    const userMessage =
      failure instanceof AdobeContentSafetyError
        ? failure.userMessage
        : diagnosticMessage;
    const upstreamAccepted = failure instanceof AdobeAcceptedVideoError;
    const submissionUncertain =
      failure instanceof AdobeVideoSubmissionUncertainError;
    const switchable =
      isAdobeMemberSwitchableError(failure) &&
      !signal?.aborted &&
      !upstreamAccepted;
    if (switchable) {
      logWarn("Adobe 直连成员失败，交由统一号池切换", {
        source: "adobe-direct-switch",
        memberId,
        profile,
        error: diagnosticMessage.slice(0, 160),
      });
    } else if (!(failure instanceof AdobeContentSafetyError)) {
      logError(failure, { source: "adobe-direct", memberId, profile });
    }
    return {
      ok: false,
      error: userMessage,
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
    "express",
    apiTransport,
    params.signal,
    false,
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
  if (!result.ok) {
    return {
      error: result.error,
      backendSwitchAllowed: result.switchable,
    };
  }
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
 * @param request 真实模型 ID 与任务独立参数。
 * @param requestProfile 创建时持久化的 Adobe 请求 Profile。
 * @returns 固定成员、模型配置与客户端；失败时返回可安全展示的错误。
 */
async function createAdobeVideoStageClient(
  config: ApiConfig,
  request: {
    model: string;
    duration: number;
    aspectRatio: string;
    resolution: string;
  },
  requestProfile: AdobeCredentialProfile
): Promise<
  | { ok: false; error: string }
  | {
      ok: true;
      memberId: string;
      provider: FireflyVideoProviderModel;
      capability: VideoModelCapabilityDescriptor;
      aspectRatio: ReturnType<typeof videoAspectRatioSchema.parse>;
      resolution: ReturnType<typeof videoResolutionSchema.parse>;
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
      requestedModel: request.model,
    })
  ) {
    return { ok: false, error: "此 Adobe 后端未开放所请求的模型" };
  }
  const validated = validateVideoModelParameters({
    model: request.model,
    duration: request.duration,
    aspectRatio: request.aspectRatio,
    resolution: request.resolution,
  });
  if (!validated.ok) {
    return {
      ok: false,
      error: `Adobe 直连视频参数无效: ${validated.error.field}`,
    };
  }
  const provider = resolveFireflyVideoProviderModel(
    validated.capability.modelId
  );
  if (!provider) {
    return {
      ok: false,
      error: `Adobe 直连不支持的视频模型: ${request.model}`,
    };
  }
  const aspectRatio = videoAspectRatioSchema.parse(request.aspectRatio);
  const resolution = videoResolutionSchema.parse(request.resolution);
  const size = fireflyVideoSize(resolution, aspectRatio);
  if (!size) {
    return { ok: false, error: "Adobe 直连视频尺寸无效" };
  }
  const transports = await buildAdobeTransports(
    MAX_VIDEO_UPSTREAM_DOWNLOAD_BYTES
  );
  return {
    ok: true,
    memberId,
    provider,
    capability: validated.capability,
    aspectRatio,
    resolution,
    size,
    apiTransport: transports.apiTransport,
    client: new AdobeFireflyClient({
      webApp: requestProfile,
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
    duration: number;
    aspectRatio: string;
    resolution: string;
    effectiveAudio: boolean;
    maxReferenceImages: number;
    negativePrompt?: string | null;
    requestProfile: AdobeCredentialProfile;
    authProfile: AdobeCredentialProfile;
    signal?: AbortSignal;
  } & AdobeVideoSourceInputs
): Promise<AdobeVideoSubmission | AdobeVideoStageError> {
  const prepared = await createAdobeVideoStageClient(
    config,
    {
      model: params.model,
      duration: params.duration,
      aspectRatio: params.aspectRatio,
      resolution: params.resolution,
    },
    params.requestProfile
  );
  if (!prepared.ok) {
    return {
      error: prepared.error,
      switchable: false,
      upstreamAccepted: false,
      terminal: true,
      submissionUncertain: false,
    };
  }
  if (params.effectiveAudio && !prepared.capability.audio.supported) {
    return {
      error: "该视频模型不支持音频开关",
      switchable: false,
      upstreamAccepted: false,
      terminal: true,
      submissionUncertain: false,
    };
  }
  if (
    !prepared.capability.input.referenceImages.configurable &&
    params.maxReferenceImages !==
      prepared.capability.input.referenceImages.maxCount
  ) {
    return {
      error: "视频任务的参考图能力快照无效",
      switchable: false,
      upstreamAccepted: false,
      terminal: true,
      submissionUncertain: false,
    };
  }

  const result = await runWithAdobeCredential(
    prepared.memberId,
    params.authProfile,
    prepared.apiTransport,
    params.signal,
    true,
    async (token) => {
      const sourceIds = await prepareAndUploadAdobeVideoSourceInputs({
        inputs: {
          ...(params.firstFrame ? { firstFrame: params.firstFrame } : {}),
          ...(params.lastFrame ? { lastFrame: params.lastFrame } : {}),
          ...(params.referenceImages?.length
            ? { referenceImages: params.referenceImages }
            : {}),
        },
        frameCapability: prepared.capability.input.frames,
        maxReferenceImages: params.maxReferenceImages,
        size: prepared.size,
        mode: prepared.provider.sourceImageMode,
        uploadImage: (data, type) =>
          prepared.client.uploadImage(token, data, type, params.signal),
      });
      const submitted = await prepared.client.submitVideo({
        token,
        prompt: params.prompt,
        model: prepared.capability.modelId,
        duration: params.duration,
        aspectRatio: prepared.aspectRatio,
        resolution: prepared.resolution,
        size: prepared.size,
        effectiveAudio: params.effectiveAudio,
        ...(params.negativePrompt != null
          ? { negativePrompt: params.negativePrompt }
          : {}),
        ...sourceIds,
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
 * 使用持久化的原成员及请求/鉴权 Profile 轮询一次已接受任务。
 *
 * 成员凭据不存在时 fail closed；绝不选择替代成员。
 */
export async function pollAdobeDirectVideoRequest(input: {
  memberId: string;
  pollUrl: string;
  model: string;
  requestProfile: AdobeCredentialProfile;
  authProfile: AdobeCredentialProfile;
  signal?: AbortSignal;
}): Promise<AdobeVideoPollResult> {
  if (!resolveFireflyVideoProviderModel(input.model)) {
    throw new AdobeAcceptedVideoError(
      `Adobe 视频恢复模型不受支持: ${input.model}`,
      { errorType: "status" }
    );
  }
  const credential = await loadMemberCredential(input.memberId);
  if (!credential) {
    throw new AdobeAcceptedVideoError("Adobe 视频恢复成员缺少凭据", {
      errorType: "status",
    });
  }
  const selected = credential[input.authProfile];
  const { apiTransport, downloadTransport } = await buildAdobeTransports();
  const client = new AdobeFireflyClient({
    webApp: input.requestProfile,
    transport: apiTransport,
    downloadTransport,
  });
  let tokenValue = selected.value;

  /** 只刷新持久化的原成员，绝不选择另一个顶层成员。 */
  const refreshOriginalMember = async (): Promise<string> => {
    const refreshed = await refreshMemberCredential(
      input.memberId,
      {
        cookie: credential.cookie,
        scope: credential.scope,
        accountUserId: credential.accountUserId,
      },
      input.authProfile,
      apiTransport,
      input.signal
    );
    tokenValue = requireAcceptedVideoCredential(refreshed);
    return tokenValue;
  };

  const expired = selected.expiresAt
    ? selected.expiresAt.getTime() - TOKEN_REFRESH_SKEW_SECONDS * 1000 <=
      Date.now()
    : tokenValue
      ? isTokenExpired(tokenValue, TOKEN_REFRESH_SKEW_SECONDS)
      : true;
  if (!tokenValue || selected.status !== "active" || expired) {
    await refreshOriginalMember();
  }

  const currentToken = (): string =>
    requireAcceptedVideoCredential(tokenValue ? { value: tokenValue } : null);

  try {
    return await client.pollVideo({
      token: currentToken(),
      pollUrl: input.pollUrl,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    if (
      error instanceof AdobeAcceptedVideoError &&
      (error.statusCode === 401 || error.statusCode === 403)
    ) {
      await refreshOriginalMember();
      try {
        return await client.pollVideo({
          token: currentToken(),
          pollUrl: input.pollUrl,
          ...(input.signal ? { signal: input.signal } : {}),
        });
      } catch (retryError) {
        if (
          retryError instanceof AdobeAcceptedVideoError &&
          (retryError.statusCode === 401 || retryError.statusCode === 403)
        ) {
          await markCredentialStatus(
            input.memberId,
            input.authProfile,
            "invalid",
            currentToken()
          ).catch((persistError) =>
            logError(persistError, {
              source: "adobe-video-poll-credential-status",
              memberId: input.memberId,
              profile: input.authProfile,
            })
          );
        }
        throw retryError;
      }
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
    duration: number;
    aspectRatio: string;
    resolution: string;
    effectiveAudio: boolean;
    maxReferenceImages: number;
    negativePrompt?: string | null;
    signal?: AbortSignal;
  } & AdobeVideoSourceInputs
): Promise<AdobeVideoResult> {
  const provider = resolveFireflyVideoProviderModel(params.model);
  if (!provider) {
    return {
      error: `Adobe 直连不支持的视频模型: ${params.model}`,
      switchable: false,
      upstreamAccepted: false,
      terminal: true,
    };
  }
  const prepared = await createAdobeVideoStageClient(
    config,
    {
      model: params.model,
      duration: params.duration,
      aspectRatio: params.aspectRatio,
      resolution: params.resolution,
    },
    provider.webApp
  );
  if (!prepared.ok) {
    return {
      error: prepared.error,
      switchable: false,
      upstreamAccepted: false,
      terminal: true,
    };
  }
  if (params.effectiveAudio && !prepared.capability.audio.supported) {
    return {
      error: "该视频模型不支持音频开关",
      switchable: false,
      upstreamAccepted: false,
      terminal: true,
    };
  }
  if (
    !prepared.capability.input.referenceImages.configurable &&
    params.maxReferenceImages !==
      prepared.capability.input.referenceImages.maxCount
  ) {
    return {
      error: "视频任务的参考图能力快照无效",
      switchable: false,
      upstreamAccepted: false,
      terminal: true,
    };
  }

  const result = await runWithAdobeCredential(
    prepared.memberId,
    prepared.provider.authProfile,
    prepared.apiTransport,
    params.signal,
    true,
    async (token) => {
      // 图生视频上传与提交必须使用同一次成员凭据，确保 Adobe image id 归属一致。
      const sourceIds = await prepareAndUploadAdobeVideoSourceInputs({
        inputs: {
          ...(params.firstFrame ? { firstFrame: params.firstFrame } : {}),
          ...(params.lastFrame ? { lastFrame: params.lastFrame } : {}),
          ...(params.referenceImages?.length
            ? { referenceImages: params.referenceImages }
            : {}),
        },
        frameCapability: prepared.capability.input.frames,
        maxReferenceImages: params.maxReferenceImages,
        size: prepared.size,
        mode: prepared.provider.sourceImageMode,
        uploadImage: (data, type) =>
          prepared.client.uploadImage(token, data, type, params.signal),
      });

      const output = await prepared.client.generateVideo({
        token,
        prompt: params.prompt,
        model: prepared.capability.modelId,
        duration: params.duration,
        aspectRatio: prepared.aspectRatio,
        resolution: prepared.resolution,
        size: prepared.size,
        effectiveAudio: params.effectiveAudio,
        ...(params.negativePrompt != null
          ? { negativePrompt: params.negativePrompt }
          : {}),
        ...sourceIds,
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
 * 校验一个 Adobe direct Cookie，并返回成员服务可持久化的一对一凭据与余额快照。
 *
 * Cookie 和 token 只在服务端内存与成员配置中流转；身份校验失败时不写数据库。
 * 余额读取为 best-effort，失败原因随凭据持久化供管理员排查，不阻断有效账号导入。
 * 传入值可为 Cookie 字符串或导出扩展 JSON，实际持久化前由成员服务归一化。
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
  creditsTotal: number | null;
  creditsUsed: number | null;
  creditsAvailable: number | null;
  creditsUpdatedAt: Date;
  creditsError: string | null;
}> {
  const { apiTransport } = await buildAdobeTransports();
  const result = await refreshAccessTokenFromCookie(apiTransport, cookie, {
    profile: "express",
    scope,
    fetchAccount: true,
  });
  assertLoggedInAdobeCookie(result.accessToken, result.account);
  let creditsTotal: number | null = null;
  let creditsUsed: number | null = null;
  let creditsAvailable: number | null = null;
  let creditsError: string | null = null;
  try {
    const balance = await fetchCreditsBalance(apiTransport, result.accessToken);
    creditsTotal = normalizeAdobeCreditValue(balance.total);
    creditsUsed = normalizeAdobeCreditValue(balance.used);
    creditsAvailable = normalizeAdobeCreditValue(balance.available);
  } catch (error) {
    creditsError = (
      error instanceof Error ? error.message : String(error)
    ).slice(0, 300);
  }
  const creditsUpdatedAt = new Date();
  return {
    accessToken: result.accessToken,
    accountUserId: result.account?.userId || null,
    displayName: result.account?.displayName || null,
    email: result.account?.email || null,
    expiresAt: tokenExpiresAt(result.accessToken),
    creditsTotal,
    creditsUsed,
    creditsAvailable,
    creditsUpdatedAt,
    creditsError,
  };
}
