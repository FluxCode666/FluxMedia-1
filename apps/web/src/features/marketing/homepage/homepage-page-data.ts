/**
 * 官网首页服务端数据装配器。
 *
 * 使用方：首页 Server Component。关键依赖以四个首阶段 loader 并行读取，并在确认
 * 登录用户后才读取角色；所有结果在离开本模块前收窄为公开、可序列化 DTO。
 */
import "server-only";

import { getUserRoleById } from "@repo/shared/auth/role-server";
import { isAdminRole } from "@repo/shared/auth/roles";
import { getServerSession } from "@repo/shared/auth/server";
import { logger } from "@repo/shared/logger";
import {
  invokeOperation,
  OperationError,
  type OperationErrorCode,
} from "@repo/shared/uol";
import type {
  HomepageGenerationSlaStatsOutput,
  HomepageSlaVisibilityOutput,
  PlatformModelCatalogOutput,
} from "@repo/shared/uol/operations";

import { ensureUolInitialized } from "@/server/uol-init";

/** 首页可公开的单个模型字段。 */
export type HomepageModelItem = { id: string };

/** 模型目录成功空值与依赖失败保持不同状态。 */
export type HomepageModelCatalogState =
  | {
      status: "ready";
      image: HomepageModelItem[];
      video: HomepageModelItem[];
      conversation: HomepageModelItem[];
    }
  | { status: "unavailable" };

/** 首页可靠性区允许公开的统计字段。 */
export type HomepageSlaStats = HomepageGenerationSlaStatsOutput;

/** SLA 统计显式区分可展示、样本不足和读取失败。 */
export type HomepageSlaStatsState =
  | { status: "ready"; data: HomepageSlaStats }
  | { status: "insufficient" }
  | { status: "unavailable" };

/** 首页可靠性由独立的展示配置和统计事实组成。 */
export type HomepageReliabilityState = {
  visibility: "enabled" | "disabled" | "unavailable";
  stats: HomepageSlaStatsState;
};

/** 首页 Server Component 可直接消费的最小公开数据。 */
export type HomepagePageData = {
  catalog: HomepageModelCatalogState;
  reliability: HomepageReliabilityState;
  ctaHref: "/dashboard/generate" | "/sign-up";
  canToggleSlaStatus: boolean;
};

/** 首页依赖失败允许记录的稳定区块名。 */
export type HomepageFailureSection =
  | "model_catalog"
  | "sla_visibility"
  | "sla_stats"
  | "session"
  | "role";

/** 日志边界只接受固定字段，不携带原始异常或其文本。 */
export type HomepageFailureEvent = {
  event: "homepage_dependency_unavailable";
  section: HomepageFailureSection;
  requestId: string;
  safeCode: OperationErrorCode | "dependency_error" | "invalid_payload";
  retryable: boolean;
};

/** 可注入 loader；测试可控制顺序和失败，生产默认值保持接口层边界。 */
export type HomepagePageDataLoaders = {
  createRequestId: () => string;
  loadCatalog: (requestId: string) => Promise<unknown>;
  loadSlaVisibility: (requestId: string) => Promise<unknown>;
  loadSlaStats: (requestId: string) => Promise<unknown>;
  loadSession: () => Promise<unknown>;
  loadRole: (userId: string) => Promise<unknown>;
  reportFailure: (event: HomepageFailureEvent) => void;
};

const RETRYABLE_OPERATION_CODES = new Set<OperationErrorCode>([
  "not_ready",
  "rate_limited",
  "timeout",
  "upstream_error",
]);

/** 判断未知值是否为可安全读取字段的普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 把单个模型收窄为只含 ID 的公开 DTO。 */
function parseModelItems(value: unknown): HomepageModelItem[] | null {
  if (!Array.isArray(value)) return null;
  const items: HomepageModelItem[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== "string") return null;
    const id = item.id.trim();
    if (!id || id.length > 120) return null;
    items.push({ id });
  }
  return items;
}

/** 把 UOL 或注入结果再次收窄为三类公开目录，丢弃所有额外字段。 */
function parseCatalog(value: unknown): HomepageModelCatalogState | null {
  if (!isRecord(value)) return null;
  const image = parseModelItems(value.image);
  const video = parseModelItems(value.video);
  const conversation = parseModelItems(value.conversation);
  if (!image || !video || !conversation) return null;
  return { status: "ready", image, video, conversation };
}

