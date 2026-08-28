/**
 * 视频双模式积分报价核心（纯函数，DB-free，可单测）。
 *
 * 使用方：模型配置、分组覆盖、视频预估与任务快照。严格解析器只使用公开 modelId 和
 * 精确分辨率全局价；旧 family 键只能先经本模块的显式兼容转换，避免进入新账单身份。
 */
import { z } from "zod";

import { VIDEO_MODEL_CAPABILITIES } from "../video-generation/capability-catalog";
import {
  type VideoBillingFamily,
  type VideoBillingMode,
  videoBillingModeSchema,
  videoModelIdSchema,
} from "../video-generation/contracts";

export const DEFAULT_VIDEO_BASE_CREDITS_PER_SECOND = 30;
export const DEFAULT_VIDEO_BASE_CREDITS_PER_ITEM = 3;
export const MAX_VIDEO_CREDITS_PER_UNIT = 100_000;
/** 旧调用方继续使用的每秒单价上限别名。 */
export const MAX_VIDEO_CREDITS_PER_SECOND = MAX_VIDEO_CREDITS_PER_UNIT;

/** 平台内置视频计费 family；从真实描述符派生，不维护第二份公开模型清单。 */
export const ADOBE_VIDEO_PRICING_FAMILIES = [
  ...new Set(
    VIDEO_MODEL_CAPABILITIES.map((capability) => capability.billingFamily)
  ),
];

const DEFAULT_VIDEO_FAMILY_CREDITS_PER_SECOND = {
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
} satisfies Record<VideoBillingFamily, number>;

const videoCreditsPerSecondSchema = z
  .number()
  .finite()
  .positive()
  .max(MAX_VIDEO_CREDITS_PER_UNIT);

/** 任一视频计费单位允许的严格正数积分单价。 */
export const videoCreditUnitPriceSchema = videoCreditsPerSecondSchema;

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
export type VideoModelCreditPrices = Record<string, number>;

/** 旧每秒价格 map 类型别名。 */
export type VideoModelCreditsPerSecondMap = VideoModelCreditPrices;

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
  const resolutions = VIDEO_MODEL_CAPABILITIES.flatMap((capability) =>
    capability.billingFamily === normalizedFamily
      ? [...capability.resolutions]
      : []
  );
  return [...new Set(resolutions)];
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

/** 可由全局计费设置覆盖的视频模型与支持分辨率最小描述。 */
export type VideoBillingModelPricingDescriptor = {
  readonly modelId: string;
  readonly supportedResolutions: readonly string[];
};

/**
 * 把静态内置能力与调用方提供的自定义模型收窄到同一计费描述。
 *
 * @param additionalModels - 已由模型广场严格校验的自定义视频模型。
 * @returns 内置模型在前、自定义模型在后的新描述数组。
 * @sideEffects 无。
 * @failure 不抛错；调用方负责保证自定义模型身份不与内置目录冲突。
 */
function listVideoBillingModelPricingDescriptors(
  additionalModels: readonly VideoBillingModelPricingDescriptor[]
): VideoBillingModelPricingDescriptor[] {
  return [
    ...VIDEO_MODEL_CAPABILITIES.map((model) => ({
      modelId: model.modelId,
      supportedResolutions: model.resolutions,
    })),
    ...additionalModels,
  ];
}

/**
 * 从能力目录构造默认模型级按秒模式。
 *
 * @param additionalModels - 可选的既有自定义视频模型。
 * @returns 每个公开模型 ID 均为 `per_second` 的新对象。
 * @sideEffects 无。
 * @failure 不抛错；重复模型 ID 采用调用方最后提供的相同默认值。
 */
export function createDefaultVideoModelBillingModes(
  additionalModels: readonly VideoBillingModelPricingDescriptor[] = []
): Record<string, VideoBillingMode> {
  return Object.fromEntries(
    listVideoBillingModelPricingDescriptors(additionalModels).map((model) => [
      model.modelId,
      "per_second" as const,
    ])
  );
}

/**
 * 从能力目录构造每个模型分辨率 3 积分的默认按条矩阵。
 *
 * @param additionalModels - 可选的既有自定义视频模型。
 * @returns 仅含 `modelId@resolution` 精确键的新价格对象。
 * @sideEffects 无。
 * @failure 不抛错；输入描述应在进入本函数前完成严格校验。
 */
