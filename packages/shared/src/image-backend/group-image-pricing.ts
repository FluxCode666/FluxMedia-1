/**
 * 图像模型固定价格与分组媒体价格覆盖的共享契约。
 *
 * 使用方：系统设置、后端池分组管理、统一媒体管线与管理后台。模块负责图像价格的
 * 规范化和继承，并安全读取分组视频双价格，不读取数据库，也不执行扣费。
 */
import { z } from "zod";

import { videoModelCreditPricesSchema } from "../video-generation/video-pricing";

/** 平台内置图像模型 ID；供应商账号通过 API 显式声明这些或其他受信任模型。 */
export const BUILTIN_IMAGE_MODEL_IDS = [
  "gpt-image-2",
  "gpt-image-1.5",
  "nano-banana-pro",
  "nano-banana",
  "nano-banana-2",
] as const;

export const IMAGE_CREDIT_PRICE_FIELDS = [
  "base1024Credits",
  "base1kCredits",
  "base2kCredits",
  "base4kCredits",
] as const;

export type ImageCreditPriceField = (typeof IMAGE_CREDIT_PRICE_FIELDS)[number];
export type ImageCreditPricing = Partial<
  Record<ImageCreditPriceField, number | undefined> & {
    base8kCredits?: number | undefined;
  }
>;
export type ResolvedImageCreditPricing = Record<ImageCreditPriceField, number> & {
  base8kCredits?: number | undefined;
};
export type ImageModelCreditPricingMap = Record<string, ImageCreditPricing>;

export const DEFAULT_IMAGE_CREDIT_PRICING: ResolvedImageCreditPricing = {
  base1024Credits: 1.27,
  base1kCredits: 1.27,
  base2kCredits: 5.07,
  base4kCredits: 10,
};

/** 仅用于读取历史 JSON；该保留键不会进入规范结果或运行时价格匹配。 */
const LEGACY_DEFAULT_IMAGE_PRICING_MODEL = "default";

const REQUIRED_GLOBAL_IMAGE_PRICING_MODELS = [...BUILTIN_IMAGE_MODEL_IDS];

/** 缺少完整显式全局模型价格时抛出的稳定 fail-closed 错误。 */
export class MissingGlobalImagePricingError extends Error {
  /**
   * 创建不携带价格配置内容的计费错误。
   *
   * @param model - 已规范化的请求模型；空请求保留为 null。
   * @sideEffects 无。
   */
  constructor(readonly model: string | null) {
    super(
      model
        ? `Missing complete global image pricing for model: ${model}`
        : "Missing complete global image pricing for the requested model"
    );
    this.name = "MissingGlobalImagePricingError";
  }
}

export const DEFAULT_IMAGE_MODERATION_CREDIT_PRICING = {
  textModerationCredits: 0.04,
  imageModerationCredits: 0.06,
} as const;

const imageCreditValueSchema = z.number().finite().positive().max(100_000);

export const imageCreditPricingSchema = z
  .object({
    base1024Credits: imageCreditValueSchema.optional(),
    base1kCredits: imageCreditValueSchema.optional(),
    base2kCredits: imageCreditValueSchema.optional(),
    base4kCredits: imageCreditValueSchema.optional(),
    base8kCredits: imageCreditValueSchema.optional(),
  })
  .strict();

export const imageModelCreditPricingMapSchema = z
  .record(
    z.string().trim().min(1).max(120),
    imageCreditPricingSchema.refine(
      (pricing) => IMAGE_CREDIT_PRICE_FIELDS.some((field) => pricing[field]),
      "At least one image credit price is required"
    )
  )
  .refine(
    (pricing) => Object.keys(pricing).length <= 200,
    "At most 200 image models can be configured"
  );

export const imageCreditOverridesSchema = z
  .object({
    version: z.literal(1),
    byModel: imageModelCreditPricingMapSchema,
  })
  .strict();

export type ImageCreditOverrides = z.infer<typeof imageCreditOverridesSchema>;

/**
 * 生成完整的全局模型价格默认值。
 *
 * 全局价格是计费的唯一兜底层，不能出现空模型或空档位；分组配置才允许保持稀疏以继承
 * 全局价格。每次调用返回新对象，避免表单草稿意外修改共享常量。
 */
export function createDefaultGlobalImageCreditOverrides(): ImageCreditOverrides {
  return {
    version: 1,
    byModel: Object.fromEntries(
      REQUIRED_GLOBAL_IMAGE_PRICING_MODELS.map((model) => [
        model,
        { ...DEFAULT_IMAGE_CREDIT_PRICING },
      ])
    ),
  };
}

