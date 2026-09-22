/**
 * 图片生成 UOL 的强类型 late binding。
 *
 * 职责：按 generate/edit/mask 联合契约取得用户准入、把编辑输入转成 storage-only
 * 清单并委托 Go 持久任务，身份只从 Principal 获取。
 * 使用方：根 uol-bindings 聚合器；默认依赖动态加载以保持本模块单测 DB-free。
 */

import type { GalleryListOutput } from "@repo/shared/image-generation/gallery-contract";
import { randomUUID } from "node:crypto";
import { galleryListOutputSchema } from "@repo/shared/image-generation/gallery-contract";
import {
  assertImageMediaInputWithinPolicy,
  type MediaInputPolicy,
} from "@repo/shared/image-generation/media-contract";
import { logWarn } from "@repo/shared/logger";
import type { OperationContext, Principal } from "@repo/shared/uol";
import {
  bindExecute,
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
  imageMaintainHistoryCountProjection,
} from "@repo/shared/uol/operations/image-generation";

import type { cleanupStagedImageInputs, stageImageInputReferences } from "@/features/image-generation/image-input-storage";
import type { runImageGenerationForUser } from "@/features/image-generation/operations";
import type {
  RedisImageGenerationAdmissionAcquisition,
  RedisImageGenerationAdmissionLease,
} from "@/features/image-generation/redis-image-generation-slots";
import type {
  ImageGenerationCallbacks,
  ImageQuality,
} from "@/features/image-generation/types";
import {
  requestGoJson,
  requestGoJsonForPrincipal,
} from "@/server/go-backend-client";

import { getMediaInputPolicyOperationError } from "./media-input-policy-error";

type ImageGenerateInput = ImageGenerateOperationInput;
type ImageGenerateOutput = ImageGenerateOperationOutput;

/** 图片 binding 可替换依赖；测试注入桩，生产动态加载真实媒体服务。 */
export interface ImageGenerationBindingDependencies {
  stageImageInputReferences: (input: Parameters<typeof stageImageInputReferences>[0] & { apiKeyId?: string }) => ReturnType<typeof stageImageInputReferences>;
  cleanupStagedImageInputs?: (objects: Parameters<typeof cleanupStagedImageInputs>[0], principal?: Principal) => Promise<void>;
  runImageGenerationForUser: typeof runImageGenerationForUser;
  getMediaLimitsForUser: (userId: string, principal?: Principal) => Promise<
    {
      limit: number;
      effectiveSource: "system_default" | "user_override";
    } & MediaInputPolicy
  >;
  acquireImageGenerationAdmission?: (input: {
    userId: string;
    userConcurrency: number;
  }) => Promise<RedisImageGenerationAdmissionAcquisition>;
  releaseImageGenerationAdmission?: (
    lease: RedisImageGenerationAdmissionLease
  ) => Promise<void>;
}

