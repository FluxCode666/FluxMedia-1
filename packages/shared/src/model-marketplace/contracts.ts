/**
 * 模型广场配置与传输对象的唯一共享契约。
 *
 * 使用方包括系统设置、UOL operation、管理端和公开模型页面。本模块只负责 DB-free 的
 * 结构校验与类型收窄，不读取数据库、不构造存储 URL，也不执行价格或封面写入。
 */
import { z } from "zod";

import { MAX_VIDEO_CREDITS_PER_SECOND } from "../adobe/video-pricing";
import { imageCreditPricingSchema } from "../image-backend/group-image-pricing";

export const MODEL_MARKETPLACE_CONFIG_VERSION = 1 as const;
export const MAX_MODEL_MARKETPLACE_DESCRIPTION_LENGTH = 200;
export const MAX_MODEL_MARKETPLACE_CONFIG_KEY_LENGTH = 120;
export const MAX_MODEL_MARKETPLACE_WRITE_RECEIPTS = 256;
export const MAX_MODEL_MARKETPLACE_COVER_BYTES = 5 * 1024 * 1024;

const safeRevisionSchema = z
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
  (configKey) => configKey !== "default",
  "default 不是可展示模型"
);
const descriptionSchema = z
  .string()
  .trim()
  .max(MAX_MODEL_MARKETPLACE_DESCRIPTION_LENGTH);
const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/i);
const completedAtSchema = z.string().datetime({ offset: true });

/** 图像模型四档完整价格；复用现有财务字段及单价上限。 */
export const modelMarketplaceImagePricingSchema =
  imageCreditPricingSchema.required();

/** 模型广场支持的持久化条目类别，fallback 仅代表图像价格兜底项。 */
export const modelMarketplaceConfigurationCategorySchema = z.enum([
  "image",
  "video",
  "fallback",
]);

/** 公开模型只允许图像与视频，不允许计费兜底项。 */
export const modelMarketplacePublicCategorySchema = z.enum(["image", "video"]);

/** 前端映射到项目内置且许可可追溯的品牌图标。 */
export const modelMarketplaceIconKeySchema = z.enum([
  "openai",
  "google",
  "kling",
  "xai",
  "generic",
]);

/** 服务端生成并持久化的封面对象引用，禁止直接进入管理或公开 DTO。 */
export const modelMarketplaceCoverRefSchema = z
  .object({
    bucket: z.string().trim().min(1).max(255),
    key: z.string().trim().min(1).max(1024),
  })
  .strict();

/** 单个真实模型的展示设置；价格继续存放在现有独立财务设置中。 */
export const modelMarketplaceEntrySchema = z
  .object({
    revision: safeRevisionSchema,
    visible: z.boolean(),
    description: descriptionSchema,
    cover: modelMarketplaceCoverRefSchema.nullable(),
  })
  .strict();

/** 幂等重放所需的最小写回执，不保存用户 ID 或原始 clientRequestId。 */
export const modelMarketplaceWriteReceiptSchema = z
  .object({
    requestHash: sha256HexSchema,
    category: modelMarketplaceConfigurationCategorySchema,
    configKey: configKeySchema,
    resultingRevision: safeRevisionSchema,
    completedAt: completedAtSchema,
  })
  .strict();

const marketplaceEntryRecordSchema = z
  .record(configKeySchema, modelMarketplaceEntrySchema)
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

/** 版本化模型广场配置；缺失 writeReceipts 兼容第一版配置初始化过程。 */
export const modelMarketplaceConfigSchema = z
  .object({
    version: z.literal(MODEL_MARKETPLACE_CONFIG_VERSION),
    fallbackImagePricingRevision: safeRevisionSchema,
    imageByModel: marketplaceEntryRecordSchema,
    videoByFamily: marketplaceEntryRecordSchema,
    writeReceipts: writeReceiptRecordSchema.default(() => ({})),
  })
  .strict();

/**
 * 创建相互隔离的版本 1 空配置。
 *
 * @returns 所有记录均为新对象的默认配置，真实模型缺少条目时由目录规则解释为默认展示。
 */
export function createDefaultModelMarketplaceConfig(): ModelMarketplaceConfig {
  return {
    version: MODEL_MARKETPLACE_CONFIG_VERSION,
    fallbackImagePricingRevision: 0,
    imageByModel: {},
    videoByFamily: {},
    writeReceipts: {},
  };
}

/**
 * 收窄系统设置中的模型广场配置。
 *
 * @param value - 数据库读取出的未知 JSON；null 或 undefined 代表设置尚未初始化。
 * @returns 缺失时返回新的默认配置，存在时必须完整通过严格 schema。
 * @throws ZodError - 已存在的配置是脏值时显式失败，避免静默放开展示范围。
 */
