/**
 * 模型广场配置与传输对象的唯一共享契约。
 *
 * 使用方包括系统设置、UOL operation、管理端和公开模型页面。本模块只负责 DB-free 的
 * 结构校验与类型收窄，不读取数据库、不构造存储 URL，也不执行价格或封面写入。
 */
import { z } from "zod";
import { imageCreditPricingSchema } from "../image-backend/group-image-pricing";
import {
  isLegacyVideoModelId,
  normalizeSupportedModelId,
} from "../image-backend/supported-models";
import {
  MAX_MEDIA_INPUT_BYTES,
  MAX_MEDIA_INPUT_COUNT,
} from "../image-generation/media-limits";
import {
  VIDEO_RESOLUTIONS,
  videoBillingModeSchema,
  videoFrameInputCapabilitySchema,
} from "../video-generation";
import {
  MAX_VIDEO_CREDITS_PER_SECOND,
  videoCreditsPerSecondByResolutionSchema,
  videoModelCreditPricesSchema,
} from "../video-generation/video-pricing";

export const MODEL_MARKETPLACE_CONFIG_VERSION = 2 as const;
export const MAX_MODEL_MARKETPLACE_DESCRIPTION_LENGTH = 200;
export const MAX_MODEL_MARKETPLACE_CONFIG_KEY_LENGTH = 120;
export const MAX_MODEL_MARKETPLACE_WRITE_RECEIPTS = 256;
export const MAX_MODEL_MARKETPLACE_CUSTOM_MODELS = 200;
export const MAX_MODEL_MARKETPLACE_SUPPORTED_RESOLUTIONS = 20;
export const MAX_MODEL_MARKETPLACE_COVER_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MODEL_MARKETPLACE_HOMEPAGE_PRIORITY = 5;
export const MAX_MODEL_MARKETPLACE_HOMEPAGE_PRIORITY = 10_000;

const safeRevisionSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const positiveSafeIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const nonnegativeSafeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const configKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_MODEL_MARKETPLACE_CONFIG_KEY_LENGTH);
const realModelConfigKeySchema = configKeySchema.refine(
  (configKey) => configKey.toLowerCase() !== "default",
  "default 不是可配置模型"
);
const modelMarketplaceCustomModelIdSchema = realModelConfigKeySchema
  .transform((modelId) => modelId.toLowerCase())
  .pipe(
    z
      .string()
      .regex(
        /^[a-z0-9][a-z0-9._:-]*$/,
        "自定义模型 ID 只能包含字母、数字、点、下划线、冒号和连字符"
      )
      .refine(
        (modelId) => !modelId.startsWith("firefly-"),
        "自定义模型 ID 不能使用 firefly- 前缀"
      )
      .refine(
        (modelId) => modelId !== "auto" && modelId !== "unknown",
        "自定义模型 ID 不能使用系统保留值"
      )
      .refine(
        (modelId) => !isLegacyVideoModelId(modelId),
        "自定义模型 ID 不能使用历史视频复合格式"
      )
  );
const descriptionSchema = z
  .string()
  .trim()
  .max(MAX_MODEL_MARKETPLACE_DESCRIPTION_LENGTH);
const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/i);
const completedAtSchema = z.string().datetime({ offset: true });

/** 官网首页模型排序优先级；数字越小越优先，默认值由读取规则统一补齐。 */
export const modelMarketplaceHomepagePrioritySchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_MODEL_MARKETPLACE_HOMEPAGE_PRIORITY);

/** 服务端内容寻址封面的固定对象 key，不允许任意历史路径进入存储或公开 URL。 */
export const modelMarketplaceCoverObjectKeySchema = z
  .string()
  .regex(
    /^(image|video)\/[a-f0-9]{64}\/[a-f0-9]{64}\.webp$/,
    "模型封面对象 key 必须使用内容寻址格式"
  );

/** 图像模型四档完整价格；复用现有财务字段及单价上限。 */
export const modelMarketplaceImagePricingSchema = imageCreditPricingSchema
  .pick({
    base1024Credits: true,
    base1kCredits: true,
    base2kCredits: true,
    base4kCredits: true,
  })
  .required()
  .extend({
    base8kCredits: z.number().finite().positive().max(100_000).optional(),
  });

/** 模型广场支持的真实模型类别。 */
export const modelMarketplaceConfigurationCategorySchema = z.enum([
  "image",
  "video",
]);

/** 自定义模型支持的分辨率标签；标签由管理员配置并原样传递给上游适配器。 */
export const modelMarketplaceSupportedResolutionSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/, "分辨率标签格式无效");