const defaultDependencies: ImageGenerationBindingDependencies = {
  async stageImageInputReferences(input) {
    const { apiKeyId, ...body } = input;
    const init = { method: "POST", body: JSON.stringify(body) };
    return apiKeyId
      ? requestGoJsonForPrincipal<Awaited<ReturnType<typeof stageImageInputReferences>>>(
          { type: "apiKey", credentialKind: "external", userId: input.userId, apiKeyId },
          "/api/image-generation/inputs/stage", init
        )
      : requestGoJson<Awaited<ReturnType<typeof stageImageInputReferences>>>(
          "/api/image-generation/inputs/stage", init
        );
  },
  async cleanupStagedImageInputs(objects, principal) {
    const init = { method: "POST", body: JSON.stringify({ objects }) };
    if (principal?.type === "apiKey") {
      await requestGoJsonForPrincipal(principal, "/api/image-generation/inputs/cleanup", init);
    } else {
      await requestGoJson("/api/image-generation/inputs/cleanup", init);
    }
  },
  async runImageGenerationForUser(input, _callbacks) {
    void _callbacks;
    // The durable generation/worker pipeline now lives in Go. Keep the
    // binding's return shape stable by creating the task there and polling its
    // generation projection until the worker settles it.
    const { admissionAuthorization: _admission, ...requestInput } = input;
    const body = {
      ...requestInput,
      operation: input.mode,
      ...(input.mode === "edit"
        ? {
            images: input.mediaInputReferences?.images ?? [],
            ...(input.mediaInputReferences?.mask
              ? { mask: input.mediaInputReferences.mask }
              : {}),
          }
        : {}),
    };
    delete (body as Record<string, unknown>).mode;
    delete (body as Record<string, unknown>).userId;
    delete (body as Record<string, unknown>).apiKeyId;
    delete (body as Record<string, unknown>).executionAuthorization;
    delete (body as Record<string, unknown>).groupAuthorization;
    delete (body as Record<string, unknown>).inputDigest;
    delete (body as Record<string, unknown>).mediaInputReferences;
    delete (body as Record<string, unknown>).stagedImageInputObjects;
    const principal = input.apiKeyId
      ? {
          type: "apiKey" as const,
          credentialKind: "external" as const,
          userId: input.userId,
          apiKeyId: input.apiKeyId,
        }
      : undefined;
    const endpoint = input.mode === "edit" ? "/api/images/edit" : "/api/images/generate";
    const create = principal
      ? await requestGoJsonForPrincipal<Record<string, unknown>>(principal, endpoint, {
          method: "POST",
          body: JSON.stringify(body),
        })
      : await requestGoJson<Record<string, unknown>>(endpoint, {
          method: "POST",
          body: JSON.stringify(body),
        });
    const generationId = String(create.generationId ?? create.generation_id ?? input.generationId);
    const deadline = Date.now() + 120_000;
    let status: Record<string, unknown> = create;
    while (Date.now() < deadline) {
      const state = principal
        ? await requestGoJsonForPrincipal<Record<string, unknown>>(principal, `/api/images/status/${encodeURIComponent(generationId)}`)
        : await requestGoJson<Record<string, unknown>>(`/api/images/status/${encodeURIComponent(generationId)}`);
      status = state;
      const value = String(state.status ?? "");
      if (value === "completed" || value === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const imageOutputs = Array.isArray(status.imageOutputs)
      ? status.imageOutputs.map((item) => {
          const value = item as Record<string, unknown>;
          return {
            imageUrl: typeof value.imageUrl === "string" ? value.imageUrl : undefined,
            revisedPrompt: typeof value.revisedPrompt === "string" ? value.revisedPrompt : undefined,
            size: typeof value.size === "string" ? value.size : undefined,
            outputRole: value.role === "choice" ? "choice" as const : "final" as const,
          };
        })
      : [];
    return {
      generationId,
      model: typeof status.model === "string" ? status.model : input.model,
      imageUrl: typeof status.imageUrl === "string" ? status.imageUrl : undefined,
      imageOutputs,
      creditsConsumed: typeof status.creditsConsumed === "number" ? status.creditsConsumed : undefined,
      size: typeof status.size === "string" ? status.size : undefined,
      revisedPrompt: typeof status.revisedPrompt === "string" ? status.revisedPrompt : undefined,
      promptRepairNotice: typeof status.promptRepairNotice === "string" ? status.promptRepairNotice : undefined,
      error: status.status !== "completed" && status.status !== "failed"
        ? "图片任务仍在处理中，请稍后在使用记录中查看结果"
        : status.status === "failed" ? String((status.error as Record<string, unknown> | undefined)?.message ?? status.error ?? "Image generation failed") : undefined,
    } as Awaited<ReturnType<typeof runImageGenerationForUser>>;
  },
  async getMediaLimitsForUser(userId, principal) {
    const path = `/api/image-generation/media-limits?userId=${encodeURIComponent(userId)}`;
    return principal?.type === "apiKey"
      ? requestGoJsonForPrincipal<Awaited<ReturnType<ImageGenerationBindingDependencies["getMediaLimitsForUser"]>>>(principal, path)
      : requestGoJson<Awaited<ReturnType<ImageGenerationBindingDependencies["getMediaLimitsForUser"]>>>(path);
  },
};

/** 释放 binding 持有的准入槽；失败只告警，不能改写已经完成且可能已扣费的结果。 */
async function releaseAdmissionSafely(
  dependencies: ImageGenerationBindingDependencies,
  lease: RedisImageGenerationAdmissionLease
): Promise<void> {
  try {
    await dependencies.releaseImageGenerationAdmission?.(lease);
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
  const mediaLimits = await dependencies.getMediaLimitsForUser(userId, principal);
  try {
    assertImageMediaInputWithinPolicy(input, mediaLimits);
  } catch (error) {
    const operationError = getMediaInputPolicyOperationError(error);
    if (operationError) throw operationError;
    throw error;
  }
  const admission = await dependencies.acquireImageGenerationAdmission?.({
    userId,
    userConcurrency: mediaLimits.limit,
  });
  if (admission?.status === "blocked") {
    throw createConcurrencyLimitExceededError({
      limit: mediaLimits.limit,
      effectiveSource: mediaLimits.effectiveSource,
    });
  }
  const admissionAuthorization = admission ? {
    userId,
    lease: admission.lease,
    limit: mediaLimits.limit,
    effectiveSource: mediaLimits.effectiveSource,
  } : undefined;
  const common = {
    userId,
    ...(apiKeyId ? { apiKeyId } : {}),
    prompt: input.prompt,
    apiPrompt: input.apiPrompt,
    promptOptimization: input.promptOptimization,
    model: input.model,
    aspectRatio: input.aspectRatio ?? input.aspect_ratio,
    resolution: input.resolution,
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
  let stagedObjects: Parameters<typeof cleanupStagedImageInputs>[0] = [];
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
    // Go validates ownership, bytes and limits for every reference, including
    // existing storage objects, before accepting a durable task.
    const staged = await dependencies.stageImageInputReferences({
      userId,
      ...(apiKeyId ? { apiKeyId } : {}),
      generationId: input.generationId,
      references,
    });
    stagedObjects = staged.objects;
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
  } catch (error) {
    if (stagedObjects.length && dependencies.cleanupStagedImageInputs) {
      await dependencies.cleanupStagedImageInputs(stagedObjects, principal).catch(() => {
        logWarn("图片输入清理失败，等待存储回收", { userId });
      });
    }
    throw error;
  } finally {
    if (admission) await releaseAdmissionSafely(dependencies, admission.lease);
  }
}

bindOperationExecute(imageGenerate, (input, principal, ctx) =>
  executeImageGenerateBinding(input, principal, ctx)
);

/** 校验或幂等重建媒体历史精确计数投影；数据库函数自行持有写锁和漂移口径。 */
bindOperationExecute(imageMaintainHistoryCountProjection, async (input) => {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) throw new OperationError("internal_error", "维护服务未配置");
  return requestGoJson<{ driftCount: number; rebuilt: boolean }>(
    "/api/admin/image-generation/history-projection",
    {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
      body: JSON.stringify(input),
    }
  );
});

/** 绑定本人图库批次；数据库查询与 cursor 签名仅在服务端执行。 */
bindOperationExecute(
  imageListMyGallery,
  async (input, principal): Promise<GalleryListOutput> => {
    if (principal.type !== "user") {
      throw new OperationError("unauthenticated", "User session required");
    }
    const output = await requestGoJson<GalleryListOutput>(
      "/api/image-generation/gallery",
      { method: "POST", body: JSON.stringify(input) }
    );
    return galleryListOutputSchema.parse(output);
  }
);

// Compatibility operations that predate the unified history contract still
// remain callable by MCP/internal UOL clients.  They all use the Go-owned
// first-party read endpoints so invoking the legacy operation name cannot
// fall through to the shared database stub.
function requireImagePrincipal(principal: Principal): void {
  if (principal.type !== "user" && !isExternalApiKeyPrincipal(principal)) {
    throw new OperationError("unauthenticated", "User identity required");
  }
}

async function imageReadRequest<T>(
  principal: Principal,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  requireImagePrincipal(principal);
  return principal.type === "apiKey"
    ? requestGoJsonForPrincipal(principal, path, init)
    : requestGoJson(path, init);
}

bindExecute("image.generateAction", async (input: { prompt: string; model: string; quality?: string; style?: string }, principal, ctx) => {
  const result = await executeImageGenerateBinding(
    { operation: "generate", ...input, generationId: randomUUID() } as ImageGenerateInput,
    principal,
    ctx
  );
  const first = result.images[0];
  if (!first?.url) throw new OperationError("upstream_error", "Image generation returned no image");
  return { generationId: result.generationId, imageUrl: first.url, ...(first.revisedPrompt ? { revisedPrompt: first.revisedPrompt } : {}) };
});

bindExecute("image.getStatus", async (input: { generationId: string }, principal) => {
  const raw = await imageReadRequest<Record<string, unknown>>(
    principal,
    `/api/images/status/${encodeURIComponent(input.generationId)}`
  );
  const status = String(raw.status ?? "processing");
  return {
    generationId: String(raw.generationId ?? raw.generation_id ?? input.generationId),
    status: (status === "pending" ? "pending" : status === "completed" ? "completed" : status === "failed" ? "failed" : "processing") as "pending" | "processing" | "completed" | "failed",
    ...(typeof raw.progress === "number" ? { progress: raw.progress } : {}),
    ...(typeof raw.error === "string" ? { error: raw.error } : raw.error && typeof raw.error === "object" && typeof (raw.error as Record<string, unknown>).message === "string" ? { error: String((raw.error as Record<string, unknown>).message) } : {}),
    ...(typeof raw.completedAt === "string" ? { completedAt: raw.completedAt } : typeof raw.completed_at === "string" ? { completedAt: raw.completed_at } : {}),
  };
});

bindExecute("image.getUserGenerations", async (input: { userId?: string; page?: number; pageSize?: number; status?: string }, principal) => {
  const page = Math.max(1, Number(input.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(input.pageSize ?? 20)));
  const offset = (page - 1) * pageSize;
  const query = new URLSearchParams({ limit: String(pageSize), offset: String(offset) });
  if (input.status) query.set("status", input.status);
  const [rows, count] = await Promise.all([
    imageReadRequest<unknown[]>(principal, `/api/image-generation/list?${query}`),
    imageReadRequest<{ count: number }>(principal, `/api/image-generation/count${input.status ? `?status=${encodeURIComponent(input.status)}` : ""}`),
  ]);
  return { generations: rows, total: Number(count.count ?? rows.length), page, pageSize };
});

bindExecute("image.getUserGenerationCount", async (_input: { userId?: string }, principal) =>
  imageReadRequest<{ count: number }>(principal, "/api/image-generation/count")
);

bindExecute("image.getUserRecentGenerations", async (input: { userId?: string; limit?: number }, principal) => ({
  generations: await imageReadRequest<unknown[]>(principal, `/api/image-generation/recent?limit=${Math.min(50, Math.max(1, Number(input.limit ?? 12)))}`),
}));

bindExecute("image.getGenerationById", async (input: { generationId: string }, principal) =>
  imageReadRequest(principal, `/api/image-generation/${encodeURIComponent(input.generationId)}`)
);

bindExecute("image.getGenerationStats", async (input: { startDate?: string; endDate?: string; groupBy?: "day" | "week" | "month" }, principal) => {
  const query = new URLSearchParams();
  if (input.startDate) query.set("startDate", input.startDate);
  if (input.endDate) query.set("endDate", input.endDate);
  if (input.groupBy) query.set("groupBy", input.groupBy);
  return imageReadRequest(principal, `/api/admin/image-generation/stats?${query}`);
});

bindExecute("image.getEffectiveConfig", async (input: { userId?: string; model?: string; backendGroupId?: string }, principal) =>
  imageReadRequest(principal, "/api/image-generation/effective-config", {
    method: "POST",
    body: JSON.stringify(input),
  })
);
