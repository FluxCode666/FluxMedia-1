/**
 * 图片异步任务 UOL late binding。
 *
 * 职责：从外部 API Principal 构造最小持久身份，幂等创建 PostgreSQL 任务并在提交后
 * 最佳努力投递 BullMQ；查询时同时校验 userId 与 API Key 域，防止同账号 Key 间越权。
 * 使用方：根 uol-bindings 聚合器；Worker 处理 binding 在同模块后续接入。
 */
import { normalizeSubscriptionPlan } from "@repo/shared/config/subscription-plan";
import { logError } from "@repo/shared/logger";
import type { OperationContext, Principal } from "@repo/shared/uol";
import {
  bindOperationExecute,
  isExternalApiKeyPrincipal,
  OperationError,
} from "@repo/shared/uol";
import type {
  ImageAsyncTaskOutput,
  ImageEnqueueAsyncInput,
} from "@repo/shared/uol/operations/image-generation";
import {
  imageEnqueueAsync,
  imageGetAsyncTask,
} from "@repo/shared/uol/operations/image-generation";

import { validateCallbackUrl } from "@/features/external-api/async-image-tasks";
import {
  defaultImageAsyncTaskRepository,
  type ImageAsyncTaskRecord,
  type ImageAsyncTaskRepository,
} from "@/features/image-generation/image-async-task-repository";
import { enqueueImageTask } from "@/server/media-task-queues";

/** BullMQ 数字越小优先级越高；套餐名称只在此适配为队列实现细节。 */
const IMAGE_QUEUE_PRIORITIES = {
  normal: 100,
  priority: 50,
  highest: 1,
} as const;

/** 图片异步创建 binding 的可替换依赖。 */
export interface ImageAsyncTaskBindingDependencies {
  repository: ImageAsyncTaskRepository;
  validateCallback(value: string): Promise<string>;
  getQueuePriority(plan: string): Promise<number>;
  enqueueTask(input: { taskId: string; priority: number }): Promise<unknown>;
  reportEnqueueFailure(error: unknown, taskId: string): void;
}

const defaultDependencies: ImageAsyncTaskBindingDependencies = {
  repository: defaultImageAsyncTaskRepository,
  validateCallback: validateCallbackUrl,
  async getQueuePriority(plan) {
    const { getPlanQueueSettings } = await import(
      "@repo/shared/subscription/services/plan-capabilities"
    );
    const settings = await getPlanQueueSettings(normalizeSubscriptionPlan(plan));
    return IMAGE_QUEUE_PRIORITIES[settings.priority];
  },
  enqueueTask: enqueueImageTask,
  reportEnqueueFailure(error, taskId) {
    logError(error, {
      source: "image-async-task-mq-enqueue",
      taskId,
    });
  },
};

/** 将数据库任务记录映射为不含身份、提示词和媒体引用的 UOL 输出。 */
export function toImageAsyncTaskOutput(
  task: ImageAsyncTaskRecord
): ImageAsyncTaskOutput {
  return {
    taskId: task.id,
    operation: task.operation,
    status: task.status,
    generationIds: task.generationIds,
    responseFormat: task.responseFormat,
    createdAt: task.createdAt.toISOString(),
    startedAt: task.startedAt?.toISOString() ?? null,
    completedAt: task.completedAt?.toISOString() ?? null,
    error: task.error,
  };
}

/** 确保异步任务只在创建它的外部 API Key 域内可见。 */
function assertImageAsyncTaskPrincipal(
  task: ImageAsyncTaskRecord,
  principal: Principal,
  context: OperationContext
): asserts principal is Extract<Principal, { type: "apiKey" }> {
  if (!isExternalApiKeyPrincipal(principal)) {
    throw new OperationError(
      "unauthenticated",
      "External API key authentication required"
    );
  }
  if (task.userId !== principal.userId || task.apiKeyId !== principal.apiKeyId) {
    throw new OperationError("not_found", "Image async task not found");
  }
  context.assertOwnership("image async task", task.userId);
}