/**
 * 全局模型价格契约。
 *
 * 内置图像模型必须逐档给出正数价格；额外模型同样必须填满四档，避免运行时再落入第三层
 * 通用价格，确保计费优先级严格只有“分组 > 全局”。
 */
export const globalImageCreditOverridesSchema = imageCreditOverridesSchema
  .superRefine((value, ctx) => {
    for (const model of REQUIRED_GLOBAL_IMAGE_PRICING_MODELS) {
      const pricing = value.byModel[model];
      if (!pricing) {
        ctx.addIssue({
          code: "custom",
          path: ["byModel", model],
          message: "Global pricing is required for every built-in image model",
        });
        continue;
      }
      for (const field of IMAGE_CREDIT_PRICE_FIELDS) {
        if (typeof pricing[field] === "number") continue;
        ctx.addIssue({
          code: "custom",
          path: ["byModel", model, field],
          message: "Every global image price tier is required",
        });
      }
    }
    for (const [model, pricing] of Object.entries(value.byModel)) {
      if (
        normalizeImagePricingModelId(model) ===
        LEGACY_DEFAULT_IMAGE_PRICING_MODEL
      ) {
        continue;
      }
      for (const field of IMAGE_CREDIT_PRICE_FIELDS) {
        if (typeof pricing[field] === "number") continue;
        ctx.addIssue({
          code: "custom",
          path: ["byModel", model, field],
          message: "Every configured global image price tier is required",
        });
      }
    }
  })
  .transform((value) => parseImageCreditOverrides(value));

export type GlobalImageCreditOverrides = z.infer<
  typeof globalImageCreditOverridesSchema
>;

export const EMPTY_IMAGE_CREDIT_OVERRIDES: ImageCreditOverrides = {
  version: 1,
  byModel: {},
};

/**
 * 规范化用于计价匹配的模型标识。
 *
 * @param model - 请求模型或配置键。
 * @returns 小写模型标识；Firefly 前缀会被移除，空值返回 null。
 */
export function normalizeImagePricingModelId(
  model: string | null | undefined
): string | null {
  const normalized = model?.trim().toLowerCase();
  if (!normalized) return null;
  return normalized.startsWith("firefly-")
    ? normalized.slice("firefly-".length)
    : normalized;
}

/**
 * 将未知 JSON 收窄为可安全用于计费的版本化覆盖配置。
 *
 * @param value - 系统设置或分组 metadata 中的未知值。
 * @returns 合法配置；非法数据返回空配置，避免脏值参与扣费。
 */
export function parseImageCreditOverrides(
  value: unknown
): ImageCreditOverrides {
  const parsed = imageCreditOverridesSchema.safeParse(value);
  if (!parsed.success) return EMPTY_IMAGE_CREDIT_OVERRIDES;

  const byModel: ImageModelCreditPricingMap = {};
  for (const [model, pricing] of Object.entries(parsed.data.byModel)) {
    const normalizedModel = normalizeImagePricingModelId(model);
    if (
      normalizedModel &&
      normalizedModel !== LEGACY_DEFAULT_IMAGE_PRICING_MODEL
    ) {
      byModel[normalizedModel] = pricing;
    }
  }
  return { version: 1, byModel };
}

/**
 * 从后端组 metadata 读取版本化图像价格覆盖。
 *
 * @param metadata - 数据库存储的分组 metadata。
 * @returns 合法的稀疏覆盖；缺失或非法时返回空配置。
 */
export function getGroupImageCreditOverrides(
  metadata: Record<string, unknown> | null | undefined
): ImageCreditOverrides {
  return parseImageCreditOverrides(metadata?.imageCreditOverrides);
}

/**
 * 从后端组 metadata 读取视频模型族或分辨率每秒价格覆盖。
 *
 * 分组视频价格与图像价格一样保持稀疏：分辨率键缺失时依次回退本组模型族与全局价格。
 */
export function getGroupVideoCreditOverrides(
  metadata: Record<string, unknown> | null | undefined
): Record<string, number> {
  return parseGroupVideoCreditOverrides(metadata?.videoCreditOverrides);
}

/**
 * 从后端组 metadata 读取视频模型或分辨率的每条价格覆盖。
 *
 * @param metadata - 数据库存储的分组 metadata。
 * @returns 合法的按条稀疏覆盖；缺失或非法时返回空配置并继承全局按条价格。
 * @sideEffects 无。
 * @failure 不抛错；脏值不会错误回退到按秒价格。
 */
