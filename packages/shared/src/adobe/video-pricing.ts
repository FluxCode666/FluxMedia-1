/**
 * Adobe Firefly 视频固定每秒积分计算（纯函数，DB-free，可单测）。
 *
 * 使用方：视频生成扣费与创作页预估。每个模型族可按输出分辨率配置每秒价格；旧配置
 * 仅含模型族价格时自动兼容。模块不读取 DB 或运行时设置，确保预估和实扣口径一致。
 */
import { z } from "zod";

import { FIREFLY_VIDEO_FAMILIES } from "./firefly-direct/video-catalog";

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
  "runway-gen45",
  "ray314",
  "ray314-hdr",
  "seedance2",
  "seedance2-fast",
] as const;

const DEFAULT_VIDEO_FAMILY_CREDITS_PER_SECOND: Record<string, number> = {
  sora2: 30,
  "sora2-pro": 60,
  veo31: 45,
  "veo31-ref": 45,
  "veo31-fast": 30,
  "kling-o3": 30,
  kling3: 30,
  "kling3-omni": 30,
  "runway-gen45": 30,
  ray314: 30,
  "ray314-hdr": 30,
  seedance2: 30,
  "seedance2-fast": 30,
};

const videoCreditsPerSecondSchema = z
  .number()
  .finite()
  .positive()
  .max(MAX_VIDEO_CREDITS_PER_SECOND);

const videoResolutionSchema = z
  .string()
  .trim()
  .regex(/^(?:default|[1-9]\d{2,4}p|[1-9]\d*k)$/i)
  .max(32);

/** 单个模型族按输出分辨率配置的完整或候选每秒积分映射。 */
export const videoCreditsPerSecondByResolutionSchema = z
  .record(videoResolutionSchema, videoCreditsPerSecondSchema)
  .refine(
    (value) => Object.keys(value).length > 0,
    "至少配置一个视频分辨率价格"
  )
  .refine(
    (value) => Object.keys(value).length <= 20,
    "单个视频模型最多配置 20 个分辨率价格"
  );

/** 单个视频模型族的分辨率每秒价格。 */
export type VideoCreditsPerSecondByResolution = z.infer<
  typeof videoCreditsPerSecondByResolutionSchema
>;

/** 视频价格设置与分组覆盖使用的扁平数值映射。 */
export type VideoModelCreditsPerSecondMap = Record<string, number>;

/**
 * 构造模型族与分辨率的规范价格键。
 *
 * @param family - 视频模型族。
 * @param resolution - 输出分辨率标签。
 * @returns 小写的 `family@resolution` 键；调用方仍需用 schema 校验外部输入。
 * @sideEffects 无。
 * @failure 不抛错；空文本只会形成不可命中内置目录的键。
 */
export function getVideoPricingResolutionKey(
  family: string,
  resolution: string
): string {
  return `${family.trim().toLowerCase()}@${resolution.trim().toLowerCase()}`;
}

/**
 * 判断价格键是否为分辨率档位键。
 *
 * @param key - 持久化价格映射中的键。
 * @returns 包含非空模型族与分辨率时为 true。
 * @sideEffects 无。
 * @failure 不抛错。
 */
export function isVideoPricingResolutionKey(key: string): boolean {
  const separatorIndex = key.indexOf("@");
  return (
    separatorIndex > 0 &&
    separatorIndex === key.lastIndexOf("@") &&
    separatorIndex < key.length - 1
  );
}

/**
 * 读取内置视频模型族支持的分辨率。
 *
 * @param family - 视频模型族。
 * @returns 去重后的目录顺序副本；未知模型族返回空数组。
 * @sideEffects 无。
 * @failure 不抛错。
 */
export function getVideoPricingResolutions(family: string): string[] {
  const normalizedFamily = family.trim().toLowerCase();
  const specification = FIREFLY_VIDEO_FAMILIES.find(
    (candidate) => candidate.family === normalizedFamily
  );
  return specification ? [...new Set(specification.resolutions)] : [];
}

/**
 * 创建包含旧模型族兜底键及全部分辨率键的开发默认价格。
 *
 * `family` 保留给旧版本回滚；当前版本始终优先读取 `family@resolution`。每次调用返回
 * 新对象，避免测试或表单草稿修改共享常量。
 */
export function createDefaultVideoModelCreditsPerSecond(): VideoModelCreditsPerSecondMap {
  const result: VideoModelCreditsPerSecondMap = {};
  for (const family of ADOBE_VIDEO_PRICING_FAMILIES) {
    const price =
      DEFAULT_VIDEO_FAMILY_CREDITS_PER_SECOND[family] ??
      DEFAULT_VIDEO_BASE_CREDITS_PER_SECOND;
    result[family] = price;
    for (const resolution of getVideoPricingResolutions(family)) {
      result[getVideoPricingResolutionKey(family, resolution)] = price;
    }
  }
  return result;
}

/** 全局模型价格的开发默认值；所有内置模型族及分辨率均有明确每秒价格。 */
export const DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND =
  createDefaultVideoModelCreditsPerSecond();