export function createDefaultVideoModelCreditsPerItem(
  additionalModels: readonly VideoBillingModelPricingDescriptor[] = []
): VideoModelCreditPrices {
  return Object.fromEntries(
    listVideoBillingModelPricingDescriptors(additionalModels).flatMap((model) =>
      model.supportedResolutions.map((resolution) => [
        getVideoPricingResolutionKey(model.modelId, resolution),
        DEFAULT_VIDEO_BASE_CREDITS_PER_ITEM,
      ])
    )
  );
}

/** 所有内置视频模型默认按秒计费。 */
export const DEFAULT_VIDEO_MODEL_BILLING_MODES =
  createDefaultVideoModelBillingModes();

/** 所有内置视频模型分辨率默认按条 3 积分。 */
export const DEFAULT_VIDEO_MODEL_CREDITS_PER_ITEM =
  createDefaultVideoModelCreditsPerItem();

/** 双模式共享的价格 map；全局完整性由严格报价解析器结合能力目录校验。 */
export const videoModelCreditPricesSchema = z.record(
  z.string().trim().min(1).max(160),
  videoCreditUnitPriceSchema
);

/** 旧每秒设置与分组契约使用的兼容 schema 别名。 */
export const videoModelCreditsPerSecondMapSchema = videoModelCreditPricesSchema;

/** 全局公开模型 ID 到统一计费模式的严格映射。 */
export const videoModelBillingModesSchema = z.record(
  z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9._:-]*$/),
  videoBillingModeSchema
);

/** 全局公开模型 ID 到统一计费模式的映射。 */
export type VideoModelBillingModes = z.infer<
  typeof videoModelBillingModesSchema
>;

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

const publicCustomVideoModelIdSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/)
  .refine((modelId) => modelId !== "auto" && modelId !== "unknown")
  .refine((modelId) => !modelId.startsWith("firefly-"));
const publicVideoResolutionLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const supportedVideoResolutionsSchema = z
  .array(publicVideoResolutionLabelSchema)
  .min(1)
  .max(20)
  .superRefine((resolutions, context) => {
    const normalized = resolutions.map((resolution) =>
      resolution.toLowerCase()
    );
    if (new Set(normalized).size !== normalized.length) {
      context.addIssue({ code: "custom", message: "视频分辨率不能重复" });
    }
  });

/** 严格报价中单价的来源优先级。 */
export type VideoBillingPriceSource =
  | "group_resolution"
  | "group_model"
  | "global_resolution";

type VideoBillingQuoteBase = {
  readonly modelId: string;
  readonly resolution: string;
  readonly unitPrice: number;
  readonly durationSeconds: number;
  readonly quotedCredits: number;
  readonly priceSource: VideoBillingPriceSource;
};

/** 严格报价解析器返回的模式判别联合。 */
export type VideoBillingQuote =
  | (VideoBillingQuoteBase & {
      readonly mode: "per_second";
      readonly unit: "second";
      /** @deprecated 仅供旧按秒 DTO 兼容；按条分支不存在此字段。 */
      readonly creditsPerSecond: number;
    })
  | (VideoBillingQuoteBase & {
      readonly mode: "per_item";
      readonly unit: "item";
    });

/** 严格双模式报价输入；自定义模型必须携带可信目录中的支持分辨率。 */
export type ResolveVideoBillingQuoteInput = {
  readonly modelId: string;
  readonly supportedResolutions?: readonly string[];
  readonly resolution: string;
  readonly durationSeconds: number;
  readonly mode: VideoBillingMode;
  readonly globalCreditsPerSecond: VideoModelCreditPrices;
  readonly globalCreditsPerItem: VideoModelCreditPrices;
  readonly groupCreditsPerSecond?: VideoModelCreditPrices | null;
  readonly groupCreditsPerItem?: VideoModelCreditPrices | null;
};

/**
 * 解析目标公开模型的可信支持分辨率。
 *
 * @param modelId - 已从请求或配置读取的公开模型 ID。
 * @param supportedResolutions - 自定义模型在可信目录中声明的分辨率。
 * @returns 规范模型 ID 与不可为空、大小写不重复的分辨率副本。
 * @sideEffects 无。
 * @throws Error - 未知模型未携带可信能力或能力声明非法时 fail closed。
 */