const modelMarketplaceSupportedResolutionsSchema = z
  .array(modelMarketplaceSupportedResolutionSchema)
  .min(1)
  .max(MAX_MODEL_MARKETPLACE_SUPPORTED_RESOLUTIONS)
  .superRefine((resolutions, context) => {
    const normalized = resolutions.map((item) => item.trim().toLowerCase());
    if (new Set(normalized).size !== normalized.length) {
      context.addIssue({
        code: "custom",
        message: "分辨率不能重复",
      });
    }
  });

/** 自定义视频模型的精确输出像素；用于无法从标准 480p/720p 等标签推导的供应商标签。 */
const modelMarketplaceVideoOutputPixelSizeSchema = z
  .object({
    width: positiveSafeIntegerSchema,
    height: positiveSafeIntegerSchema,
  })
  .strict();

/** 一个自定义分辨率可声明一个或多个公开宽高比的输出像素。 */
const modelMarketplaceVideoOutputSizesByAspectRatioSchema = z
  .object({
    "1:1": modelMarketplaceVideoOutputPixelSizeSchema.optional(),
    "4:3": modelMarketplaceVideoOutputPixelSizeSchema.optional(),
    "3:4": modelMarketplaceVideoOutputPixelSizeSchema.optional(),
    "16:9": modelMarketplaceVideoOutputPixelSizeSchema.optional(),
    "9:16": modelMarketplaceVideoOutputPixelSizeSchema.optional(),
    "21:9": modelMarketplaceVideoOutputPixelSizeSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "自定义视频分辨率至少需要一个输出像素映射",
  });

/**
 * 自定义视频输出像素映射，键为分辨率标签，值按 aspect ratio 指定精确尺寸。
 * 标准分辨率可省略映射并沿用平台目录；非标准标签由运行时 fail closed，避免猜测尺寸。
 */
export const modelMarketplaceVideoOutputSizesByResolutionSchema = z.record(
  modelMarketplaceSupportedResolutionSchema,
  modelMarketplaceVideoOutputSizesByAspectRatioSchema
);

/** 管理员创建的自定义模型定义，不包含价格与展示字段。 */
export const modelMarketplaceCustomModelSchema = z
  .object({
    modelId: modelMarketplaceCustomModelIdSchema,
    category: modelMarketplaceConfigurationCategorySchema,
    supportedResolutions: modelMarketplaceSupportedResolutionsSchema,
    /** 视频供应商专属分辨率的输出像素，键为分辨率、子键为公开宽高比。 */
    outputSizesByResolution:
      modelMarketplaceVideoOutputSizesByResolutionSchema.optional(),
    /** 图像模型是否接受质量参数；缺失表示不支持。 */
    supportsQuality: z.boolean().optional(),
    /** 图像模型最多接受的参考图数量；0 表示不支持参考图。 */
    maxReferenceImages: nonnegativeSafeIntegerSchema.optional(),
  })
  .strict()
  .superRefine((model, context) => {
    if (model.category !== "video") {
      if (model.outputSizesByResolution !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["outputSizesByResolution"],
          message: "输出像素映射只适用于自定义视频模型",
        });
      }
      return;
    }
    if (model.maxReferenceImages !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["maxReferenceImages"],
        message: "参考图上限仅适用于图像模型",
      });
    }
    if (!model.outputSizesByResolution) return;
    const supported = new Set(model.supportedResolutions);
    for (const resolution of Object.keys(model.outputSizesByResolution)) {
      if (supported.has(resolution)) continue;
      context.addIssue({
        code: "custom",
        path: ["outputSizesByResolution", resolution],
        message: "输出像素映射必须对应支持的分辨率",
      });
    }
  });

/** 自定义模型定义集合；模型 ID 在图像与视频类别之间也必须全局唯一。 */
export const modelMarketplaceCustomModelsSchema = z
  .array(modelMarketplaceCustomModelSchema)
  .max(MAX_MODEL_MARKETPLACE_CUSTOM_MODELS)
  .superRefine((models, context) => {
    const seen = new Set<string>();
    for (const [index, model] of models.entries()) {
      const key = model.modelId.trim().toLowerCase();
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          path: [index, "modelId"],
          message: "自定义模型 ID 不能重复",
        });
      }
      seen.add(key);
    }
  });

/** 公开模型只允许图像与视频，不允许计费兜底项。 */
export const modelMarketplacePublicCategorySchema = z.enum(["image", "video"]);

/** 前端映射到项目内置且许可可追溯的品牌图标。 */
export const modelMarketplaceIconKeySchema = z.enum([
  "openai",
  "google",
  "bytedance",
  "kling",
  "runway",
  "xai",
  "generic",
]);

