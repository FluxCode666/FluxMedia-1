/**
 * 统一生成历史的共享 UOL 契约。
 *
 * 使用方：个人与管理端历史记录 UOL、Web 查询服务和页面。调用方只能提交筛选与
 * 分页参数，查询作用域始终来自 Principal；图片和视频通过 kind 判别，避免混用专属字段。
 */

import { z } from "zod";
import { apiUpstreamRequestSnapshotSchema } from "../image-backend/api-upstream-script-contract";
import { videoTaskBillingSchema } from "../video-generation/public-billing";
import { MAX_MEDIA_INPUT_COUNT } from "./media-contract";

/** 历史记录产物类型。 */
export const historyRecordTypeSchema = z.enum(["image", "video"]);

/** 历史筛选可接受的状态；图片和视频输出由各自 schema 进一步收窄。 */
export const historyRecordStatusSchema = z.enum([
  "processing",
  "queued",
  "in_progress",
  "completed",
  "failed",
]);

/** 图片历史保留的既有三态。 */
export const imageHistoryStatusSchema = z.enum([
  "processing",
  "completed",
  "failed",
]);

/** 视频历史统一公开的四态。 */
export const videoHistoryStatusSchema = z.enum([
  "queued",
  "in_progress",
  "completed",
  "failed",
]);

/** 管理端精确筛选历史所属用户时使用的邮箱值。 */
export const adminHistoryUserEmailSchema = z.string().trim().email().max(320);

/** 校验 YYYY-MM-DD 同时确实是有效公历日期。 */
function isValidDateOnly(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** 用户时区中的自然日输入，不在共享层猜测 UTC 边界。 */
export const historyDateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isValidDateOnly, "Invalid calendar date");

/** cursor 必须绑定的全部筛选，筛选变化后旧 cursor 不可复用。 */
export const historyCursorFiltersSchema = z
  .object({
    createdFrom: historyDateOnlySchema.nullable().default(null),
    createdTo: historyDateOnlySchema.nullable().default(null),
    model: z.string().trim().min(1).max(240).nullable().default(null),
    status: historyRecordStatusSchema.nullable().default(null),
    type: historyRecordTypeSchema.nullable().default(null),
  })
  .strict()
  .refine(
    (value) =>
      !value.createdFrom ||
      !value.createdTo ||
      value.createdFrom <= value.createdTo,
    { message: "createdFrom must not be after createdTo", path: ["createdTo"] }
  );

const historyPageSizeSchema = z.number().int().min(1).max(50);

/**
 * 为历史输入兼容旧 limit，同时统一输出 pageSize。
 *
 * @param input 已通过严格字段校验的分页输入。
 * @returns pageSize 优先，旧调用方只传 limit 时平滑迁移；二者冲突会被拒绝。
 */
function resolveHistoryPaginationInput<
  T extends {
    cursor: string | null;
    limit?: number | undefined;
    page: number;
    pageSize?: number | undefined;
  },
>(input: T): Omit<T, "limit"> & { pageSize: number } {
  const { limit: _legacyLimit, ...safeInput } = input;
  return { ...safeInput, pageSize: input.pageSize ?? input.limit ?? 20 };
}

