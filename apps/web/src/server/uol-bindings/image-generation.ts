/**
 * 图片生成 UOL 的强类型 late binding。
 *
 * 职责：按 generate/edit/mask 联合契约加载媒体引用并唯一委托
 * `runImageGenerationForUser`，身份只从 Principal 获取。
 * 使用方：根 uol-bindings 聚合器；默认依赖动态加载以保持本模块单测 DB-free。
 */
import {
  imageGenerate,
  type ImageGenerateOperationInput,
  type ImageGenerateOperationOutput,
} from "@repo/shared/uol/operations/image-generation";
import type { OperationContext, Principal } from "@repo/shared/uol";
import {
  bindOperationExecute,
  getPrincipalUserId,
  isExternalApiKeyPrincipal,
  OperationError,
} from "@repo/shared/uol";

import type { loadMediaInputs } from "@/features/image-generation/media-input-loader";
import type { runImageGenerationForUser } from "@/features/image-generation/operations";
import type {
  ImageGenerationCallbacks,
  ImageInputFile,
  ImageQuality,
} from "@/features/image-generation/types";

type ImageGenerateInput = ImageGenerateOperationInput;
type ImageGenerateOutput = ImageGenerateOperationOutput;

/** 图片 binding 可替换依赖；测试注入桩，生产动态加载真实媒体服务。 */
export interface ImageGenerationBindingDependencies {
  loadMediaInputs: typeof loadMediaInputs;
  runImageGenerationForUser: typeof runImageGenerationForUser;
}

const defaultDependencies: ImageGenerationBindingDependencies = {
  async loadMediaInputs(input) {
    return (await import("@/features/image-generation/media-input-loader"))
      .loadMediaInputs(input);
  },
  async runImageGenerationForUser(input, callbacks) {
    return (await import("@/features/image-generation/operations"))
      .runImageGenerationForUser(input, callbacks);
  },
};

/** 将已校验字节映射为图片管线文件，名称只用于上游 multipart 元数据。 */
function toImageInputFile(
  input: { data: Buffer; type: string },
  index: number,
  prefix: string
): ImageInputFile {
  const extension = input.type === "image/png" ? "png" : "image";
  return {
    data: input.data,
    type: input.type,
    name: `${prefix}-${index + 1}.${extension}`,
  };
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
  if (result.error) throw new Error(result.error);
  const images: { url: string; revisedPrompt?: string }[] = [];
  if (result.imageUrl) {
    images.push({
      url: result.imageUrl,
      ...(result.revisedPrompt
        ? { revisedPrompt: result.revisedPrompt }
        : {}),
    });
  }
  for (const output of result.imageOutputs ?? []) {
    if (!output.imageUrl) continue;
    images.push({
      url: output.imageUrl,
      ...(output.revisedPrompt
        ? { revisedPrompt: output.revisedPrompt }
        : {}),
    });
  }
  return {
    generationId: result.generationId ?? input.generationId ?? "",
    images,
    ...(result.creditsConsumed !== undefined
      ? { creditsUsed: result.creditsConsumed }
      : {}),
    ...(result.model ? { model: result.model } : {}),
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
  const common = {
    userId,
    ...(apiKeyId ? { apiKeyId } : {}),
    prompt: input.prompt,
    model: input.model,
    size: input.size,
    quality: input.quality as ImageQuality | undefined,
    n: input.count,
    generationId: input.generationId,
    backendGroupId: input.backendGroupId,
  };
  const callbacks = getImageGenerationCallbacks(ctx);
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
  const loaded = await dependencies.loadMediaInputs({ userId, references });
  const imageCount = input.images.length;
  const images = loaded
    .slice(0, imageCount)
    .map((image, index) => toImageInputFile(image, index, "image"));
  const mask =
    input.operation === "mask" && loaded[imageCount]
      ? toImageInputFile(loaded[imageCount], 0, "mask")
      : undefined;
  return toImageGenerateOutput(
    input,
    await dependencies.runImageGenerationForUser(
      {
        mode: "edit",
        ...common,
        images,
        ...(mask ? { mask } : {}),
      },
      callbacks
    )
  );
}

bindOperationExecute(imageGenerate, (input, principal, ctx) =>
  executeImageGenerateBinding(input, principal, ctx)
);