/** 服务端生成并持久化的封面对象引用，禁止直接进入管理或公开 DTO。 */
export const modelMarketplaceCoverRefSchema = z
  .object({
    bucket: z.string().trim().min(1).max(255),
    key: modelMarketplaceCoverObjectKeySchema,
  })
  .strict();

/**
 * 单个真实模型的模型广场与官网首页展示设置；价格仍在独立财务设置中。
 *
 * 首页字段保持可选以兼容既有 v2 JSON，读取层会按媒体类别补齐默认值。
 */
export const modelMarketplaceEntrySchema = z
  .object({
    revision: safeRevisionSchema,
    /** 可由管理员覆盖的品牌/厂商标识；旧配置缺失时由目录按模型 ID 推断。 */
    iconKey: modelMarketplaceIconKeySchema.optional(),
    enabled: z.boolean().optional(),
    visible: z.boolean(),
    homepageVisible: z.boolean().optional(),
    homepagePriority: modelMarketplaceHomepagePrioritySchema.optional(),
    description: descriptionSchema,
    cover: modelMarketplaceCoverRefSchema.nullable(),
    supportedResolutions: modelMarketplaceSupportedResolutionsSchema.optional(),
    /** 仅图像模型使用；仅为 true 时前端和执行管线才传 quality。 */
    supportsQuality: z.boolean().optional(),
    /** 图像模型参考图数量上限；缺失时沿用系统媒体策略。 */
    maxReferenceImages: nonnegativeSafeIntegerSchema.optional(),
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.homepageVisible && !entry.visible) {
      context.addIssue({
        code: "custom",
        path: ["homepageVisible"],
        message: "模型广场隐藏时不能展示在官网首页",
      });
    }
  });

/** 幂等重放所需的最小写回执，不保存用户 ID 或原始 clientRequestId。 */
export const modelMarketplaceWriteReceiptSchema = z
  .object({
    requestHash: sha256HexSchema,
    category: modelMarketplaceConfigurationCategorySchema,
    configKey: realModelConfigKeySchema,
    resultingRevision: safeRevisionSchema,
    completedAt: completedAtSchema,
  })
  .strict();

const marketplaceEntryRecordSchema = z
  .record(realModelConfigKeySchema, modelMarketplaceEntrySchema)
  .refine(
    (entries) => !Object.hasOwn(entries, "default"),
    "default 不能持久化展示设置"
  );
const writeReceiptRecordSchema = z
  .record(sha256HexSchema, modelMarketplaceWriteReceiptSchema)
  .refine(
    (receipts) =>
      Object.keys(receipts).length <= MAX_MODEL_MARKETPLACE_WRITE_RECEIPTS,
    `写回执最多保留 ${MAX_MODEL_MARKETPLACE_WRITE_RECEIPTS} 条`
  );

/** 旧版 v1 写回执只用于读取迁移，fallback 回执在迁移时直接丢弃。 */
const legacyModelMarketplaceWriteReceiptSchema = z
  .object({
    requestHash: sha256HexSchema,
    category: z.enum(["image", "video", "fallback"]),
    configKey: configKeySchema,
    resultingRevision: safeRevisionSchema,
    completedAt: completedAtSchema,
  })
  .strict();
const legacyWriteReceiptRecordSchema = z
  .record(sha256HexSchema, legacyModelMarketplaceWriteReceiptSchema)
  .refine(
    (receipts) =>
      Object.keys(receipts).length <= MAX_MODEL_MARKETPLACE_WRITE_RECEIPTS,
    `写回执最多保留 ${MAX_MODEL_MARKETPLACE_WRITE_RECEIPTS} 条`
  );

type MarketplaceEntriesWithCovers = {
  imageByModel: Record<string, ModelMarketplaceEntry>;
  videoByFamily: Record<string, ModelMarketplaceEntry>;
};

/**
 * 校验图像与视频封面对象 key 的命名空间。
 *
 * @param config - 已完成基础结构解析的模型展示记录。
 * @param context - Zod 精细校验上下文；发现跨类别 key 时追加错误。
 * @returns 无返回值；只通过上下文报告错误，不修改输入。
 */
function addCoverNamespaceIssues(
  config: MarketplaceEntriesWithCovers,
  context: z.RefinementCtx
): void {
  for (const [configKey, entry] of Object.entries(config.imageByModel)) {
    if (!entry.cover || entry.cover.key.startsWith("image/")) continue;
    context.addIssue({
      code: "custom",
      path: ["imageByModel", configKey, "cover", "key"],
      message: "图像模型封面必须位于 image 命名空间",
    });
  }
  for (const [configKey, entry] of Object.entries(config.videoByFamily)) {
    if (!entry.cover || entry.cover.key.startsWith("video/")) continue;
    context.addIssue({
      code: "custom",
      path: ["videoByFamily", configKey, "cover", "key"],
      message: "视频模型封面必须位于 video 命名空间",
    });
  }
}