/** 校验相同 taskId 的幂等重放没有改变图片输入或回调目标。 */
function assertImageAsyncTaskReplay(
  task: ImageAsyncTaskRecord,
  input: ImageEnqueueAsyncInput
): void {
  const generationInputsMatch =
    JSON.stringify(task.generationInputs) ===
    JSON.stringify(input.generationInputs);
  if (
    !generationInputsMatch ||
    task.responseFormat !== input.responseFormat ||
    task.callbackUrl !== (input.callbackUrl ?? null)
  ) {
    throw new OperationError(
      "idempotency_conflict",
      "taskId was already used with different image async input"
    );
  }
}

/**
 * 幂等创建图片异步任务并最佳努力投递 MQ。
 *
 * @param input 已通过 UOL 校验且仅含 JSON-safe 媒体引用的批次。
 * @param principal 外部 API Key Principal；身份字段不得来自 input。
 * @param context UOL 归属断言上下文。
 * @param dependencies 生产服务或 DB-free 测试桩。
 * @returns PostgreSQL 持久任务视图；Redis 暂时失败时仍返回 queued。
 */
export async function executeImageEnqueueAsyncBinding(
  input: ImageEnqueueAsyncInput,
  principal: Principal,
  context: OperationContext,
  dependencies: ImageAsyncTaskBindingDependencies = defaultDependencies
): Promise<ImageAsyncTaskOutput> {
  if (!isExternalApiKeyPrincipal(principal)) {
    throw new OperationError(
      "unauthenticated",
      "External API key authentication required"
    );
  }
  const normalizedInput = {
    ...input,
    ...(input.callbackUrl
      ? { callbackUrl: await dependencies.validateCallback(input.callbackUrl) }
      : {}),
  };
  const result = await dependencies.repository.create({
    task: normalizedInput,
    userId: principal.userId,
    apiKeyId: principal.apiKeyId,
    plan: principal.plan,
    now: new Date(),
  });
  assertImageAsyncTaskPrincipal(result.task, principal, context);
  assertImageAsyncTaskReplay(result.task, normalizedInput);

  if (result.task.status === "queued") {
    try {
      const priority = await dependencies.getQueuePriority(result.task.plan);
      await dependencies.enqueueTask({ taskId: result.task.id, priority });
    } catch (error) {
      // WHY：数据库已提交后 Redis 失败不能回滚任务；恢复扫描会以同一 taskId 补投。
      dependencies.reportEnqueueFailure(error, result.task.id);
    }
  }
  return toImageAsyncTaskOutput(result.task);
}

/**
 * 查询当前外部 API Key 创建的图片异步任务。
 *
 * @param input 严格 taskId 输入。
 * @param principal 当前外部 API Key Principal。
 * @param context UOL 归属断言上下文。
 * @param repository 生产仓储或测试桩。
 * @returns 不含身份和生成输入的任务视图。
 * @throws OperationError 任务不存在或跨 API Key 时统一返回 not_found。
 */
export async function executeImageGetAsyncTaskBinding(
  input: { taskId: string },
  principal: Principal,
  context: OperationContext,
  repository: ImageAsyncTaskRepository = defaultImageAsyncTaskRepository
): Promise<ImageAsyncTaskOutput> {
  const task = await repository.findById(input.taskId);
  if (!task) {
    throw new OperationError("not_found", "Image async task not found");
  }
  assertImageAsyncTaskPrincipal(task, principal, context);
  return toImageAsyncTaskOutput(task);
}

bindOperationExecute(imageEnqueueAsync, (input, principal, context) =>
  executeImageEnqueueAsyncBinding(input, principal, context)
);

bindOperationExecute(imageGetAsyncTask, (input, principal, context) =>
  executeImageGetAsyncTaskBinding(input, principal, context)
);