export function getGroupVideoCreditsPerItemOverrides(
  metadata: Record<string, unknown> | null | undefined
): Record<string, number> {
  return parseGroupVideoCreditOverrides(metadata?.videoCreditsPerItemOverrides);
}

/**
 * 收窄分组的一套视频稀疏价格表。
 *
 * @param value - metadata 中的未知价格 JSON。
 * @returns 仅包含合法正有限单价的映射；整张表非法时返回空映射。
 * @sideEffects 无。
 * @failure 不抛错。
 */
function parseGroupVideoCreditOverrides(
  value: unknown
): Record<string, number> {
  const parsed = videoModelCreditPricesSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

/**
 * 在模型价格表中查找请求模型对应的最长前缀配置。
 *
 * @param model - 实际生图模型，可包含 Firefly、分辨率和宽高比后缀。
 * @param pricingByModel - 已规范化或来自持久层的模型价格表。
 * @returns 命中的稀疏四档价格；未配置时返回空对象。
 */
export function getImageModelCreditPricing(
  model: string | null | undefined,
  pricingByModel: ImageModelCreditPricingMap
): ImageCreditPricing {
  const normalizedModel = normalizeImagePricingModelId(model);
  if (
    !normalizedModel ||
    normalizedModel === LEGACY_DEFAULT_IMAGE_PRICING_MODEL
  ) {
    return {};
  }

  const matchingEntry = Object.entries(pricingByModel)
    .map(([key, pricing]) => ({
      key: normalizeImagePricingModelId(key),
      pricing,
    }))
    .filter(
      (entry): entry is { key: string; pricing: ImageCreditPricing } =>
        Boolean(entry.key) && entry.key !== LEGACY_DEFAULT_IMAGE_PRICING_MODEL
    )
    .sort((left, right) => right.key.length - left.key.length)
    .find(
      ({ key }) =>
        normalizedModel === key || normalizedModel.startsWith(`${key}-`)
    );
  return matchingEntry?.pricing ?? {};
}

/**
 * 判断模型价格是否包含四个可安全计费的正有限档位。
 *
 * @param pricing - 最长前缀匹配得到的稀疏模型价格。
 * @returns 四档均为正有限数时收窄为完整价格。
 * @sideEffects 无。
 */
function isResolvedImageCreditPricing(
  pricing: ImageCreditPricing
): pricing is ResolvedImageCreditPricing {
  return IMAGE_CREDIT_PRICE_FIELDS.every((field) => {
    const value = pricing[field];
    return typeof value === "number" && Number.isFinite(value) && value > 0;
  });
}

/**
 * 合并全局模型价格和分组模型覆盖。
 *
 * @param input.model - 实际生图模型。
 * @param input.global - 全局模型价格配置。
 * @param input.group - 用户所选分组的稀疏覆盖配置。
 * @returns 完整四档价格，优先级为具体模型的分组覆盖、显式全局价格。
 * @throws MissingGlobalImagePricingError - 请求模型缺失或没有完整显式全局价格时失败；分组
 * 覆盖不能替代全局价格真相。
 */
export function resolveImageCreditPricing(input: {
  model: string | null | undefined;
  global: ImageCreditOverrides;
  group?: ImageCreditOverrides | null;
}): ResolvedImageCreditPricing {
  const globalPricing = getImageModelCreditPricing(
    input.model,
    input.global.byModel
  );
  const normalizedModel = normalizeImagePricingModelId(input.model);
  if (!isResolvedImageCreditPricing(globalPricing)) {
    throw new MissingGlobalImagePricingError(normalizedModel);
  }
  const groupPricing = getImageModelCreditPricing(
    input.model,
    input.group?.byModel ?? {}
  );
  const resolved = {
    base1024Credits:
      groupPricing.base1024Credits ?? globalPricing.base1024Credits,
    base1kCredits: groupPricing.base1kCredits ?? globalPricing.base1kCredits,
    base2kCredits: groupPricing.base2kCredits ?? globalPricing.base2kCredits,
    base4kCredits: groupPricing.base4kCredits ?? globalPricing.base4kCredits,
  };
  const base8kCredits =
    groupPricing.base8kCredits ?? globalPricing.base8kCredits;
  return base8kCredits === undefined
    ? resolved
    : { ...resolved, base8kCredits };
}