/** 当前版本模型广场配置；只持久化真实模型条目与真实模型写回执。 */
export const modelMarketplaceConfigSchema = z
  .object({
    version: z.literal(MODEL_MARKETPLACE_CONFIG_VERSION),
    imageByModel: marketplaceEntryRecordSchema,
    videoByFamily: marketplaceEntryRecordSchema,
    customModels: modelMarketplaceCustomModelsSchema.default(() => []),
    writeReceipts: writeReceiptRecordSchema.default(() => ({})),
  })
  .strict()
  .superRefine(addCoverNamespaceIssues);

/** 仅供读取迁移的 v1 配置，保留已删除的 default 价格修订号与 fallback 回执。 */
const legacyModelMarketplaceConfigSchema = z
  .object({
    version: z.literal(1),
    fallbackImagePricingRevision: safeRevisionSchema,
    imageByModel: marketplaceEntryRecordSchema,
    videoByFamily: marketplaceEntryRecordSchema,
    writeReceipts: legacyWriteReceiptRecordSchema.default(() => ({})),
  })
  .strict()
  .superRefine(addCoverNamespaceIssues);

/**
 * 创建相互隔离的当前版本空配置。
 *
 * @returns 所有记录均为新对象的默认配置，真实模型缺少条目时由目录规则解释为默认展示。
 */
export function createDefaultModelMarketplaceConfig(): ModelMarketplaceConfig {
  return {
    version: MODEL_MARKETPLACE_CONFIG_VERSION,
    imageByModel: {},
    videoByFamily: {},
    customModels: [],
    writeReceipts: {},
  };
}

/** 读取旧配置时丢弃已废弃的 auto 尺寸能力，不重新暴露到当前契约。 */
function omitDeprecatedAutoSizeCapability(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { supportsAutoSize: _deprecated, ...rest } = value as Record<
    string,
    unknown
  >;
  return rest;
}

/** 仅清理历史持久化位置；其他未知字段仍由当前 strict schema 拒绝。 */
function migrateDeprecatedAutoSizeCapability(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const config = value as Record<string, unknown>;
  const migrateEntries = (entries: unknown): unknown => {
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
      return entries;
    }
    return Object.fromEntries(
      Object.entries(entries).map(([key, entry]) => [
        key,
        omitDeprecatedAutoSizeCapability(entry),
      ])
    );
  };
  return {
    ...config,
    ...(Object.hasOwn(config, "imageByModel")
      ? { imageByModel: migrateEntries(config.imageByModel) }
      : {}),
    ...(Object.hasOwn(config, "videoByFamily")
      ? { videoByFamily: migrateEntries(config.videoByFamily) }
      : {}),
    ...(Array.isArray(config.customModels)
      ? {
          customModels: config.customModels.map(
            omitDeprecatedAutoSizeCapability
          ),
        }
      : {}),
  };
}

/**
 * 收窄系统设置中的模型广场配置。
 *
 * @param value - 数据库读取出的未知 JSON；null 或 undefined 代表设置尚未初始化。
 * @returns 缺失时返回默认配置；v1 配置会升级并丢弃 default 修订号和 fallback 回执。
 * @throws ZodError - 配置不属于当前版本或合法 v1 时显式失败，避免静默放宽边界。
 */
export function parseModelMarketplaceConfig(
  value: unknown
): ModelMarketplaceConfig {
  if (value === null || value === undefined) {
    return createDefaultModelMarketplaceConfig();
  }
  if (
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1
  ) {
    return modelMarketplaceConfigSchema.parse(
      migrateDeprecatedAutoSizeCapability(value)
    );
  }

  const legacy = legacyModelMarketplaceConfigSchema.parse(
    migrateDeprecatedAutoSizeCapability(value)
  );
  const migratedReceipts = Object.fromEntries(
    Object.entries(legacy.writeReceipts).flatMap(([key, receipt]) => {
      if (
        receipt.category === "fallback" ||
        receipt.configKey.toLowerCase() === "default"
      ) {
        return [];
      }
      return [[key, receipt]];
    })
  );
  return modelMarketplaceConfigSchema.parse({
    version: MODEL_MARKETPLACE_CONFIG_VERSION,
    imageByModel: legacy.imageByModel,
    videoByFamily: legacy.videoByFamily,
    customModels: [],
    writeReceipts: migratedReceipts,
  });
}

/** 判断 URL 文本是否包含反斜杠或 ASCII 控制字符。 */
function containsUnsafeUrlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return character === "\\" || codePoint <= 31 || codePoint === 127;
  });
}

const firstPartyCoverUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine(
    (value) =>
      value.startsWith("/") &&
      !value.startsWith("//") &&
      !containsUnsafeUrlCharacter(value),
    "封面必须使用第一方相对 URL"
  );

const managementCommonShape = {
  configKey: configKeySchema,
  displayName: z.string().trim().min(1).max(160),
  iconKey: modelMarketplaceIconKeySchema.optional(),
  revision: safeRevisionSchema,
  /** 自定义模型允许删除；内置模型由服务端固定为 false。 */
  isCustom: z.boolean().optional(),
};
const managementMarketplaceShape = {
  ...managementCommonShape,
  configKey: realModelConfigKeySchema,
  marketplaceApplicable: z.literal(true),
  enabled: z.boolean(),
  visible: z.boolean(),
  homepageVisible: z.boolean(),
  homepagePriority: modelMarketplaceHomepagePrioritySchema,
  description: descriptionSchema,
  coverUrl: firstPartyCoverUrlSchema.nullable(),
  usesDefaultCover: z.boolean(),
};

/**
 * 校验声明支持的分辨率与价格矩阵键完全一致。
 *
 * @param value - 管理或公开视频 DTO 的最小分辨率字段。
 * @param context - Zod 精细校验上下文。
 * @sideEffects 不修改输入；集合不一致时追加字段错误。
 * @failure 不抛错，由 Zod 汇总错误。
 */
function addVideoResolutionPricingIssues(
  value: {
    supportedResolutions: string[];
    creditsPerSecondByResolution: Record<string, number>;
    creditsPerItemByResolution?: Record<string, number> | undefined;
  },
  context: z.RefinementCtx
): void {
  const supported = [...new Set(value.supportedResolutions)].sort();
  const priced = Object.keys(value.creditsPerSecondByResolution).sort();
  if (
    supported.length !== priced.length ||
    !supported.every((resolution, index) => resolution === priced[index])
  ) {
    context.addIssue({
      code: "custom",
      path: ["creditsPerSecondByResolution"],
      message: "视频分辨率价格必须完整覆盖支持的分辨率",
    });
  }
  if (value.creditsPerItemByResolution !== undefined) {
    const itemKeys = Object.keys(value.creditsPerItemByResolution).sort();
    if (
      supported.length !== itemKeys.length ||
      !supported.every((resolution, index) => resolution === itemKeys[index])
    ) {
      context.addIssue({
        code: "custom",
        path: ["creditsPerItemByResolution"],
        message: "视频按条价格必须完整覆盖支持的分辨率",
      });
    }
  }
}

/**
 * 阻止公开视频模型身份退化为内部组合路由 ID。
 *
 * @param value - 已解析的视频公开 DTO 身份字段。
 * @param context - Zod 精细校验上下文；身份不一致时追加 modelId 错误。
 * @returns 无返回值；只报告错误，不修改输入。
 * @sideEffects 无。
 * @failure 不抛错，由 Zod 汇总错误。
 */
function addPublicVideoIdentityIssues(
  value: { configKey: string; modelId: string },
  context: z.RefinementCtx
): void {
  // WHY：视频路由会把时长、比例和分辨率展开成组合 ID；公开身份必须保持为定价模型键。
  if (value.modelId === value.configKey) return;
  context.addIssue({
    code: "custom",
    path: ["modelId"],
    message: "公开视频模型 ID 必须与定价配置键一致",
  });
}

const explicitImageConfigurationEntrySchema = z
  .object({
    ...managementMarketplaceShape,
    category: z.literal("image"),
    pricingSource: z.literal("explicit"),
    minimumCredits: z.number().finite().positive(),
    pricing: modelMarketplaceImagePricingSchema,
    supportedResolutions: modelMarketplaceSupportedResolutionsSchema.optional(),
    supportsQuality: z.boolean().optional(),
    maxReferenceImages: nonnegativeSafeIntegerSchema.optional(),
  })
  .strict();
const unconfiguredImageConfigurationEntrySchema = z
  .object({
    ...managementMarketplaceShape,
    category: z.literal("image"),
    pricingSource: z.literal("unconfigured"),
    supportedResolutions: modelMarketplaceSupportedResolutionsSchema.optional(),
    supportsQuality: z.boolean().optional(),
    maxReferenceImages: nonnegativeSafeIntegerSchema.optional(),
  })
  .strict();