/** 判断统计计数是否为有限非负整数。 */
function isCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  );
}

/** 把统计服务结果收窄为公开数字，并把零样本表达为样本不足。 */
function parseSlaStats(value: unknown): HomepageSlaStatsState | null {
  if (!isRecord(value)) return null;
  const {
    sampleSize,
    completed,
    failed,
    successRate,
    platformErrors,
    moderationErrors,
    userRequestErrors,
  } = value;
  if (
    !isCount(sampleSize) ||
    !isCount(completed) ||
    !isCount(failed) ||
    !isCount(platformErrors) ||
    !isCount(moderationErrors) ||
    !isCount(userRequestErrors) ||
    typeof successRate !== "number" ||
    !Number.isFinite(successRate) ||
    successRate < 0 ||
    successRate > 1
  ) {
    return null;
  }
  if (sampleSize === 0 || completed + platformErrors === 0) {
    return { status: "insufficient" };
  }
  return {
    status: "ready",
    data: {
      sampleSize,
      completed,
      failed,
      successRate,
      platformErrors,
      moderationErrors,
      userRequestErrors,
    },
  };
}

/** 从未知会话中只提取非空 userId，其他会话字段不会离开本函数。 */
function parseSessionUserId(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.user)) return null;
  if (typeof value.user.id !== "string") return null;
  const userId = value.user.id.trim();
  return userId || null;
}

/** 将未知失败压缩为固定错误码和可重试标志，不读取 message、stack 或 details。 */
function toSafeFailure(
  section: HomepageFailureSection,
  requestId: string,
  error: unknown
): HomepageFailureEvent {
  const safeCode =
    error instanceof OperationError ? error.code : "dependency_error";
  return {
    event: "homepage_dependency_unavailable",
    section,
    requestId,
    safeCode,
    retryable:
      error instanceof OperationError &&
      RETRYABLE_OPERATION_CODES.has(error.code),
  };
}

/** 构造不涉及原始异常的无效载荷日志事件。 */
function toInvalidPayloadFailure(
  section: HomepageFailureSection,
  requestId: string
): HomepageFailureEvent {
  return {
    event: "homepage_dependency_unavailable",
    section,
    requestId,
    safeCode: "invalid_payload",
    retryable: false,
  };
}

/** 生产日志仅接收稳定事件字段，绝不调用会序列化原始 Error 的辅助方法。 */
function reportHomepageFailure(event: HomepageFailureEvent): void {
  logger.error(event, "Homepage dependency unavailable");
}

/** 通过 system-only UOL operation 读取运行时模型目录。 */
async function loadCatalogThroughUol(
  requestId: string
): Promise<PlatformModelCatalogOutput> {
  await ensureUolInitialized();
  return invokeOperation<PlatformModelCatalogOutput>(
    "externalApi.getPlatformModelCatalog",
    {},
    { type: "system", reason: "homepage-platform-model-catalog" },
    { requestId }
  );
}

/**
 * 通过 system-only UOL operation 读取首页 SLA 展示开关。
 *
 * @param requestId - 当前首页请求的关联 ID，原样传入 UOL 网关用于审计关联。
 * @returns 严格输出 DTO 中的布尔开关，不向页面暴露 operation 内部字段。
 * @sideEffects 确保 UOL 完成初始化，并以固定 system Principal 进程内调用只读操作。
 * @failure 初始化、权限、设置读取或输出契约失败时拒绝 Promise；上层 allSettled 将其
 * 局部降级为 unavailable 并记录安全事件。
 */
async function loadSlaVisibilityThroughUol(
  requestId: string
): Promise<boolean> {
  await ensureUolInitialized();
  const output = await invokeOperation<HomepageSlaVisibilityOutput>(
    "settings.getHomepageSlaVisibility",
    {},
    { type: "system", reason: "homepage-sla-visibility" },
    { requestId }
  );
  return output.enabled;
}

/**
 * 通过 system-only UOL operation 读取首页生成 SLA 聚合统计。
 *
 * @param requestId - 当前首页请求的关联 ID，原样传入 UOL 网关用于审计关联。
 * @returns 仅包含公开计数和成功率的严格 SLA 统计 DTO。
 * @sideEffects 确保 UOL 完成初始化，并以固定 system Principal 进程内调用只读操作。
 * @failure 初始化、late binding、统计查询或输出契约失败时拒绝 Promise；上层
 * allSettled 将其局部降级为 unavailable 并记录安全事件。
 */