function resolveBillingModel(
  modelId: unknown,
  supportedResolutions: unknown
): { modelId: string; supportedResolutions: string[] } {
  const builtInModelId = videoModelIdSchema.safeParse(modelId);
  if (builtInModelId.success) {
    const capability = VIDEO_MODEL_CAPABILITIES.find(
      (candidate) => candidate.modelId === builtInModelId.data
    );
    if (!capability) {
      throw new Error("视频计费模型缺少内置能力描述符");
    }
    return {
      modelId: capability.modelId,
      supportedResolutions:
        supportedVideoResolutionsSchema.parse(supportedResolutions ?? capability.resolutions),
    };
  }

  if (supportedResolutions === undefined) {
    throw new Error("未知视频模型缺少可信分辨率能力");
  }
  return {
    modelId: publicCustomVideoModelIdSchema.parse(modelId),
    supportedResolutions:
      supportedVideoResolutionsSchema.parse(supportedResolutions),
  };
}

/**
 * 校验目标模型的全局双价格矩阵完整覆盖全部支持分辨率。
 *
 * @param modelId - 规范公开模型 ID。
 * @param supportedResolutions - 可信能力目录声明的分辨率。
 * @param prices - 已通过正数单价基础校验的全局矩阵。
 * @param mode - 用于错误定位的矩阵模式。
 * @sideEffects 无。
 * @throws Error - 任一精确 `modelId@resolution` 价格缺失时 fail closed。
 */
function assertCompleteGlobalVideoPricing(
  modelId: string,
  supportedResolutions: readonly string[],
  prices: VideoModelCreditPrices,
  mode: VideoBillingMode
): void {
  for (const supportedResolution of supportedResolutions) {
    const key = getVideoPricingResolutionKey(modelId, supportedResolution);
    if (typeof prices[key] !== "number") {
      throw new Error(`视频模型 ${modelId} 的 ${mode} 全局价格缺少 ${key}`);
    }
  }
}

/**
 * 计算已解析视频单价的报价总积分。
 *
 * @param input - 严格模式、正数单价与有限正数时长；报价解析器另行要求整数时长。
 * @returns 按秒为单价乘时长、按条为单价本身，均向上取到两位小数。
 * @sideEffects 无。
 * @throws Error - 模式、单价或时长非法，或总额超出安全数值范围时 fail closed。
 */
export function getVideoBillingCreditCost(input: {
  mode: VideoBillingMode;
  unitPrice: number;
  durationSeconds: number;
}): number {
  const mode = videoBillingModeSchema.parse(input.mode);
  const unitPrice = videoCreditUnitPriceSchema.parse(input.unitPrice);
  const durationSeconds = z
    .number()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .parse(input.durationSeconds);
  const quotedCredits = ceil2(
    mode === "per_second" ? unitPrice * durationSeconds : unitPrice
  );
  if (
    !Number.isFinite(quotedCredits) ||
    quotedCredits > Number.MAX_SAFE_INTEGER
  ) {
    throw new Error("视频报价总积分超出安全数值范围");
  }
  return quotedCredits;
}

/**
 * 按分组精确覆盖、分组模型兼容覆盖、全局精确价格的顺序解析单价。
 *
 * @param modelId - 规范公开模型 ID。
 * @param resolution - 已验证为模型支持的分辨率。
 * @param globalPrices - 当前模式的完整全局价格矩阵。
 * @param groupPrices - 当前模式的稀疏分组覆盖。
 * @returns 严格正数单价及其来源。
 * @sideEffects 无。
 * @throws Error - 完整性校验后仍找不到全局精确价时 fail closed。
 */
function resolveStrictVideoUnitPrice(
  modelId: string,
  resolution: string,
  globalPrices: VideoModelCreditPrices,
  groupPrices: VideoModelCreditPrices
): { priceSource: VideoBillingPriceSource; unitPrice: number } {
  const resolutionKey = getVideoPricingResolutionKey(modelId, resolution);
  const groupResolutionPrice = groupPrices[resolutionKey];
  if (typeof groupResolutionPrice === "number") {
    return {
      priceSource: "group_resolution",
      unitPrice: groupResolutionPrice,
    };
  }
  const groupModelPrice = groupPrices[modelId];
  if (typeof groupModelPrice === "number") {
    return { priceSource: "group_model", unitPrice: groupModelPrice };
  }
  const globalResolutionPrice = globalPrices[resolutionKey];
  if (typeof globalResolutionPrice !== "number") {
    throw new Error(`视频模型缺少全局精确价格: ${resolutionKey}`);
  }
  return {
    priceSource: "global_resolution",
    unitPrice: globalResolutionPrice,
  };
}

