/**
 * Adobe Firefly 视频固定每秒积分计算（纯函数，DB-free，可单测）。
 *
 * 使用方：视频生成扣费与创作页预估。每个模型族可配置自己的每秒价格；未配置族回退
 * 全局每秒基价。模块不读取 DB 或运行时设置，确保预估和实扣共用同一计算口径。
 */
import { z } from "zod";

export const DEFAULT_VIDEO_BASE_CREDITS_PER_SECOND = 30;
export const MAX_VIDEO_CREDITS_PER_SECOND = 100_000;

/** 平台内置视频模型族，顺序同时用于全局与分组价格表展示。 */
export const ADOBE_VIDEO_PRICING_FAMILIES = [
  "sora2",
  "sora2-pro",
  "veo31",
  "veo31-ref",
  "veo31-fast",
  "kling-o3",
  "kling3",
  "kling3-omni",
  "seedance2",
  "seedance2-fast",
] as const;

/** 全局模型价格的开发默认值；所有模型族均有明确每秒价格。 */
export const DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND: Record<string, number> = {
  sora2: 30,
  "sora2-pro": 60,
  veo31: 45,
  "veo31-ref": 45,
  "veo31-fast": 30,
  "kling-o3": 30,
  kling3: 30,
  "kling3-omni": 30,
  seedance2: 30,
  "seedance2-fast": 30,
};

const videoCreditsPerSecondSchema = z
  .number()
  .finite()
  .positive()
  .max(MAX_VIDEO_CREDITS_PER_SECOND);

/** 分组视频价格覆盖允许留空，空值继承全局模型每秒价格。 */
export const videoModelCreditsPerSecondMapSchema = z.record(
  z.string().trim().min(1).max(120),
  videoCreditsPerSecondSchema
);

/** 全局视频价格必须覆盖全部内置模型族。 */
export const globalVideoModelCreditsPerSecondSchema =
  videoModelCreditsPerSecondMapSchema.superRefine((value, ctx) => {
    for (const family of ADOBE_VIDEO_PRICING_FAMILIES) {
      if (typeof value[family] === "number") continue;
      ctx.addIssue({
        code: "custom",
        path: [family],
        message: "Global pricing is required for every built-in video family",
      });
    }
  });

/** 把未知持久化值收窄为安全的 family → 每秒积分 map。 */
export function parseVideoModelCreditsPerSecond(
  value: unknown
): Record<string, number> {
  const parsed = videoModelCreditsPerSecondMapSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

/** 判断每秒积分是否可安全参与计费。 */
function isValidCreditsPerSecond(value: number): boolean {
  return (
    Number.isFinite(value) && value > 0 && value <= MAX_VIDEO_CREDITS_PER_SECOND
  );
}

/** 向上取到两位小数，避免积分计费下溢和浮点噪声。 */
function ceil2(value: number): number {
  const cents = Math.round(value * 1_000_000) / 10_000;
  const result = Math.ceil(cents - 1e-9) / 100;
  return Object.is(result, -0) ? 0 : result;
}

/**
 * 解析视频模型族的每秒积分价格。
 *
 * @param family - 视频模型族。
 * @param prices - `VIDEO_MODEL_CREDITS_PER_SECOND` 的 family → 每秒积分 map。
 * @param fallback - 未配置模型族时使用的统一每秒基价。
 * @returns 正数配置值，或有效的回退基价。
 */
export function resolveVideoCreditsPerSecond(
  family: string | null | undefined,
  prices: Record<string, number> | null | undefined,
  fallback: number = DEFAULT_VIDEO_BASE_CREDITS_PER_SECOND
): number {
  const safeFallback = isValidCreditsPerSecond(fallback)
    ? fallback
    : DEFAULT_VIDEO_BASE_CREDITS_PER_SECOND;
  if (!family || !prices) return safeFallback;
  const value = prices[family];
  return typeof value === "number" && isValidCreditsPerSecond(value)
    ? value
    : safeFallback;
}

/**
 * 按分组覆盖优先、全局模型价兜底解析每秒积分。
 *
 * 分组覆盖缺失时使用全局值。最后一个参数只服务于历史脏数据的安全恢复，正常配置不会
 * 触发，因此业务配置层没有第三层可编辑价格。
 */
export function resolveEffectiveVideoCreditsPerSecond(input: {
  family: string | null | undefined;
  global: Record<string, number>;
  group?: Record<string, number> | null;
}): number {
  return resolveVideoCreditsPerSecond(
    input.family,
    {
      ...input.global,
      ...input.group,
    },
    DEFAULT_VIDEO_BASE_CREDITS_PER_SECOND
  );
}

/**
 * 计算一次视频生成的积分成本。
 *
 * @param durationSeconds - 视频时长（秒）。
 * @param creditsPerSecond - 已按模型族解析的每秒积分价格。
 * @returns 向上取到两位小数的总积分。
 */
export function getVideoCreditCost(params: {
  durationSeconds: number;
  creditsPerSecond?: number | null;
}): number {
  const creditsPerSecond =
    typeof params.creditsPerSecond === "number" &&
    isValidCreditsPerSecond(params.creditsPerSecond)
      ? params.creditsPerSecond
      : DEFAULT_VIDEO_BASE_CREDITS_PER_SECOND;
  const duration = Math.max(0, params.durationSeconds || 0);
  return ceil2(creditsPerSecond * duration);
}