async function loadSlaStatsThroughUol(
  requestId: string
): Promise<HomepageGenerationSlaStatsOutput> {
  await ensureUolInitialized();
  return invokeOperation<HomepageGenerationSlaStatsOutput>(
    "analytics.getHomepageGenerationSlaStats",
    {},
    { type: "system", reason: "homepage-generation-sla-stats" },
    { requestId }
  );
}

const defaultLoaders: HomepagePageDataLoaders = {
  createRequestId: () => crypto.randomUUID(),
  loadCatalog: loadCatalogThroughUol,
  loadSlaVisibility: loadSlaVisibilityThroughUol,
  loadSlaStats: loadSlaStatsThroughUol,
  loadSession: getServerSession,
  loadRole: getUserRoleById,
  reportFailure: reportHomepageFailure,
};

/**
 * 并行装配首页模型、可靠性与会话，再按需加载角色。
 *
 * @param loaders - 可注入依赖；生产默认值通过 UOL 读取模型和 SLA，并复用 auth 服务。
 * @returns 仅包含公开模型 DTO、可靠性枚举/数字、CTA href 与管理员布尔值的数据。
 * @sideEffects 读取运行时配置、统计、会话和角色；每个失败只写一条安全结构化日志。
 * @failure 任一依赖失败均局部降级，不抛出原始错误，也不让首页请求整体失败。
 */
export async function loadHomepagePageData(
  loaders: HomepagePageDataLoaders = defaultLoaders
): Promise<HomepagePageData> {
  const requestId = loaders.createRequestId();
  const [catalogResult, visibilityResult, statsResult, sessionResult] =
    await Promise.allSettled([
      loaders.loadCatalog(requestId),
      loaders.loadSlaVisibility(requestId),
      loaders.loadSlaStats(requestId),
      loaders.loadSession(),
    ]);

  let catalog: HomepageModelCatalogState = { status: "unavailable" };
  if (catalogResult.status === "fulfilled") {
    const parsed = parseCatalog(catalogResult.value);
    if (parsed) catalog = parsed;
    else
      loaders.reportFailure(
        toInvalidPayloadFailure("model_catalog", requestId)
      );
  } else {
    loaders.reportFailure(
      toSafeFailure("model_catalog", requestId, catalogResult.reason)
    );
  }

  let visibility: HomepageReliabilityState["visibility"] = "unavailable";
  if (visibilityResult.status === "fulfilled") {
    if (typeof visibilityResult.value === "boolean") {
      visibility = visibilityResult.value ? "enabled" : "disabled";
    } else {
      loaders.reportFailure(
        toInvalidPayloadFailure("sla_visibility", requestId)
      );
    }
  } else {
    loaders.reportFailure(
      toSafeFailure("sla_visibility", requestId, visibilityResult.reason)
    );
  }

  let stats: HomepageSlaStatsState = { status: "unavailable" };
  if (statsResult.status === "fulfilled") {
    const parsed = parseSlaStats(statsResult.value);
    if (parsed) stats = parsed;
    else loaders.reportFailure(toInvalidPayloadFailure("sla_stats", requestId));
  } else {
    loaders.reportFailure(
      toSafeFailure("sla_stats", requestId, statsResult.reason)
    );
  }

  let ctaHref: HomepagePageData["ctaHref"] = "/sign-up";
  let canToggleSlaStatus = false;
  if (sessionResult.status === "fulfilled") {
    const userId = parseSessionUserId(sessionResult.value);
    if (userId) {
      ctaHref = "/dashboard/generate";
      try {
        const role = await loaders.loadRole(userId);
        if (typeof role === "string") {
          canToggleSlaStatus = isAdminRole(role);
        } else {
          loaders.reportFailure(toInvalidPayloadFailure("role", requestId));
        }
      } catch (error) {
        loaders.reportFailure(toSafeFailure("role", requestId, error));
      }
    }
  } else {
    loaders.reportFailure(
      toSafeFailure("session", requestId, sessionResult.reason)
    );
  }

  return {
    catalog,
    reliability: { visibility, stats },
    ctaHref,
    canToggleSlaStatus,
  };
}