/**
 * 用同一严格规则解析配置、预估、任务创建和结算共享的视频报价。
 *
 * @param input - 公开模型、分辨率、模式、双全局矩阵及双分组稀疏覆盖。
 * @returns 包含模式、单位、有效单价、来源和总额的判别联合。
 * @sideEffects 无；不读取数据库、环境变量或缓存。
 * @throws Error - 未知模型、非法模式/价格/时长、能力外分辨率或不完整矩阵时 fail closed。
 */
export function resolveVideoBillingQuote(
  input: ResolveVideoBillingQuoteInput
): VideoBillingQuote {
  const billingModel = resolveBillingModel(
    input.modelId,
    input.supportedResolutions
  );
  const mode = videoBillingModeSchema.parse(input.mode);
  const resolution = publicVideoResolutionLabelSchema.parse(input.resolution);
  const durationSeconds = z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .parse(input.durationSeconds);
  if (!billingModel.supportedResolutions.includes(resolution)) {
    throw new Error(
      `视频模型 ${billingModel.modelId} 不支持分辨率 ${resolution}`
    );
  }

  // WHY：两套矩阵都属于同一个可运营配置事实；即使当前只使用其中一种，也不能让
  // 另一套损坏值潜伏到模式切换时才造成不完整或跨模式金额回退。
  const globalCreditsPerSecond = videoModelCreditPricesSchema.parse(
    input.globalCreditsPerSecond
  );
  const globalCreditsPerItem = videoModelCreditPricesSchema.parse(
    input.globalCreditsPerItem
  );
  const groupCreditsPerSecond = videoModelCreditPricesSchema.parse(
    input.groupCreditsPerSecond ?? {}
  );
  const groupCreditsPerItem = videoModelCreditPricesSchema.parse(
    input.groupCreditsPerItem ?? {}
  );
  assertCompleteGlobalVideoPricing(
    billingModel.modelId,
    billingModel.supportedResolutions,
    globalCreditsPerSecond,
    "per_second"
  );
  assertCompleteGlobalVideoPricing(
    billingModel.modelId,
    billingModel.supportedResolutions,
    globalCreditsPerItem,
    "per_item"
  );

  const selected =
    mode === "per_second"
      ? resolveStrictVideoUnitPrice(
          billingModel.modelId,
          resolution,
          globalCreditsPerSecond,
          groupCreditsPerSecond
        )
      : resolveStrictVideoUnitPrice(
          billingModel.modelId,
          resolution,
          globalCreditsPerItem,
          groupCreditsPerItem
        );
  const quotedCredits = getVideoBillingCreditCost({
    mode,
    unitPrice: selected.unitPrice,
    durationSeconds,
  });
  const common = {
    modelId: billingModel.modelId,
    resolution,
    unitPrice: selected.unitPrice,
    durationSeconds,
    quotedCredits,
    priceSource: selected.priceSource,
  };
  if (mode === "per_second") {
    return {
      ...common,
      mode,
      unit: "second",
      creditsPerSecond: selected.unitPrice,
    };
  }
  return { ...common, mode, unit: "item" };
}

/**
 * 把旧 family / family@resolution 每秒键转换为新核心使用的公开模型精确键。
 *
 * @param value - 旧 `VIDEO_MODEL_CREDITS_PER_SECOND` 扁平映射。
 * @returns 仅含 `modelId@resolution` 的新对象；精确旧键优先于 family 键。
 * @sideEffects 无。
 * @throws Error - 任一输入单价非法时拒绝整个转换，不静默修复财务配置。
 */
export function convertLegacyVideoCreditsPerSecondToModelPricing(
  value: VideoModelCreditsPerSecondMap
): VideoModelCreditPrices {
  const legacy = videoModelCreditsPerSecondMapSchema.parse(value);
  const converted: VideoModelCreditPrices = {};
  for (const capability of VIDEO_MODEL_CAPABILITIES) {
    for (const resolution of capability.resolutions) {
      const legacyResolutionKey = getVideoPricingResolutionKey(
        capability.billingFamily,
        resolution
      );
      const unitPrice =
        legacy[legacyResolutionKey] ?? legacy[capability.billingFamily];
      if (typeof unitPrice === "number") {
        converted[
          getVideoPricingResolutionKey(capability.modelId, resolution)
        ] = unitPrice;
      }
    }
  }
  return converted;
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
  if (duration === 0) return 0;
  return getVideoBillingCreditCost({
    mode: "per_second",
    unitPrice: creditsPerSecond,
    durationSeconds: duration,
  });
}
