/**
 * 媒体平台套餐能力矩阵。
 *
 * 职责：定义图片、视频、外部媒体 API、审核与通用资源限制的唯一套餐门槛，并从系统
 * 设置归一化运行时矩阵。Chat、Agent、Responses、waterfall、PPT/PSD 与对话计费不再
 * 属于现行产品能力，历史 JSON 字段会被忽略而不会重新暴露。
 */
import {
  isPlanAtLeast,
  isSubscriptionPlan,
  PLAN_PRIVILEGES,
  PLAN_RANK,
  type QueuePriority,
  SUBSCRIPTION_PLANS,
  type SubscriptionPlan,
} from "../../config/subscription-plan";
import {
  getRuntimeSettingJson,
  getRuntimeSettingNumber,
} from "../../system-settings";

const BYTES_PER_MB = 1024 * 1024;
const MAX_LIMIT_VALUE = 1_000_000;
export const MAX_PLAN_BATCH_COUNT = 10_000;
export const MAX_PLAN_IMAGE_COUNT = 10_000;
const MAX_GENERATION_CONCURRENCY = 10_000;

const QUEUE_PRIORITY_RANK: Record<QueuePriority, number> = {
  normal: 1,
  priority: 2,
  highest: 3,
};
const QUEUE_PRIORITIES = ["normal", "priority", "highest"] as const;

/** 套餐能力矩阵系统设置键。 */
export const PLAN_CAPABILITY_MATRIX_SETTING_KEY = "PLAN_CAPABILITY_MATRIX";

/** 媒体-only 产品保留的套餐能力键。 */
export const PLAN_CAPABILITY_KEYS = [
  "imageGeneration.text",
  "imageGeneration.edit",
  "imageGeneration.mask",
  "imageGeneration.video",
  "imageGeneration.batch",
  "promptOptimization.control",
  "backendGroups.select",
  "externalApi.keys.manage",
  "externalApi.models.list",
  "externalApi.images.generate",
  "externalApi.images.edit",
  "externalApi.images.mask",
  "externalApi.images.batch",
  "externalApi.videos.generate",
  "externalApi.streaming",
  "moderation.blocking",
  "moderation.onlyFailureSettlement",
] as const;

/** 媒体-only 套餐能力键类型。 */
export type PlanCapabilityKey = (typeof PLAN_CAPABILITY_KEYS)[number];

/** 单套餐的媒体资源限制。 */
export type PlanLimitConfig = {
  maxFileMb: number;
  maxUploadMb: number;
  queuePriority: QueuePriority;
  imageGenerationConcurrency: number;
  monthlyCredits: number;
  maxBatchCount: number;
  maxEditImages: number;
};

/** 可持久化的套餐能力矩阵。 */
export type PlanCapabilityMatrix = {
  version: 1;
  features: Record<PlanCapabilityKey, SubscriptionPlan>;
  limits: Record<SubscriptionPlan, PlanLimitConfig>;
};

/** 面向调用方的单套餐能力快照。 */
export type PlanCapabilitySnapshot = {
  plan: SubscriptionPlan;
  features: Record<PlanCapabilityKey, boolean>;
  limits: PlanLimitConfig & {
    maxFileSizeBytes: number;
    maxUploadBytes: number;
  };
};

/** 未配置运行时矩阵时采用的媒体平台默认值。 */
export const DEFAULT_PLAN_CAPABILITY_MATRIX: PlanCapabilityMatrix = {
  version: 1,
  features: {
    "imageGeneration.text": "free",
    "imageGeneration.edit": "free",
    "imageGeneration.mask": "free",
    "imageGeneration.video": "free",
    "imageGeneration.batch": "free",
    "promptOptimization.control": "pro",
    "backendGroups.select": "free",
    "externalApi.keys.manage": "starter",
    "externalApi.models.list": "starter",
    "externalApi.images.generate": "starter",
    "externalApi.images.edit": "starter",
    "externalApi.images.mask": "starter",
    "externalApi.images.batch": "starter",
    "externalApi.videos.generate": "starter",
    "externalApi.streaming": "starter",
    "moderation.blocking": "free",
    "moderation.onlyFailureSettlement": "ultra",
  },
  limits: {
    free: {
      maxFileMb: 5,
      maxUploadMb: 75,
      queuePriority: "normal",
      imageGenerationConcurrency: 2,
      monthlyCredits: 100,
      maxBatchCount: 10,
      maxEditImages: 16,
    },
    starter: {
      maxFileMb: 20,
      maxUploadMb: 75,
      queuePriority: "normal",
      imageGenerationConcurrency: 5,
      monthlyCredits: 5_000,
      maxBatchCount: 10,
      maxEditImages: 16,
    },
    pro: {
      maxFileMb: 50,
      maxUploadMb: 75,
      queuePriority: "priority",
      imageGenerationConcurrency: 15,
      monthlyCredits: 20_000,
      maxBatchCount: 10,
      maxEditImages: 16,
    },
    ultra: {
      maxFileMb: 100,
      maxUploadMb: 100,
      queuePriority: "highest",
      imageGenerationConcurrency: 50,
      monthlyCredits: 80_000,
      maxBatchCount: 10,
      maxEditImages: 16,
    },
    enterprise: {
      maxFileMb: 200,
      maxUploadMb: 200,
      queuePriority: "highest",
      imageGenerationConcurrency: 100,
      monthlyCredits: 320_000,
      maxBatchCount: 10,
      maxEditImages: 16,
    },
  },
};

