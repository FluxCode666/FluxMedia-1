/**
 * 用户图库的共享 UOL 契约。
 *
 * 使用方：图库读取 operation、Web 查询服务与无限滚动客户端。调用方只能提交页签
 * 和不透明分页边界，用户作用域来自 Principal；输出仅暴露安全卡片 DTO 和下一边界。
 */

import { z } from "zod";
import { historyReferenceImageSchema } from "./history-contract";

/** 图库支持的三个独立浏览页签。 */
export const galleryTabSchema = z.enum(["final", "uploads", "videos"]);

/** 图库读取输入；身份字段会被 strict 拒绝，防止调用方扩大数据作用域。 */
export const galleryListInputSchema = z
  .object({
    cursor: z.string().min(1).max(4096).nullable().default(null),
    limit: z.number().int().min(1).max(50).default(20),
    tab: galleryTabSchema.default("final"),
  })
  .strict();

const isoDateTimeSchema = z.string().datetime({ offset: true });

/** 图片与视频卡片共有的展示字段，不包含存储桶、存储键或用户身份。 */
const galleryItemCommonSchema = z.object({
  id: z.string().min(1).max(512),
  parentId: z.string().min(1).max(512),
  prompt: z.string(),
  model: z.string().min(1).max(240),
  size: z.string().min(1).max(200),
  status: z.literal("completed"),
  creditsConsumed: z.number().finite().nonnegative(),
  createdAt: isoDateTimeSchema,
});

/** 图片卡片共有字段；资源地址由服务端按当前请求短期签发。 */
const galleryImageItemCommonSchema = galleryItemCommonSchema.extend({
  revisedPrompt: z.string().nullable(),
  promptRepairNotice: z.string().nullable(),
  imageUrl: z.string().min(1).nullable(),
  referenceImages: z.array(historyReferenceImageSchema).max(50),
});

/** 用户生成的最终图片卡片。 */
export const galleryFinalItemSchema = galleryImageItemCommonSchema
  .extend({ outputRole: z.literal("final") })
  .strict();

/** 单张用户上传图卡片；parentId 指向拥有该输入的 generation。 */
export const galleryUploadItemSchema = galleryImageItemCommonSchema
  .extend({ outputRole: z.literal("upload") })
  .strict();

/** 已完成视频卡片；视频地址和图片地址保持互斥。 */
export const galleryVideoItemSchema = galleryItemCommonSchema
  .extend({
    outputRole: z.literal("video"),
    videoUrl: z.string().min(1).nullable(),
  })
  .strict();

/** 三类图库卡片的判别联合。 */
export const galleryItemSchema = z.discriminatedUnion("outputRole", [
  galleryFinalItemSchema,
  galleryUploadItemSchema,
  galleryVideoItemSchema,
]);

/** 单批无限滚动输出；产品约束要求不得携带总数或已加载数量。 */
export const galleryListOutputSchema = z
  .object({
    items: z.array(galleryItemSchema).max(50),
    nextCursor: z.string().min(1).max(4096).nullable(),
  })
  .strict();

export type GalleryTab = z.infer<typeof galleryTabSchema>;
export type GalleryListInput = z.input<typeof galleryListInputSchema>;
export type GalleryItem = z.infer<typeof galleryItemSchema>;
export type GalleryListOutput = z.infer<typeof galleryListOutputSchema>;
