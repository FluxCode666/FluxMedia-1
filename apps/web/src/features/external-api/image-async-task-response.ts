/**
 * 持久图片异步任务的外部 API 响应组装器。
 *
 * 职责：把 PostgreSQL 编排任务与 generation 产物聚合为兼容现有 `/v1/images/{id}`
 * 的公开响应；按 response_format 签发 URL 或读取对象为 base64，不暴露身份和输入。
 * 使用方：图片任务查询 handler 与 Worker 完成回调。
 */
import {
  buildPublicImageUrl,
  buildSignedStorageImageUrl,
} from "@repo/shared/storage/signed-url";
import type { ImageAsyncTaskOutput } from "@repo/shared/uol/operations/image-generation";
import type { ImageAsyncTaskRecord } from "@/features/image-generation/image-async-task-repository";

/** 响应组装所需的一条 generation 最小读取模型。 */
export interface ImageAsyncGenerationRecord {
  id: string;
  userId: string;
  model: string;
  status: "pending" | "completed" | "failed";
  revisedPrompt: string | null;
  storageKey: string | null;
  storageBucket: string | null;
  creditsConsumed: string | number | null;
  error: string | null;
}

/** 响应组装器可替换依赖；单测不访问数据库、系统设置或对象存储。 */
export interface ImageAsyncTaskResponseDependencies {
  loadGeneration(id: string): Promise<ImageAsyncGenerationRecord | null>;
  loadStorageObject(key: string, bucket: string): Promise<Buffer>;
  getPublicBaseUrl(): Promise<string>;
}

/** 公开响应组装所需的最小任务视图。 */
export interface ImageAsyncTaskPublicSource {
  id: string;
  userId: string;
  model: string;
  generationId: string;
  responseFormat: "url" | "b64_json";
  status: "queued" | "running" | "completed" | "failed";
  error: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

const defaultDependencies: ImageAsyncTaskResponseDependencies = {
  async loadGeneration(id) {
    return import("@/features/image-generation/queries").then(
      ({ getGenerationById }) => getGenerationById(id)
    );
  },
  async loadStorageObject(key, bucket) {
    const { getStorageProvider } = await import(
      "@repo/shared/storage/providers"
    );
    return Buffer.from(
      await (await getStorageProvider()).getObject(key, bucket)
    );
  },
  async getPublicBaseUrl() {
    return import("@/features/image-generation/request-utils").then(
      ({ getImagePublicBaseUrl }) => getImagePublicBaseUrl()
    );
  },
};

/** 将持久任务状态映射为既有外部 API 三态。 */
function toExternalTaskStatus(
  status: ImageAsyncTaskPublicSource["status"]
): "processing" | "completed" | "failed" {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return "processing";
}

/** 创建所有状态共享的公开任务字段，不包含 callbackUrl、Principal 或生成输入。 */
function createBaseTaskResponse(task: ImageAsyncTaskPublicSource) {
  const status = toExternalTaskStatus(task.status);
  return {
    id: task.id,
    object: status === "processing" ? "image.generation" : "image",
    model: task.model,
    status,
    created: Math.floor(task.createdAt.getTime() / 1_000),
    created_at: task.createdAt.toISOString(),
    ...(task.completedAt
      ? {
          completed: Math.floor(task.completedAt.getTime() / 1_000),
          completed_at: task.completedAt.toISOString(),
        }
      : {}),
    generation_id: task.generationId,
    generationId: task.generationId,
  };
}

/** 把失败任务的安全持久错误映射为 OpenAI 兼容错误对象。 */
function createFailedTaskResponse(task: ImageAsyncTaskPublicSource) {
  return {
    ...createBaseTaskResponse(task),
    error: {
      message: task.error ?? "Image generation failed. Please retry later.",
      type: "upstream_error",
      code: "image_generation_failed",
      status: 502,
    },
  };
}

/** 从内部数据库记录提取公开响应最小视图。 */
export function createImageAsyncTaskPublicSource(
  task: ImageAsyncTaskRecord
): ImageAsyncTaskPublicSource {
  return {
    id: task.id,
    userId: task.userId,
    model: task.generationInput.model,
    generationId: task.generationId,
    responseFormat: task.responseFormat,
    status: task.status,
    error: task.error,
    createdAt: task.createdAt,
    completedAt: task.completedAt,
  };
}

/** 从已做 owner 校验的 UOL 输出构造公开响应最小视图。 */
export function createImageAsyncTaskPublicSourceFromOperation(
  task: ImageAsyncTaskOutput,
  userId: string
): ImageAsyncTaskPublicSource {
  return {
    id: task.taskId,
    userId,
    model: task.model,
    generationId: task.generationId,
    responseFormat: task.responseFormat,
    status: task.status,
    error: task.error,
    createdAt: new Date(task.createdAt),
    completedAt: task.completedAt ? new Date(task.completedAt) : null,
  };
}

/**
 * 聚合一条持久图片异步任务的公开响应。
 *
 * @param task 已完成严格数据库行校验的任务。
 * @param dependencies 生成记录、对象存储和公开站点 URL 依赖。
 * @returns 与旧进程内任务响应兼容的 JSON-safe 对象。
 * @throws completed 任务缺少 generation、跨用户、非完成状态或产物时显式失败。
 */
export async function buildImageAsyncTaskPublicResponse(
  task: ImageAsyncTaskPublicSource,
  dependencies: ImageAsyncTaskResponseDependencies = defaultDependencies
): Promise<Record<string, unknown>> {
  if (task.status === "failed") return createFailedTaskResponse(task);
  if (task.status !== "completed") return createBaseTaskResponse(task);

  const generation = await dependencies.loadGeneration(task.generationId);
  if (
    !generation ||
    generation.id !== task.generationId ||
    generation.userId !== task.userId ||
    generation.status !== "completed" ||
    !generation.storageKey ||
    !generation.storageBucket
  ) {
    throw new Error("图片异步任务完成状态与 generation 产物不一致");
  }
  const publicBaseUrl = await dependencies.getPublicBaseUrl();
  const image: Record<string, string> = {};
  if (task.responseFormat === "b64_json") {
    image.b64_json = (
      await dependencies.loadStorageObject(
        generation.storageKey,
        generation.storageBucket
      )
    ).toString("base64");
  } else {
    const signedUrl = buildSignedStorageImageUrl(
      generation.storageKey,
      generation.storageBucket
    );
    const publicUrl = buildPublicImageUrl(signedUrl, publicBaseUrl);
    if (!publicUrl) {
      throw new Error("图片异步任务无法构建公开产物 URL");
    }
    image.url = publicUrl;
  }
  if (generation.revisedPrompt) {
    image.revised_prompt = generation.revisedPrompt;
  }

  return {
    ...createBaseTaskResponse(task),
    data: [image],
    credits_consumed:
      Math.round(Math.max(0, Number(generation.creditsConsumed) || 0) * 100) /
      100,
    usage: null,
  };
}
