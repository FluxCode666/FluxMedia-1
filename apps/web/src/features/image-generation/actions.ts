"use server";

/**
 * 图片生成与媒体删除 Server Action 薄适配器。
 *
 * 使用方：创作页与画廊。输入经 Zod 校验后构造本人 Principal，所有业务逻辑经 UOL
 * operation 执行，Action 不直接访问数据库或对象存储。
 */
import { randomUUID } from "node:crypto";
import { getUserRoleById } from "@repo/shared/auth/role-server";
import {
  type GalleryListOutput,
  galleryListInputSchema,
} from "@repo/shared/image-generation/gallery-contract";
import { imageModelIdSchema } from "@repo/shared/image-generation/model-contract";
import { protectedAction } from "@repo/shared/safe-action";
import { invokeOperation } from "@repo/shared/uol";
import { z } from "zod";
import { ensureUolInitialized } from "@/server/uol-init";
import {
  IMAGE_PROMPT_MAX_CHARACTERS,
  IMAGE_PROMPT_TOO_LONG_MESSAGE,
  resolveImageRequestSize,
  validateImageSize,
} from "./resolution";
import { invokeImageGenerationOperation } from "./uol-client";

const generateImageSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .max(IMAGE_PROMPT_MAX_CHARACTERS, IMAGE_PROMPT_TOO_LONG_MESSAGE),
  size: z
    .string()
    .optional()
    .refine((value) => !value || validateImageSize(value).valid, {
      message: "Invalid image size",
    }),
  model: imageModelIdSchema,
});

/** 创建单次图片生成任务并委托统一 image.generate operation。 */
export const generateImageAction = protectedAction
  .metadata({ action: "image-generation.generate" })
  .schema(generateImageSchema)
  .action(async ({ parsedInput, ctx }) => {
    return invokeImageGenerationOperation(
      {
        operation: "generate",
        generationId: randomUUID(),
        prompt: parsedInput.prompt,
        size: resolveImageRequestSize(parsedInput.size),
        model: parsedInput.model,
      },
      {
        type: "user",
        userId: ctx.userId,
        role: await getUserRoleById(ctx.userId),
      }
    );
  });

/** 移除本人单条生成媒体；保留任务、计费与历史用量事实。 */
export const deleteGenerationAction = protectedAction
  .metadata({ action: "image-generation.delete" })
  .schema(
    z.object({ generationId: z.string().trim().min(1).max(128) }).strict()
  )
  .action(async ({ parsedInput, ctx }) => {
    await ensureUolInitialized();
    return invokeOperation<{ success: boolean }>("image.delete", parsedInput, {
      type: "user",
      userId: ctx.userId,
      role: await getUserRoleById(ctx.userId),
    });
  });

/**
 * 批量移除本人生成媒体。
 * UOL 服务排除仍被其他任务引用的共享对象，并把任务更新为不可见媒体墓碑；最多 100 条。
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
    await ensureUolInitialized();
    return invokeOperation<{ success: boolean; deletedCount: number }>(
      "image.batchDelete",
      parsedInput,
      {
        type: "user",
        userId: ctx.userId,
        role: await getUserRoleById(ctx.userId),
      }
    );
  });

/** 读取本人图库的一批安全卡片；用于触底追加和详情返回后的有界重放。 */
export const getMyGalleryItemsAction = protectedAction
  .metadata({ action: "image.listMyGallery" })
  .schema(galleryListInputSchema)
  .action(async ({ parsedInput, ctx }): Promise<GalleryListOutput> => {
    await ensureUolInitialized();
    return invokeOperation<GalleryListOutput>(
      "image.listMyGallery",
      parsedInput,
      {
        type: "user",
        userId: ctx.userId,
        role: await getUserRoleById(ctx.userId),
      }
    );
  });