const videoConfigurationEntrySchema = z
  .object({
    ...managementMarketplaceShape,
    category: z.literal("video"),
    minimumCredits: z.number().finite().positive(),
    billingMode: videoBillingModeSchema,
    creditsPerSecond: z
      .number()
      .finite()
      .positive()
      .max(MAX_VIDEO_CREDITS_PER_SECOND),
    creditsPerSecondByResolution: videoCreditsPerSecondByResolutionSchema,
    creditsPerItemByResolution: videoModelCreditPricesSchema,
    supportedResolutions: z
      .array(modelMarketplaceSupportedResolutionSchema)
      .min(1)
      .max(20),
    maxReferenceImages: positiveSafeIntegerSchema.optional(),
  })
  .strict()
  .superRefine(addVideoResolutionPricingIssues);

/** 管理列表中的单条模型配置 DTO，不包含 bucket 或对象 key。 */
export const modelConfigurationEntrySchema = z.union([
  explicitImageConfigurationEntrySchema,
  unconfiguredImageConfigurationEntrySchema,
  videoConfigurationEntrySchema,
]);

/** 管理端完整读取快照，权限由服务端按真实 Principal 计算。 */
export const modelConfigurationSnapshotSchema = z
  .object({
    canEdit: z.boolean(),
    runtimeCatalogStatus: z.enum(["ready", "unavailable"]),
    entries: z.array(modelConfigurationEntrySchema).max(500),
  })
  .strict();

const publicCommonShape = {
  configKey: realModelConfigKeySchema,
  modelId: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .transform((modelId) => normalizeSupportedModelId(modelId) ?? modelId),
  displayName: z.string().trim().min(1).max(160),
  iconKey: modelMarketplaceIconKeySchema,
  description: descriptionSchema,
  coverUrl: firstPartyCoverUrlSchema,
  minimumCredits: z.number().finite().positive(),
  homepageVisible: z.boolean(),
  homepagePriority: modelMarketplaceHomepagePrioritySchema,
};

const publicImageItemSchema = z
  .object({
    ...publicCommonShape,
    category: z.literal("image"),
    priceUnit: z.literal("per_image"),
    pricing: modelMarketplaceImagePricingSchema,
    supportedResolutions: modelMarketplaceSupportedResolutionsSchema.optional(),
    supportsQuality: z.boolean().optional(),
    maxReferenceImages: nonnegativeSafeIntegerSchema.optional(),
  })
  .strict();
const publicVideoCommonShape = {
  ...publicCommonShape,
  category: z.literal("video"),
  supportedDurations: z.array(z.number().int().positive()).max(100),
  supportedAspectRatios: z.array(z.string().trim().min(1).max(32)).max(100),
  supportedResolutions: z.array(z.string().trim().min(1).max(32)).max(100),
  input: z
    .object({
      frames: videoFrameInputCapabilitySchema,
      referenceImages: z
        .object({
          maxCount: z.number().int().nonnegative(),
          configurable: z.boolean(),
        })
        .strict(),
      framesAndReferencesMutuallyExclusive: z.boolean(),
    })
    .strict(),
  audio: z
    .object({
      supported: z.boolean(),
      defaultEnabled: z.boolean(),
    })
    .strict(),
  configuredReachable: z.boolean(),
  infrastructureLimits: z
    .object({
      maxMediaInputCount: z.literal(MAX_MEDIA_INPUT_COUNT),
      maxMediaInputBytes: z.literal(MAX_MEDIA_INPUT_BYTES),
    })
    .strict(),
};

/** 校验公开视频当前模式的价格矩阵完整覆盖全部支持分辨率。 */
function addPublicVideoResolutionPricingIssues(
  value: {
    supportedResolutions: string[];
    priceUnit: "per_second" | "per_item";
    creditsPerSecondByResolution?: Record<string, number>;
    creditsPerItemByResolution?: Record<string, number>;
  },
  context: z.RefinementCtx
): void {
  const prices =
    value.priceUnit === "per_second"
      ? value.creditsPerSecondByResolution
      : value.creditsPerItemByResolution;
  const supported = [...new Set(value.supportedResolutions)].sort();
  const priced = Object.keys(prices ?? {}).sort();
  if (
    supported.length !== priced.length ||
    !supported.every((resolution, index) => resolution === priced[index])
  ) {
    context.addIssue({
      code: "custom",
      path: [
        value.priceUnit === "per_second"
          ? "creditsPerSecondByResolution"
          : "creditsPerItemByResolution",
      ],
      message: "视频当前模式价格必须完整覆盖支持的分辨率",
    });
  }
}

const publicPerSecondVideoItemSchema = z
  .object({
    ...publicVideoCommonShape,
    billingMode: z.literal("per_second"),
    priceUnit: z.literal("per_second"),
    creditsPerSecond: z
      .number()
      .finite()
      .positive()
      .max(MAX_VIDEO_CREDITS_PER_SECOND),
    creditsPerSecondByResolution: videoCreditsPerSecondByResolutionSchema,
  })
  .strict()
  .superRefine(addPublicVideoResolutionPricingIssues)
  .superRefine(addPublicVideoIdentityIssues);

