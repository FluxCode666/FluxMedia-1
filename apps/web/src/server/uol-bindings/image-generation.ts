/**
 * 图片生成 UOL 的强类型 late binding。
 *
 * 职责：按 generate/edit/mask 联合契约取得用户准入、把编辑输入转成 storage-only
 * 清单并唯一委托 `runImageGenerationForUser`，身份只从 Principal 获取。
 * 使用方：根 uol-bindings 聚合器；默认依赖动态加载以保持本模块单测 DB-free。
 */

import type { GalleryListOutput } from "@repo/shared/image-generation/gallery-contract";
import { logWarn } from "@repo/shared/logger";
import type { OperationContext, Principal } from "@repo/shared/uol";
import {
  bindOperationExecute,
  createConcurrencyLimitExceededError,
  getPrincipalUserId,
  isExternalApiKeyPrincipal,
  OperationError,
} from "@repo/shared/uol";
import {
  type ImageGenerateOperationInput,
  type ImageGenerateOperationOutput,
  imageGenerate,
  imageListMyGallery,
} from "@repo/shared/uol/operations/image-generation";

import type { stageImageInputReferences } from "@/features/image-generation/image-input-storage";
import type { runImageGenerationForUser } from "@/features/image-generation/operations";
import type {
  RedisImageGenerationAdmissionAcquisition,
  RedisImageGenerationAdmissionLease,
} from "@/features/image-generation/redis-image-generation-slots";
import type {
  ImageGenerationCallbacks,
  ImageQuality,
} from "@/features/image-generation/types";

type ImageGenerateInput = ImageGenerateOperationInput;
type ImageGenerateOutput = ImageGenerateOperationOutput;

/** 图片 binding 可替换依赖；测试注入桩，生产动态加载真实媒体服务。 */
export interface ImageGenerationBindingDependencies {
  stageImageInputReferences: typeof stageImageInputReferences;
  runImageGenerationForUser: typeof runImageGenerationForUser;
  getMediaLimitsForUser: (userId: string) => Promise<{
    limit: number;
    effectiveSource: "system_default" | "user_override";
  }>;
  acquireImageGenerationAdmission: (input: {
    userId: string;
    userConcurrency: number;
  }) => Promise<RedisImageGenerationAdmissionAcquisition>;
  releaseImageGenerationAdmission: (
    lease: RedisImageGenerationAdmissionLease
  ) => Promise<void>;
}

const defaultDependencies: ImageGenerationBindingDependencies = {
  async stageImageInputReferences(input) {
    return (
      await import("@/features/image-generation/image-input-storage")
    ).stageImageInputReferences(input);
  },
  async runImageGenerationForUser(input, callbacks) {
    return (
      await import("@/features/image-generation/operations")
    ).runImageGenerationForUser(input, callbacks);
  },
  async getMediaLimitsForUser(userId) {
    const { mediaLimitService } = await import(
      "@repo/shared/image-generation/media-limit-service"
    );
    return mediaLimitService.getForUser(userId);
  },
  async acquireImageGenerationAdmission(input) {
    const { acquireImageGenerationAdmission } = await import(
      "@/features/image-generation/redis-image-generation-slots"
    );
    return acquireImageGenerationAdmission(input);
  },
  async releaseImageGenerationAdmission(lease) {
    const { releaseImageGenerationAdmission } = await import(
      "@/features/image-generation/redis-image-generation-slots"
    );
    return releaseImageGenerationAdmission(lease);
  },
};

