/**
 * 模型广场配置与传输对象的唯一共享契约。
 *
 * 使用方包括系统设置、UOL operation、管理端和公开模型页面。本模块只负责 DB-free 的
 * 结构校验与类型收窄，不读取数据库、不构造存储 URL，也不执行价格或封面写入。
 */
import { z } from "zod";

import {
  MAX_VIDEO_CREDITS_PER_SECOND,
  videoCreditsPerSecondByResolutionSchema,
} from "../adobe/video-pricing";
import { imageCreditPricingSchema } from "../image-backend/group-image-pricing";
import { normalizeSupportedModelId } from "../image-backend/supported-models";
import {
  MAX_MEDIA_INPUT_BYTES,
  MAX_MEDIA_INPUT_COUNT,
} from "../image-generation/media-limits";
import { videoFrameInputCapabilitySchema } from "../video-generation";

export const MODEL_MARKETPLACE_CONFIG_VERSION = 2 as const;
export const MAX_MODEL_MARKETPLACE_DESCRIPTION_LENGTH = 200;
export const MAX_MODEL_MARKETPLACE_CONFIG_KEY_LENGTH = 120;
export const MAX_MODEL_MARKETPLACE_WRITE_RECEIPTS = 256;
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
const configKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_MODEL_MARKETPLACE_CONFIG_KEY_LENGTH);
const realModelConfigKeySchema = configKeySchema.refine(
  (configKey) => configKey.toLowerCase() !== "default",
  "default 不是可配置模型"
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
export const modelMarketplaceImagePricingSchema =
  imageCreditPricingSchema.required();

/** 模型广场支持的真实模型类别。 */
export const modelMarketplaceConfigurationCategorySchema = z.enum([
  "image",
  "video",
]);

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
    visible: z.boolean(),
    homepageVisible: z.boolean().optional(),
    homepagePriority: modelMarketplaceHomepagePrioritySchema.optional(),
    description: descriptionSchema,
    cover: modelMarketplaceCoverRefSchema.nullable(),
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
    writeReceipts: {},
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
    return modelMarketplaceConfigSchema.parse(value);
  }

  const legacy = legacyModelMarketplaceConfigSchema.parse(value);
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
  iconKey: modelMarketplaceIconKeySchema,
  revision: safeRevisionSchema,
};
const managementMarketplaceShape = {
  ...managementCommonShape,
  configKey: realModelConfigKeySchema,
  marketplaceApplicable: z.literal(true),
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
  },
  context: z.RefinementCtx
): void {
  const supported = [...new Set(value.supportedResolutions)].sort();
  const priced = Object.keys(value.creditsPerSecondByResolution).sort();
  if (
    supported.length === priced.length &&
    supported.every((resolution, index) => resolution === priced[index])
  ) {
    return;
  }
  context.addIssue({
    code: "custom",
    path: ["creditsPerSecondByResolution"],
    message: "视频分辨率价格必须完整覆盖支持的分辨率",
  });
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
  })
  .strict();
const unconfiguredImageConfigurationEntrySchema = z
  .object({
    ...managementMarketplaceShape,
    category: z.literal("image"),
    pricingSource: z.literal("unconfigured"),
  })
  .strict();
const videoConfigurationEntrySchema = z
  .object({
    ...managementMarketplaceShape,
    category: z.literal("video"),
    minimumCredits: z.number().finite().positive(),
    creditsPerSecond: z
      .number()
      .finite()
      .positive()
      .max(MAX_VIDEO_CREDITS_PER_SECOND),
    creditsPerSecondByResolution: videoCreditsPerSecondByResolutionSchema,
    supportedResolutions: z
      .array(z.string().trim().min(1).max(32))
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
  })
  .strict();
const publicVideoItemSchema = z
  .object({
    ...publicCommonShape,
    category: z.literal("video"),
    priceUnit: z.literal("per_second"),
    creditsPerSecond: z
      .number()
      .finite()
      .positive()
      .max(MAX_VIDEO_CREDITS_PER_SECOND),
    creditsPerSecondByResolution: videoCreditsPerSecondByResolutionSchema,
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
  })
  .strict()
  .superRefine(addVideoResolutionPricingIssues)
  .superRefine(addPublicVideoIdentityIssues);

/** 公开模型广场的图像或视频判别联合 DTO。 */
export const modelMarketplacePublicItemSchema = z.discriminatedUnion(
  "category",
  [publicImageItemSchema, publicVideoItemSchema]
);

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
};
const updateMarketplaceShape = {
  ...updateCommonShape,
  configKey: realModelConfigKeySchema,
  visible: z.boolean(),
  homepageVisible: z.boolean(),
  homepagePriority: modelMarketplaceHomepagePrioritySchema,
  description: descriptionSchema,
  coverChange: modelMarketplaceCoverChangeSchema,
};

const updateImageConfigurationInputSchema = z
  .object({
    ...updateMarketplaceShape,
    category: z.literal("image"),
    pricing: modelMarketplaceImagePricingSchema,
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
  });
const updateVideoConfigurationInputSchema = z
  .object({
    ...updateMarketplaceShape,
    category: z.literal("video"),
    creditsPerSecondByResolution: videoCreditsPerSecondByResolutionSchema,
    maxReferenceImages: positiveSafeIntegerSchema.optional(),
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

export type ModelMarketplaceConfigurationCategory = z.infer<
  typeof modelMarketplaceConfigurationCategorySchema
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