/** 本人历史列表输入；userId 等只读身份字段会被 strict 拒绝。 */
export const historyListInputSchema = historyCursorFiltersSchema
  .safeExtend({
    cursor: z.string().min(1).max(4096).nullable().default(null),
    limit: z.number().int().min(1).max(50).optional(),
    page: z.number().int().min(1).safe().default(1),
    pageSize: historyPageSizeSchema.optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.limit === undefined ||
      input.pageSize === undefined ||
      input.limit === input.pageSize,
    "limit 与 pageSize 必须一致"
  )
  .transform(resolveHistoryPaginationInput);

/** 管理端 cursor 绑定的完整筛选，额外包含精确用户邮箱。 */
export const adminHistoryCursorFiltersSchema = historyCursorFiltersSchema
  .safeExtend({
    userEmail: adminHistoryUserEmailSchema.nullable().default(null),
  })
  .strict();

/** 管理员全局历史列表输入；数据作用域和管理员身份不允许由调用方声明。 */
export const adminHistoryListInputSchema = adminHistoryCursorFiltersSchema
  .safeExtend({
    cursor: z.string().min(1).max(4096).nullable().default(null),
    limit: z.number().int().min(1).max(50).optional(),
    page: z.number().int().min(1).safe().default(1),
    pageSize: historyPageSizeSchema.optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.limit === undefined ||
      input.pageSize === undefined ||
      input.limit === input.pageSize,
    "limit 与 pageSize 必须一致"
  )
  .transform(resolveHistoryPaginationInput);

/** 管理员按记录类型与 ID 按需读取真实请求快照，避免把大字段塞入列表。 */
export const adminHistoryRequestSnapshotInputSchema = z
  .object({
    id: z.string().trim().min(1).max(512),
    kind: historyRecordTypeSchema,
  })
  .strict();

/** 管理端详情读取结果；旧记录或请求正文完成前失败时允许没有快照。 */
export const adminHistoryRequestSnapshotOutputSchema = z
  .object({
    id: z.string().min(1).max(512),
    kind: historyRecordTypeSchema,
    snapshot: apiUpstreamRequestSnapshotSchema.nullable(),
  })
  .strict();

const isoDateTimeSchema = z.string().datetime({ offset: true });

/** 图片积分结算快照的白名单字段，不直接暴露 generation.metadata。 */
export const historyCreditDetailsSchema = z
  .object({
    actualImageCredits: z.number().finite().nullable(),
    actualSize: z.string().nullable(),
    baseCredits: z.number().finite().nullable(),
    billableImageOutputCount: z.number().finite().nullable(),
    billingGroupId: z.string().nullable(),
    chatCredits: z.number().finite().nullable(),
    chatRoundCount: z.number().finite().nullable(),
    chatRoundCredits: z.number().finite().nullable(),
    imageModerationCount: z.number().finite().nullable(),
    mode: z.string().nullable(),
    moderationCredits: z.number().finite().nullable(),
    requestedSize: z.string().nullable(),
    requestedResolution: z.string().nullable(),
    settledResolution: z.string().nullable(),
    requestedTotalCredits: z.number().finite().nullable(),
    textModerationCount: z.number().finite().nullable(),
    totalCredits: z.number().finite().nonnegative(),
    upstreamImageOutputCount: z.number().finite().nullable(),
  })
  .strict();

/** Lightbox 所需的安全参考图字段；内部存储键和桶名不跨 UOL。 */
export const historyReferenceImageSchema = z
  .object({
    id: z.string().min(1).max(512),
    imageUrl: z.string().min(1),
    name: z.string().nullable(),
    type: z.string().nullable(),
    sizeBytes: z.number().finite().nonnegative().nullable(),
    source: z.string().min(1).max(100),
    role: z.string().min(1).max(100),
    index: z.number().int().nonnegative(),
  })
  .strict();

/** 视频列表可公开的具名输入摘要；实际 URL 只由 video.getInputs 按需签发。 */
export const historyVideoInputSummarySchema = z
  .object({
    mode: z.enum([
      "none",
      "first-frame",
      "first-last-frames",
      "references",
      "reference-videos",
      "reference-audio",
      "mixed",
    ]),
    count: z.number().int().min(0).max(MAX_MEDIA_INPUT_COUNT),
  })
  .strict();

/** 图片、视频共同拥有且可安全跨 UOL 边界的历史字段。 */
const historyRecordCommonSchema = z.object({
  id: z.string().min(1).max(512),
  prompt: z.string(),
  model: z.string().min(1).max(240),
  creditsConsumed: z.number().finite().nonnegative(),
  error: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.nullable(),
  processingDurationSeconds: z.number().int().nonnegative().nullable(),
});

/** 图片历史详情所需的结算元数据、尺寸与受控资源地址。 */
export const imageHistoryRecordSchema = historyRecordCommonSchema
  .extend({
    kind: z.literal("image"),
    status: imageHistoryStatusSchema,
    revisedPrompt: z.string().nullable(),
    size: z.string().min(1).max(200),
    creditDetails: historyCreditDetailsSchema.nullable(),
    promptRepairNotice: z.string().nullable(),
    referenceImages: z.array(historyReferenceImageSchema).max(50),
    imageUrl: z.string().nullable(),
  })
  .strict();

/** 视频历史详情所需的原生分辨率、时长、比例与受控资源地址。 */
export const videoHistoryRecordSchema = historyRecordCommonSchema
  .extend({
    kind: z.literal("video"),
    status: videoHistoryStatusSchema,
    resolution: z.string().min(1).max(100),
    duration: z.number().int().positive(),
    aspectRatio: z.string().min(1).max(100),
    generateAudio: z.boolean(),
    input: historyVideoInputSummarySchema,
    billing: videoTaskBillingSchema,
    videoUrl: z.string().nullable(),
  })
  .strict();

/** 统一历史记录判别联合。 */
export const historyRecordSchema = z.discriminatedUnion("kind", [
  imageHistoryRecordSchema,
  videoHistoryRecordSchema,
]);

/** 管理端可见的供应商账号身份；不包含凭据、地址或运行状态。 */
export const adminHistoryBackendAccountSchema = z
  .object({
    id: z.string().min(1).max(512),
    name: z.string().trim().min(1).max(240).nullable(),
  })
  .strict();

/** 管理端视频提交尝试的安全审计摘要；不包含正文、凭据或上游任务 ID。 */
export const adminHistoryVideoSubmissionAttemptSchema = z
  .object({
    attemptNumber: z.number().int().positive(),
    supplierName: z.string().trim().min(1).max(120),
    failureCode: z.string().min(1).max(64),
    failureReason: z.string().min(1).max(1000),
    operationsReason: z.string().min(1).max(1000),
    failedAt: isoDateTimeSchema,
  })
  .strict();

/** 管理端图片记录，附带所属用户和供应商账号的受控身份字段。 */
export const adminImageHistoryRecordSchema = imageHistoryRecordSchema
  .safeExtend({
    backendAccount: adminHistoryBackendAccountSchema.nullable(),
    userId: z.string().min(1).max(512),
    userEmail: adminHistoryUserEmailSchema,
  })
  .strict();

/** 管理端视频记录，附带所属用户和供应商账号的受控身份字段。 */
export const adminVideoHistoryRecordSchema = videoHistoryRecordSchema
  .safeExtend({
    backendAccount: adminHistoryBackendAccountSchema.nullable(),
    submissionAttempts: z
      .array(adminHistoryVideoSubmissionAttemptSchema)
      .max(100),
    userId: z.string().min(1).max(512),
    userEmail: adminHistoryUserEmailSchema,
  })
  .strict();

/** 管理端统一历史记录判别联合。 */
export const adminHistoryRecordSchema = z.discriminatedUnion("kind", [
  adminImageHistoryRecordSchema,
  adminVideoHistoryRecordSchema,
]);

/** 管理端邮箱筛选下拉的最小安全用户标识。 */
export const adminHistoryUserOptionSchema = z
  .object({
    id: z.string().min(1).max(512),
    email: adminHistoryUserEmailSchema,
  })
  .strict();

/** 有界 keyset 列表输出，并携带用户历史中真实出现过的模型选项。 */
export const historyListOutputSchema = z
  .object({
    asOf: isoDateTimeSchema,
    page: z.number().int().positive().safe(),
    pageSize: historyPageSizeSchema,
    totalCount: z.number().int().nonnegative().safe(),
    records: z.array(historyRecordSchema).max(50),
    modelOptions: z.array(z.string().min(1).max(240)).max(200),
    nextCursor: z.string().min(1).max(4096).nullable(),
    previousCursor: z.string().min(1).max(4096).nullable(),
  })
  .strict();

/** 管理端全局历史输出；仅管理员 UOL 可返回用户与供应商账号身份。 */
export const adminHistoryListOutputSchema = z
  .object({
    asOf: isoDateTimeSchema,
    page: z.number().int().positive().safe(),
    pageSize: historyPageSizeSchema,
    totalCount: z.number().int().nonnegative().safe(),
    records: z.array(adminHistoryRecordSchema).max(50),
    modelOptions: z.array(z.string().min(1).max(240)).max(200),
    userOptions: z.array(adminHistoryUserOptionSchema).max(200),
    nextCursor: z.string().min(1).max(4096).nullable(),
    previousCursor: z.string().min(1).max(4096).nullable(),
  })
  .strict();

export type HistoryRecordType = z.infer<typeof historyRecordTypeSchema>;
export type HistoryRecordStatus = z.infer<typeof historyRecordStatusSchema>;
export type HistoryCreditDetails = z.infer<typeof historyCreditDetailsSchema>;
export type HistoryReferenceImage = z.infer<typeof historyReferenceImageSchema>;
export type HistoryVideoInputSummary = z.infer<
  typeof historyVideoInputSummarySchema
>;
export type HistoryCursorFilters = z.infer<typeof historyCursorFiltersSchema>;
export type HistoryListInput = z.input<typeof historyListInputSchema>;
export type HistoryRecord = z.infer<typeof historyRecordSchema>;
export type HistoryListOutput = z.infer<typeof historyListOutputSchema>;
export type AdminHistoryListInput = z.input<typeof adminHistoryListInputSchema>;
export type AdminHistoryRequestSnapshotInput = z.input<
  typeof adminHistoryRequestSnapshotInputSchema
>;
export type AdminHistoryRequestSnapshotOutput = z.infer<
  typeof adminHistoryRequestSnapshotOutputSchema
>;
export type AdminHistoryVideoSubmissionAttempt = z.infer<
  typeof adminHistoryVideoSubmissionAttemptSchema
>;
export type AdminHistoryRecord = z.infer<typeof adminHistoryRecordSchema>;
export type AdminHistoryListOutput = z.infer<
  typeof adminHistoryListOutputSchema
>;
export type AdminHistoryUserOption = z.infer<
  typeof adminHistoryUserOptionSchema
>;