/** 默认矩阵的可读 JSON，用于环境示例和管理员导入。 */
export const DEFAULT_PLAN_CAPABILITY_MATRIX_JSON = JSON.stringify(
  DEFAULT_PLAN_CAPABILITY_MATRIX,
  null,
  2
);

/** 将 MB 值转换为整数 bytes。 */
export function megabytesToBytes(value: number): number {
  return Math.floor(value * BYTES_PER_MB);
}

/** 判断不可信 JSON 值是否为普通记录。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** 解析正数并按业务硬上限钳制；非法值使用给定回退。 */
function parsePositiveNumber(
  value: unknown,
  fallback: number,
  options?: { integer?: boolean; max?: number }
): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  const bounded = Math.min(options?.max ?? MAX_LIMIT_VALUE, numeric);
  return options?.integer ? Math.floor(bounded) : bounded;
}

/** 解析队列优先级；未知值保持该套餐默认值。 */
function parseQueuePriority(
  value: unknown,
  fallback: QueuePriority
): QueuePriority {
  return QUEUE_PRIORITIES.includes(value as QueuePriority)
    ? (value as QueuePriority)
    : fallback;
}

/** 返回两个队列优先级中更高的一项。 */
function maxQueuePriority(
  current: QueuePriority,
  floor: QueuePriority
): QueuePriority {
  return QUEUE_PRIORITY_RANK[current] >= QUEUE_PRIORITY_RANK[floor]
    ? current
    : floor;
}

/** 只读取现行媒体能力键，历史及未知功能字段全部丢弃。 */
function normalizeFeatureMinimums(
  value: unknown
): Record<PlanCapabilityKey, SubscriptionPlan> {
  const features = { ...DEFAULT_PLAN_CAPABILITY_MATRIX.features };
  if (!isRecord(value)) return features;
  for (const key of PLAN_CAPABILITY_KEYS) {
    const minPlan = value[key];
    if (isSubscriptionPlan(minPlan)) features[key] = minPlan;
  }
  return features;
}

/** 归一化套餐限制，并保证高级套餐不低于低级套餐。 */
function normalizePlanLimits(
  value: unknown
): Record<SubscriptionPlan, PlanLimitConfig> {
  const limits = structuredClone(DEFAULT_PLAN_CAPABILITY_MATRIX.limits);
  if (isRecord(value)) {
    for (const plan of SUBSCRIPTION_PLANS) {
      const raw = value[plan];
      if (!isRecord(raw)) continue;
      const fallback = limits[plan];
      limits[plan] = {
        maxFileMb: parsePositiveNumber(raw.maxFileMb, fallback.maxFileMb),
        maxUploadMb: parsePositiveNumber(raw.maxUploadMb, fallback.maxUploadMb),
        queuePriority: parseQueuePriority(
          raw.queuePriority,
          fallback.queuePriority
        ),
        imageGenerationConcurrency: parsePositiveNumber(
          raw.imageGenerationConcurrency,
          fallback.imageGenerationConcurrency,
          { integer: true, max: MAX_GENERATION_CONCURRENCY }
        ),
        monthlyCredits: parsePositiveNumber(
          raw.monthlyCredits,
          fallback.monthlyCredits,
          { integer: true }
        ),
        maxBatchCount: parsePositiveNumber(
          raw.maxBatchCount,
          fallback.maxBatchCount,
          { integer: true, max: MAX_PLAN_BATCH_COUNT }
        ),
        maxEditImages: parsePositiveNumber(
          raw.maxEditImages,
          fallback.maxEditImages,
          { integer: true, max: MAX_PLAN_IMAGE_COUNT }
        ),
      };
    }
  }

  let previous: PlanLimitConfig | undefined;
  for (const plan of SUBSCRIPTION_PLANS) {
    if (!previous) {
      previous = limits[plan];
      continue;
    }
    const current = limits[plan];
    limits[plan] = {
      maxFileMb: Math.max(current.maxFileMb, previous.maxFileMb),
      maxUploadMb: Math.max(current.maxUploadMb, previous.maxUploadMb),
      queuePriority: maxQueuePriority(
        current.queuePriority,
        previous.queuePriority
      ),
      imageGenerationConcurrency: Math.max(
        current.imageGenerationConcurrency,
        previous.imageGenerationConcurrency
      ),
      monthlyCredits: Math.max(current.monthlyCredits, previous.monthlyCredits),
      maxBatchCount: Math.max(current.maxBatchCount, previous.maxBatchCount),
      maxEditImages: Math.max(current.maxEditImages, previous.maxEditImages),
    };
    previous = limits[plan];
  }
  return limits;
}

