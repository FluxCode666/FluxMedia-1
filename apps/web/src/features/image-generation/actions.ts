"use server";

/**
 * 图片生成与媒体删除 Server Action 薄适配器。
 *
 * 使用方：创作页与画廊。输入经 Zod 校验后转发到 Go first-party API，Action 不直接
 * 访问数据库或对象存储。
 */
import {
  type GalleryListOutput,
  galleryListInputSchema,
} from "@repo/shared/image-generation/gallery-contract";
import { imageModelIdSchema } from "@repo/shared/image-generation/model-contract";
import { protectedAction } from "@repo/shared/safe-action";
import { z } from "zod";
import { requestGoJson } from "@/server/go-backend-client";
import {
  IMAGE_PROMPT_MAX_CHARACTERS,
  IMAGE_PROMPT_TOO_LONG_MESSAGE,
} from "./resolution";

const generateImageSchema = z
  .object({
    prompt: z
      .string()
      .min(1)
      .max(IMAGE_PROMPT_MAX_CHARACTERS, IMAGE_PROMPT_TOO_LONG_MESSAGE),
    aspectRatio: z.string().trim().min(1).max(64).optional(),
    aspect_ratio: z.string().trim().min(1).max(64).optional(),
    resolution: z.string().trim().min(1).max(64).optional(),
    model: imageModelIdSchema,
  })
  .strict();

/** 创建单次图片生成任务并委托 Go 图片任务接口。 */
export const generateImageAction = protectedAction
  .metadata({ action: "image-generation.generate" })
  .schema(generateImageSchema)
  .action(async ({ parsedInput, ctx }) => {
    void ctx;
    return requestGoJson<{
      id: string;
      taskId?: string;
      generationId: string;
      generation_id?: string;
      model: string;
      status: string;
      created?: number;
      created_at?: string;
      imageUrl?: string;
      imageOutputs?: Array<Record<string, unknown>>;
    }>("/api/images/generate", {
      method: "POST",
      body: JSON.stringify({
        prompt: parsedInput.prompt,
        aspectRatio: parsedInput.aspectRatio ?? parsedInput.aspect_ratio,
        resolution: parsedInput.resolution,
        model: parsedInput.model,
      }),
    });
  });

/** 移除本人单条生成媒体；保留任务、计费与历史用量事实。 */
export const deleteGenerationAction = protectedAction
  .metadata({ action: "image-generation.delete" })
  .schema(
    z.object({ generationId: z.string().trim().min(1).max(128) }).strict()
  )
  .action(async ({ parsedInput, ctx }) => {
    void ctx;
    return requestGoJson<{ success: boolean }>("/api/image-generation/delete", { method: "POST", body: JSON.stringify(parsedInput) });
  });

/**
 * 批量移除本人生成媒体。
 * Go 服务排除仍被其他任务引用的共享对象，并把任务更新为不可见媒体墓碑；最多 100 条。
 */
export const batchDeleteGenerationAction = protectedAction
  .metadata({ action: "image-generation.batch-delete" })
  .schema(
    z
      .object({
        generationIds: z
          .array(z.string().trim().min(1).max(128))
          .min(1)
          .max(100),
      })
      .strict()
  )
  .action(async ({ parsedInput, ctx }) => {
    void ctx;
    return requestGoJson<{ success: boolean; deletedCount: number }>("/api/image-generation/batch-delete", { method: "POST", body: JSON.stringify(parsedInput) });
  });

/** 读取本人图库的一批安全卡片；用于触底追加和详情返回后的有界重放。 */
export const getMyGalleryItemsAction = protectedAction
  .metadata({ action: "image.listMyGallery" })
  .schema(galleryListInputSchema)
  .action(async ({ parsedInput, ctx }): Promise<GalleryListOutput> => {
    void ctx;
    return requestGoJson<GalleryListOutput>("/api/image-generation/gallery", { method: "POST", body: JSON.stringify(parsedInput) });
  });