const publicPerItemVideoItemSchema = z
  .object({
    ...publicVideoCommonShape,
    billingMode: z.literal("per_item"),
    priceUnit: z.literal("per_item"),
    creditsPerItem: z
      .number()
      .finite()
      .positive()
      .max(MAX_VIDEO_CREDITS_PER_SECOND),
    creditsPerItemByResolution: videoModelCreditPricesSchema,
  })
  .strict()
  .superRefine(addPublicVideoResolutionPricingIssues)
  .superRefine(addPublicVideoIdentityIssues);

const publicVideoItemSchema = z.discriminatedUnion("priceUnit", [
  publicPerSecondVideoItemSchema,
  publicPerItemVideoItemSchema,
]);

/** 公开模型广场的图像或视频判别联合 DTO。 */
export const modelMarketplacePublicItemSchema = z.union([
  publicImageItemSchema,
  publicVideoItemSchema,
]);

/** 封面保存动作；replace 只接受 multipart 适配器交付的原始字节。 */
export const modelMarketplaceCoverChangeSchema = z.discriminatedUnion(
  "action",
  [
    z.object({ action: z.literal("keep") }).strict(),
    z.object({ action: z.literal("remove") }).strict(),
    z
      .object({
        action: z.literal("replace"),
        bytes: z
          .instanceof(Uint8Array)
          .refine((bytes) => bytes.byteLength > 0, "封面文件不能为空")
          .refine(
            (bytes) => bytes.byteLength <= MAX_MODEL_MARKETPLACE_COVER_BYTES,
            "封面原文件不能超过 5 MB"
          ),
      })
      .strict(),
  ]
);

const updateCommonShape = {
  clientRequestId: z.string().uuid(),
  configKey: realModelConfigKeySchema,
  expectedRevision: safeRevisionSchema,
  isCustom: z.boolean().optional(),
};
const updateMarketplaceShape = {
  ...updateCommonShape,
  configKey: realModelConfigKeySchema,
  enabled: z.boolean(),
  visible: z.boolean(),
  homepageVisible: z.boolean(),
  homepagePriority: modelMarketplaceHomepagePrioritySchema,
  description: descriptionSchema,
  coverChange: modelMarketplaceCoverChangeSchema,
  iconKey: modelMarketplaceIconKeySchema.optional(),
};

const updateImageConfigurationInputSchema = z
  .object({
    ...updateMarketplaceShape,
    category: z.literal("image"),
    pricing: modelMarketplaceImagePricingSchema,
    supportedResolutions: modelMarketplaceSupportedResolutionsSchema.optional(),
    supportsQuality: z.boolean().optional(),
    maxReferenceImages: nonnegativeSafeIntegerSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.homepageVisible && !input.visible) {
      context.addIssue({
        code: "custom",
        path: ["homepageVisible"],
        message: "模型广场隐藏时不能展示在官网首页",
      });
    }
    if (input.isCustom === true) {
      if (
        !modelMarketplaceCustomModelIdSchema.safeParse(input.configKey).success
      ) {
        context.addIssue({
          code: "custom",
          path: ["configKey"],
          message: "自定义模型 ID 无效",
        });
      }
      if (!input.supportedResolutions) {
        context.addIssue({
          code: "custom",
          path: ["supportedResolutions"],
          message: "自定义图像模型必须声明支持的分辨率",
        });
      }
    } else if (
      input.supportedResolutions?.includes("8k") &&
      input.pricing.base8kCredits === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["pricing", "base8kCredits"],
        message: "启用 8K 图片分辨率时必须配置 8K 价格",
      });
    }
  });