/** 在没有矩阵设置时继续读取历史上传/月积分独立键。 */
async function applyLegacyPlanSettings(
  matrix: PlanCapabilityMatrix
): Promise<PlanCapabilityMatrix> {
  const legacy = structuredClone(matrix);
  for (const plan of SUBSCRIPTION_PLANS) {
    const upperPlan = plan.toUpperCase() as Uppercase<SubscriptionPlan>;
    const defaults = legacy.limits[plan];
    const [maxFileMb, maxUploadMb] = await Promise.all([
      getRuntimeSettingNumber(
        `PLAN_${upperPlan}_MAX_FILE_MB` as Parameters<
          typeof getRuntimeSettingNumber
        >[0],
        defaults.maxFileMb,
        { positive: true }
      ),
      getRuntimeSettingNumber(
        `PLAN_${upperPlan}_MAX_UPLOAD_MB` as Parameters<
          typeof getRuntimeSettingNumber
        >[0],
        defaults.maxUploadMb,
        { positive: true }
      ),
    ]);
    legacy.limits[plan].maxFileMb = maxFileMb;
    legacy.limits[plan].maxUploadMb = maxUploadMb;
  }
  for (const plan of ["starter", "pro", "ultra", "enterprise"] as const) {
    const upperPlan = plan.toUpperCase() as Uppercase<typeof plan>;
    legacy.limits[plan].monthlyCredits = await getRuntimeSettingNumber(
      `PLAN_${upperPlan}_MONTHLY_CREDITS` as Parameters<
        typeof getRuntimeSettingNumber
      >[0],
      legacy.limits[plan].monthlyCredits,
      { positive: true }
    );
  }
  legacy.limits = normalizePlanLimits(legacy.limits);
  return legacy;
}

/** 将不可信 JSON 归一为完整媒体能力矩阵。 */
export function normalizePlanCapabilityMatrix(
  value: unknown
): PlanCapabilityMatrix {
  const raw = isRecord(value) ? value : {};
  return {
    version: 1,
    features: normalizeFeatureMinimums(raw.features),
    limits: normalizePlanLimits(raw.limits),
  };
}

/** 读取当前运行时媒体能力矩阵。 */
export async function getPlanCapabilityMatrix(): Promise<PlanCapabilityMatrix> {
  const configured = await getRuntimeSettingJson(
    PLAN_CAPABILITY_MATRIX_SETTING_KEY
  );
  return configured === undefined
    ? applyLegacyPlanSettings(DEFAULT_PLAN_CAPABILITY_MATRIX)
    : normalizePlanCapabilityMatrix(configured);
}

/** 判断套餐是否满足指定媒体能力门槛。 */
export async function canUsePlanCapability(
  plan: SubscriptionPlan,
  key: PlanCapabilityKey
): Promise<boolean> {
  const matrix = await getPlanCapabilityMatrix();
  return isPlanAtLeast(plan, matrix.features[key]);
}

/** 获取指定套餐的归一化媒体限制。 */
export async function getPlanLimits(
  plan: SubscriptionPlan
): Promise<PlanLimitConfig> {
  const matrix = await getPlanCapabilityMatrix();
  return matrix.limits[plan];
}

/** 获取套餐每月积分额度。 */
export async function getPlanMonthlyCredits(
  plan: SubscriptionPlan
): Promise<number> {
  return (await getPlanLimits(plan)).monthlyCredits;
}

/** 获取队列优先级和单用户媒体生成并发。 */
export async function getPlanQueueSettings(
  plan: SubscriptionPlan
): Promise<{ priority: QueuePriority; userConcurrency: number }> {
  const limits = await getPlanLimits(plan);
  return {
    priority: limits.queuePriority,
    userConcurrency: limits.imageGenerationConcurrency,
  };
}

/** 获取可直接返回给前端或 UOL 的完整套餐能力快照。 */
export async function getPlanCapabilitySnapshot(
  plan: SubscriptionPlan
): Promise<PlanCapabilitySnapshot> {
  const matrix = await getPlanCapabilityMatrix();
  const limits = matrix.limits[plan];
  const features = Object.fromEntries(
    PLAN_CAPABILITY_KEYS.map((key) => [
      key,
      PLAN_RANK[plan] >= PLAN_RANK[matrix.features[key]],
    ])
  ) as Record<PlanCapabilityKey, boolean>;
  return {
    plan,
    features,
    limits: {
      ...limits,
      maxFileSizeBytes: megabytesToBytes(limits.maxFileMb),
      maxUploadBytes: megabytesToBytes(limits.maxUploadMb),
    },
  };
}

/** 将动态限制合入遗留 PLAN_PRIVILEGES 展示对象。 */
export async function getPlanPrivilegesFromCapabilities(
  plan: SubscriptionPlan
) {
  const limits = await getPlanLimits(plan);
  return {
    ...PLAN_PRIVILEGES[plan],
    maxFileSizeBytes: megabytesToBytes(limits.maxFileMb),
    maxUploadBytes: megabytesToBytes(limits.maxUploadMb),
    queuePriority: limits.queuePriority,
    imageGenerationConcurrency: limits.imageGenerationConcurrency,
    monthlyCredits: limits.monthlyCredits,
  };
}