/** 释放 binding 持有的准入槽；失败只告警，不能改写已经完成且可能已扣费的结果。 */
async function releaseAdmissionSafely(
  dependencies: ImageGenerationBindingDependencies,
  lease: RedisImageGenerationAdmissionLease
): Promise<void> {
  try {
    await dependencies.releaseImageGenerationAdmission(lease);
  } catch (error) {
    logWarn("图片 UOL binding 释放用户准入槽失败，等待 TTL 自动回收", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

/** 从受信 OperationContext 中收窄可选的局部图片流回调。 */
function getImageGenerationCallbacks(
  ctx: OperationContext
): ImageGenerationCallbacks | undefined {
  const onPartialImage = ctx.callbacks?.onPartialImage;
  if (typeof onPartialImage !== "function") return undefined;
  return {
    async onPartialImage(image) {
      await onPartialImage(image);
    },
  };
}

/** 将图片管线结果稳定映射为 UOL 输出，不回传内联 base64。 */
function toImageGenerateOutput(
  input: ImageGenerateInput,
  result: Awaited<ReturnType<typeof runImageGenerationForUser>>
): ImageGenerateOutput {
  if (result.error) {
    throw new OperationError(
      result.errorCode ?? "upstream_error",
      result.error,
      result.errorDetails
    );
  }
  const sourceOutputs =
    result.imageOutputs?.length &&
    result.imageOutputs.some((item) => item.imageUrl)
      ? result.imageOutputs
      : result.imageUrl
        ? [
            {
              imageUrl: result.imageUrl,
              revisedPrompt: result.revisedPrompt,
              size: result.size,
              promptRepairNotice: result.promptRepairNotice,
            },
          ]
        : [];
  const images: ImageGenerateOutput["images"] = [];
  for (const output of sourceOutputs) {
    if (!output.imageUrl) continue;
    images.push({
      url: output.imageUrl,
      ...(output.revisedPrompt ? { revisedPrompt: output.revisedPrompt } : {}),
      ...(output.size ? { size: output.size } : {}),
      ...(output.promptRepairNotice
        ? { promptRepairNotice: output.promptRepairNotice }
        : {}),
      ...(output.index !== undefined ? { index: output.index } : {}),
      ...(output.outputRole ? { outputRole: output.outputRole } : {}),
    });
  }
  return {
    generationId: result.generationId ?? input.generationId ?? "",
    images,
    ...(result.creditsConsumed !== undefined
      ? { creditsUsed: result.creditsConsumed }
      : {}),
    ...(result.model ? { model: result.model } : {}),
    ...(result.size ? { size: result.size } : {}),
    ...(result.revisedPrompt ? { revisedPrompt: result.revisedPrompt } : {}),
    ...(result.promptRepairNotice
      ? { promptRepairNotice: result.promptRepairNotice }
      : {}),
  };
}

/**
 * 执行一次图片 operation。
 *
 * @param input 已通过联合 Zod schema 的 generate/edit/mask 输入。
 * @param principal 网关已验证的调用者；userId/apiKeyId 不从 input 接受。
 * @param ctx 仅承载请求关联与可选局部流回调。
 * @param dependencies 生产默认服务或 DB-free 测试桩。
 * @returns UOL 图片结果；媒体读取、生成或存储失败会显式上抛。
 */
export async function executeImageGenerateBinding(
  input: ImageGenerateInput,
  principal: Principal,
  ctx: OperationContext,
  dependencies: ImageGenerationBindingDependencies = defaultDependencies
): Promise<ImageGenerateOutput> {
  const userId = getPrincipalUserId(principal);
  if (!userId) {
    throw new OperationError("forbidden", "User identity required");
  }
  const apiKeyId = isExternalApiKeyPrincipal(principal)
    ? principal.apiKeyId
    : undefined;
  const mediaLimits = await dependencies.getMediaLimitsForUser(userId);
  const admission = await dependencies.acquireImageGenerationAdmission({
    userId,
    userConcurrency: mediaLimits.limit,
  });
  if (admission.status === "blocked") {
    throw createConcurrencyLimitExceededError({
      limit: mediaLimits.limit,
      effectiveSource: mediaLimits.effectiveSource,
    });
  }
  const admissionAuthorization = {
    userId,
    lease: admission.lease,
    limit: mediaLimits.limit,
    effectiveSource: mediaLimits.effectiveSource,
  };
  const common = {
    userId,
    ...(apiKeyId ? { apiKeyId } : {}),
    prompt: input.prompt,
    apiPrompt: input.apiPrompt,
    promptOptimization: input.promptOptimization,
    model: input.model,
    size: input.size,
    quality: input.quality as ImageQuality | undefined,
    thinking: input.thinking,
    moderation: input.moderation,
    outputFormat: input.outputFormat,
    outputCompression: input.outputCompression,
    background: input.background,
    transparentMatte: input.transparentMatte,
    moderationPromptRepair: input.moderationPromptRepair,
    hdRepair: input.hdRepair,
    blockRepair: input.blockRepair,
    repairPrompt: input.repairPrompt,
    generationId: input.generationId,
    backendGroupId: input.backendGroupId,
    admissionAuthorization,
  };
  const callbacks = getImageGenerationCallbacks(ctx);
  try {
    if (input.operation === "generate") {
      return toImageGenerateOutput(
        input,
        await dependencies.runImageGenerationForUser(
          { mode: "generate", ...common },
          callbacks
        )
      );
    }

    const references =
      input.operation === "mask" ? [...input.images, input.mask] : input.images;
    const staged = await dependencies.stageImageInputReferences({
      userId,
      generationId: input.generationId,
      references,
    });
    const imageCount = input.images.length;
    const images = staged.references.slice(0, imageCount);
    const mask =
      input.operation === "mask" && staged.references[imageCount]
        ? staged.references[imageCount]
        : undefined;
    return toImageGenerateOutput(
      input,
      await dependencies.runImageGenerationForUser(
        {
          mode: "edit",
          ...common,
          images: [],
          mediaInputReferences: {
            images,
            ...(mask ? { mask } : {}),
          },
          stagedImageInputObjects: staged.objects,
        },
        callbacks
      )
    );
  } finally {
    await releaseAdmissionSafely(dependencies, admission.lease);
  }
}

bindOperationExecute(imageGenerate, (input, principal, ctx) =>
  executeImageGenerateBinding(input, principal, ctx)
);

/** 绑定本人图库批次；数据库查询与 cursor 签名仅在服务端执行。 */
bindOperationExecute(
  imageListMyGallery,
  async (input, principal): Promise<GalleryListOutput> => {
    const userId = getPrincipalUserId(principal);
    if (!userId || principal.type !== "user") {
      throw new OperationError("unauthenticated", "User session required");
    }
    const [{ databaseGalleryRepository }, { loadGalleryItems }] =
      await Promise.all([
        import("@/features/image-generation/gallery-repository"),
        import("@/features/image-generation/gallery-service"),
      ]);
    try {
      return await loadGalleryItems(
        { userId, input },
        { repository: databaseGalleryRepository }
      );
    } catch (error) {
      const { GalleryServiceError } = await import(
        "@/features/image-generation/gallery-service"
      );
      if (error instanceof GalleryServiceError) {
        throw new OperationError(error.code, error.message);
      }
      throw error;
    }
  }
);