const updateVideoConfigurationInputSchema = z
  .object({
    ...updateMarketplaceShape,
    category: z.literal("video"),
    billingMode: videoBillingModeSchema,
    creditsPerSecondByResolution: videoCreditsPerSecondByResolutionSchema,
    creditsPerItemByResolution: videoModelCreditPricesSchema,
    supportedResolutions: modelMarketplaceSupportedResolutionsSchema.optional(),
    outputSizesByResolution:
      modelMarketplaceVideoOutputSizesByResolutionSchema.optional(),
    maxReferenceImages: positiveSafeIntegerSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.supportedResolutions &&
      input.isCustom !== true &&
      input.supportedResolutions.some(
        (resolution) =>
          !(VIDEO_RESOLUTIONS as readonly string[]).includes(resolution)
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["supportedResolutions"],
        message: "内置视频模型只能使用预设分辨率",
      });
    }
    const supported = Object.keys(input.creditsPerSecondByResolution).sort();
    const item = Object.keys(input.creditsPerItemByResolution).sort();
    if (
      supported.length !== item.length ||
      !supported.every((key, index) => key === item[index])
    ) {
      context.addIssue({
        code: "custom",
        path: ["creditsPerItemByResolution"],
        message: "视频按条价格必须完整覆盖按秒价格的分辨率",
      });
    }
    if (input.homepageVisible && !input.visible) {
      context.addIssue({
        code: "custom",
        path: ["homepageVisible"],
        message: "模型广场隐藏时不能展示在官网首页",
      });
    }
    if (
      input.isCustom === true &&
      !modelMarketplaceCustomModelIdSchema.safeParse(input.configKey).success
    ) {
      context.addIssue({
        code: "custom",
        path: ["configKey"],
        message: "自定义模型 ID 无效",
      });
    }
    if (
      input.isCustom !== true &&
      input.outputSizesByResolution !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["outputSizesByResolution"],
        message: "输出像素映射只适用于自定义视频模型",
      });
    }
    if (input.isCustom === true && input.maxReferenceImages !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["maxReferenceImages"],
        message: "自定义视频模型当前只支持纯文本输入",
      });
    }
  });

/** 单模型配置保存输入；图像写入必须一次提交完整四档显式价格。 */
export const updateModelConfigurationEntryInputSchema = z.union([
  updateImageConfigurationInputSchema,
  updateVideoConfigurationInputSchema,
]);

/** 单模型保存的最小输出，客户端须重新读取快照获得完整派生字段。 */
export const updateModelConfigurationEntryOutputSchema = z
  .object({
    category: modelMarketplaceConfigurationCategorySchema,
    configKey: realModelConfigKeySchema,
    revision: safeRevisionSchema,
  })
  .strict();

/** 仅允许删除自定义模型的请求；服务端仍会按目录和配置再次确认归属。 */
export const deleteModelConfigurationEntryInputSchema = z
  .object({
    clientRequestId: z.string().uuid(),
    category: modelMarketplaceConfigurationCategorySchema,
    configKey: realModelConfigKeySchema,
    expectedRevision: safeRevisionSchema,
  })
  .strict();

/** 删除模型后的最小结果；客户端应重新读取分页快照。 */
export const deleteModelConfigurationEntryOutputSchema = z
  .object({
    category: modelMarketplaceConfigurationCategorySchema,
    configKey: realModelConfigKeySchema,
  })
  .strict();

export type ModelMarketplaceConfigurationCategory = z.infer<
  typeof modelMarketplaceConfigurationCategorySchema
>;
export type ModelMarketplaceCustomModel = z.infer<
  typeof modelMarketplaceCustomModelSchema
>;
export type ModelMarketplaceSupportedResolution = z.infer<
  typeof modelMarketplaceSupportedResolutionSchema
>;
export type ModelMarketplaceCategory = ModelMarketplaceConfigurationCategory;
export type ModelMarketplacePublicCategory = z.infer<
  typeof modelMarketplacePublicCategorySchema
>;
export type ModelMarketplaceIconKey = z.infer<
  typeof modelMarketplaceIconKeySchema
>;
export type ModelMarketplaceCoverRef = z.infer<
  typeof modelMarketplaceCoverRefSchema
>;
export type ModelMarketplaceEntry = z.infer<typeof modelMarketplaceEntrySchema>;
export type ModelMarketplaceWriteReceipt = z.infer<
  typeof modelMarketplaceWriteReceiptSchema
>;
export type ModelMarketplaceConfig = z.infer<
  typeof modelMarketplaceConfigSchema
>;
export type ModelMarketplaceImagePricing = z.infer<
  typeof modelMarketplaceImagePricingSchema
>;
export type ModelConfigurationEntry = z.infer<
  typeof modelConfigurationEntrySchema
>;
export type ModelConfigurationSnapshot = z.infer<
  typeof modelConfigurationSnapshotSchema
>;
export type ModelMarketplacePublicItem = z.infer<
  typeof modelMarketplacePublicItemSchema
>;
export type ModelMarketplaceCoverChange = z.infer<
  typeof modelMarketplaceCoverChangeSchema
>;
export type UpdateModelConfigurationEntryInput = z.infer<
  typeof updateModelConfigurationEntryInputSchema
>;
export type UpdateModelConfigurationEntryOutput = z.infer<
  typeof updateModelConfigurationEntryOutputSchema
>;
export type DeleteModelConfigurationEntryInput = z.infer<
  typeof deleteModelConfigurationEntryInputSchema
>;
export type DeleteModelConfigurationEntryOutput = z.infer<
  typeof deleteModelConfigurationEntryOutputSchema
>;