/** 分组视频价格覆盖允许留空，可按模型族或 family@resolution 覆盖全局价格。 */
export const videoModelCreditsPerSecondMapSchema = z.record(
  z.string().trim().min(1).max(120),
  videoCreditsPerSecondSchema
);

/**
 * 将旧的 family 单价补齐到全部内置分辨率，并为新矩阵维护旧版安全兜底价。
 *
 * @param value - 已通过基础数值映射校验的价格。
 * @returns 新对象；分辨率缺失时继承 family，family 缺失时取完整分辨率矩阵的最高价。
 * @sideEffects 无。
 * @failure 不抛错；缺失项由后续全局 schema 明确报告。
 */
function normalizeGlobalVideoPricing(
  value: VideoModelCreditsPerSecondMap
): VideoModelCreditsPerSecondMap {
  const normalized = { ...value };
  for (const family of ADOBE_VIDEO_PRICING_FAMILIES) {
    const resolutions = getVideoPricingResolutions(family);
    const configuredResolutionPrices = resolutions.flatMap((resolution) => {
      const price =
        normalized[getVideoPricingResolutionKey(family, resolution)];
      return typeof price === "number" ? [price] : [];
    });
    const familyPrice = normalized[family];
    if (typeof familyPrice === "number") {
      for (const resolution of resolutions) {
        const key = getVideoPricingResolutionKey(family, resolution);
        if (normalized[key] === undefined) normalized[key] = familyPrice;
      }
      continue;
    }
    if (configuredResolutionPrices.length === resolutions.length) {
      normalized[family] = Math.max(...configuredResolutionPrices);
    }
  }
  return normalized;
}

/** 全局视频价格必须覆盖全部内置模型族及其支持的分辨率。 */
export const globalVideoModelCreditsPerSecondSchema =
  videoModelCreditsPerSecondMapSchema
    .transform(normalizeGlobalVideoPricing)
    .superRefine((value, ctx) => {
      for (const family of ADOBE_VIDEO_PRICING_FAMILIES) {
        if (typeof value[family] !== "number") {
          ctx.addIssue({
            code: "custom",
            path: [family],
            message:
              "Global pricing is required for every built-in video family",
          });
        }
        for (const resolution of getVideoPricingResolutions(family)) {
          const key = getVideoPricingResolutionKey(family, resolution);
          if (typeof value[key] === "number") continue;
          ctx.addIssue({
            code: "custom",
            path: [key],
            message:
              "Global pricing is required for every supported video resolution",
          });
        }
      }
    });

/** 把未知持久化值收窄为安全的 family / family@resolution → 每秒积分 map。 */
export function parseVideoModelCreditsPerSecond(
  value: unknown
): VideoModelCreditsPerSecondMap {
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
 * 解析视频模型族旧版兜底的每秒积分价格。
 *
 * @param family - 视频模型族。
 * @param prices - `VIDEO_MODEL_CREDITS_PER_SECOND` 的扁平每秒积分 map。
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
 * 解析指定模型族和分辨率的每秒积分价格。
 *
 * @param family - 视频模型族。
 * @param resolution - 当前输出分辨率。
 * @param prices - family 及 family@resolution 的价格映射。
 * @param fallback - 两类键均缺失或非法时使用的安全基价。
 * @returns 分辨率价格优先，其次模型族旧价格，最后安全基价。
 * @sideEffects 无。
 * @failure 不抛错；非法价格不会参与计费。
 */
export function resolveVideoCreditsPerSecondByResolution(
  family: string | null | undefined,
  resolution: string | null | undefined,
  prices: VideoModelCreditsPerSecondMap | null | undefined,
  fallback: number = DEFAULT_VIDEO_BASE_CREDITS_PER_SECOND
): number {
  if (family && resolution && prices) {
    const value = prices[getVideoPricingResolutionKey(family, resolution)];
    if (typeof value === "number" && isValidCreditsPerSecond(value)) {
      return value;
    }
  }
  return resolveVideoCreditsPerSecond(family, prices, fallback);
}

/**
 * 按分组覆盖优先、全局模型价兜底解析每秒积分。
 *
 * 分组覆盖缺失时使用全局值。最后一个参数只服务于历史脏数据的安全恢复，正常配置不会
 * 触发，因此业务配置层没有第三层可编辑价格。
 */
export function resolveEffectiveVideoCreditsPerSecond(input: {
  family: string | null | undefined;
  resolution?: string | null;
  global: VideoModelCreditsPerSecondMap;
  group?: VideoModelCreditsPerSecondMap | null;
}): number {
  if (input.group && input.family && input.resolution) {
    const resolutionPrice =
      input.group[getVideoPricingResolutionKey(input.family, input.resolution)];
    if (
      typeof resolutionPrice === "number" &&
      isValidCreditsPerSecond(resolutionPrice)
    ) {
      return resolutionPrice;
    }
  }
  const groupFamilyPrice = input.family
    ? input.group?.[input.family]
    : undefined;
  if (
    typeof groupFamilyPrice === "number" &&
    isValidCreditsPerSecond(groupFamilyPrice)
  ) {
    return groupFamilyPrice;
  }
  return resolveVideoCreditsPerSecondByResolution(
    input.family,
    input.resolution,
    input.global,
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