export function parseModelMarketplaceConfig(
  value: unknown
): ModelMarketplaceConfig {
  if (value === null || value === undefined) {
    return createDefaultModelMarketplaceConfig();
  }
  return modelMarketplaceConfigSchema.parse(value);
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
  minimumCredits: z.number().finite().positive(),
};
const managementMarketplaceShape = {
  ...managementCommonShape,
  configKey: realModelConfigKeySchema,
  marketplaceApplicable: z.literal(true),
  visible: z.boolean(),
  description: descriptionSchema,
  coverUrl: firstPartyCoverUrlSchema.nullable(),
  usesDefaultCover: z.boolean(),
};

const explicitImageConfigurationEntrySchema = z
  .object({
    ...managementMarketplaceShape,
    category: z.literal("image"),
    pricingSource: z.literal("explicit"),
    pricing: modelMarketplaceImagePricingSchema,
  })
  .strict();
const fallbackPricedImageConfigurationEntrySchema = z
  .object({
    ...managementMarketplaceShape,
    category: z.literal("image"),
    pricingSource: z.literal("fallback"),
    fallbackPricingRevision: safeRevisionSchema,
    pricing: modelMarketplaceImagePricingSchema,
  })
  .strict();
const videoConfigurationEntrySchema = z
  .object({
    ...managementMarketplaceShape,
    category: z.literal("video"),
    creditsPerSecond: z
      .number()
      .finite()
      .positive()
      .max(MAX_VIDEO_CREDITS_PER_SECOND),
  })
  .strict();
const fallbackImageConfigurationEntrySchema = z
  .object({
    ...managementCommonShape,
    category: z.literal("fallback"),
    configKey: z.literal("default"),
    marketplaceApplicable: z.literal(false),
    pricing: modelMarketplaceImagePricingSchema,
  })
  .strict();

/** 管理列表中的单条模型配置 DTO，不包含 bucket 或对象 key。 */
export const modelConfigurationEntrySchema = z.union([
  explicitImageConfigurationEntrySchema,
  fallbackPricedImageConfigurationEntrySchema,
  videoConfigurationEntrySchema,
  fallbackImageConfigurationEntrySchema,
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
  defaultModelId: z.string().trim().min(1).max(255),
  displayName: z.string().trim().min(1).max(160),
  iconKey: modelMarketplaceIconKeySchema,
  description: descriptionSchema,
  coverUrl: firstPartyCoverUrlSchema,
  minimumCredits: z.number().finite().positive(),
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
    supportedDurations: z.array(z.number().int().positive()).max(100),
    supportedAspectRatios: z.array(z.string().trim().min(1).max(32)).max(100),
    supportedResolutions: z.array(z.string().trim().min(1).max(32)).max(100),
  })
  .strict();

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
  configKey: configKeySchema,
  expectedRevision: safeRevisionSchema,
};
const updateMarketplaceShape = {
  ...updateCommonShape,
  configKey: realModelConfigKeySchema,
  visible: z.boolean(),
  description: descriptionSchema,
  coverChange: modelMarketplaceCoverChangeSchema,
};

const updateExplicitImageConfigurationInputSchema = z
  .object({
    ...updateMarketplaceShape,
    category: z.literal("image"),
    pricingSource: z.literal("explicit"),
    pricing: modelMarketplaceImagePricingSchema,
  })
  .strict();
const updateFallbackPricedImageConfigurationInputSchema = z
  .object({
    ...updateMarketplaceShape,
    category: z.literal("image"),
    pricingSource: z.literal("fallback"),
    expectedFallbackRevision: safeRevisionSchema,
    pricing: modelMarketplaceImagePricingSchema,
  })
  .strict();
const updateVideoConfigurationInputSchema = z
  .object({
    ...updateCommonShape,
    category: z.literal("video"),
    configKey: realModelConfigKeySchema,
    visible: z.boolean(),
    description: descriptionSchema,
    coverChange: modelMarketplaceCoverChangeSchema,
    creditsPerSecond: z
      .number()
      .finite()
      .positive()
      .max(MAX_VIDEO_CREDITS_PER_SECOND),
  })
  .strict();
const updateFallbackImagePricingInputSchema = z
  .object({
    ...updateCommonShape,
    category: z.literal("fallback"),
    configKey: z.literal("default"),
    pricing: modelMarketplaceImagePricingSchema,
  })
  .strict();

/** 单模型配置保存输入；联合分支保证 default 和显式价格不接收无关展示字段。 */
export const updateModelConfigurationEntryInputSchema = z.union([
  updateExplicitImageConfigurationInputSchema,
  updateFallbackPricedImageConfigurationInputSchema,
  updateVideoConfigurationInputSchema,
  updateFallbackImagePricingInputSchema,
]);

/** 单模型保存的最小输出，客户端须重新读取快照获得完整派生字段。 */
export const updateModelConfigurationEntryOutputSchema = z
  .object({
    category: modelMarketplaceConfigurationCategorySchema,
    configKey: configKeySchema,
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
