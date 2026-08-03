/**
 * 图片异步任务 UOL late binding。
 *
 * 职责：从外部 API Principal 构造最小持久身份，幂等创建 PostgreSQL 任务并在提交后
 * 最佳努力投递 BullMQ；查询时同时校验 userId 与 API Key 域，防止同账号 Key 间越权。
 * 使用方：根 uol-bindings 聚合器；Worker 处理 binding 在同模块后续接入。
 */
import { randomUUID } from "node:crypto";
import { normalizeSubscriptionPlan } from "@repo/shared/config/subscription-plan";
import { logError } from "@repo/shared/logger";
import type { OperationContext, Principal } from "@repo/shared/uol";
import {
  bindOperationExecute,
  isExternalApiKeyPrincipal,
  invokeOperation,
  OperationError,
} from "@repo/shared/uol";
import type {
  ImageAsyncTaskOutput,
  ImageEnqueueAsyncInput,
  ImageGenerateOperationInput,
} from "@repo/shared/uol/operations/image-generation";
import {
  imageEnqueueAsync,
  imageGetAsyncTask,
  imageProcessAsyncTask,
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

/** 图片 Worker 的单次 claim 租约；超过现有图片管线最长排队窗口后由补偿器恢复。 */
export const IMAGE_ASYNC_TASK_CLAIM_TTL_MS = 22 * 60_000;
const MAX_IMAGE_TASK_GENERATION_CONCURRENCY = 100;

/** 图片异步创建 binding 的可替换依赖。 */
export interface ImageAsyncTaskBindingDependencies {
  repository: ImageAsyncTaskRepository;
  validateCallback(value: string): Promise<string>;
  getQueuePriority(plan: string): Promise<number>;
  enqueueTask(input: { taskId: string; priority: number }): Promise<unknown>;
  reportEnqueueFailure(error: unknown, taskId: string): void;
  runGeneration(
    input: ImageGenerateOperationInput,
    principal: Principal,
    requestId: string
  ): Promise<unknown>;
  getGenerationConcurrency(plan: string): Promise<number>;
  createClaimToken(): string;
  now(): Date;
  reportGenerationFailure(error: unknown, taskId: string): void;
  deliverCallback(task: ImageAsyncTaskRecord): Promise<void>;
  reportCallbackFailure(error: unknown, taskId: string): void;
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
  async runGeneration(input, principal, requestId) {
    await import("@/server/uol-init").then(({ ensureUolInitialized }) =>
      ensureUolInitialized()
    );
    return invokeOperation("image.generate", input, principal, { requestId });
  },
  async getGenerationConcurrency(plan) {
    const { getPlanLimits } = await import(
      "@repo/shared/subscription/services/plan-capabilities"
    );
    return Math.min(
      MAX_IMAGE_TASK_GENERATION_CONCURRENCY,
      Math.max(1, (await getPlanLimits(normalizeSubscriptionPlan(plan))).imageGenerationConcurrency)
    );
  },
  createClaimToken: () => `image-worker-${randomUUID()}`,
  now: () => new Date(),
  reportGenerationFailure(error, taskId) {
    logError(error, {
      source: "image-async-task-generation",
      taskId,
    });
  },
  async deliverCallback(task) {
    if (!task.callbackUrl) return;
    const [
      { buildImageAsyncTaskPublicResponse, createImageAsyncTaskPublicSource },
      { postPublicAsyncImageCallback },
    ] = await Promise.all([
        import("@/features/external-api/image-async-task-response"),
        import("@/features/external-api/async-image-tasks"),
      ]);
    await postPublicAsyncImageCallback(
      task.callbackUrl,
      await buildImageAsyncTaskPublicResponse(
        createImageAsyncTaskPublicSource(task)
      )
    );
  },
  reportCallbackFailure(error, taskId) {
    logError(error, {
      source: "image-async-task-callback",
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
    model: task.generationInputs[0]?.model ?? "unknown",
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

/** 将 Worker 异常转换为可持久化且不泄露内部连接细节的用户错误。 */
function getImageTaskFailureMessage(error: unknown): string {
  if (error instanceof OperationError) return error.message.slice(0, 2_000);
  return "Image generation failed. Please retry later.";
}

/** 并发执行一个图片批次；每个 generationId 都由统一 image.generate 幂等保护。 */
async function runImageTaskGenerations(
  task: ImageAsyncTaskRecord,
  principal: Principal,
  dependencies: ImageAsyncTaskBindingDependencies,
  concurrency: number
): Promise<string[]> {
  const errors: string[] = [];
  let nextIndex = 0;
  const runWorker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      const input = task.generationInputs[index];
      if (!input) return;
      try {
        await dependencies.runGeneration(
          input,
          principal,
          `image-async-task:${task.id}:${input.generationId}`
        );
      } catch (error) {
        dependencies.reportGenerationFailure(error, task.id);
        errors.push(getImageTaskFailureMessage(error));
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(task.generationInputs.length, Math.max(1, concurrency)) },
      () => runWorker()
    )
  );
  return errors;
}

/**
 * 系统 Worker 按 taskId 原子 claim 并执行图片批次。
 *
 * @param input MQ 只传入的最小任务身份。
 * @param principal 必须是 system；真实用户身份从任务行恢复。
 * @param _context UOL 上下文，系统 Worker 不使用 owner 断言。
 * @param dependencies 可替换仓储、子 operation 和时钟，便于 DB-free 并发测试。
 * @returns 任务当前持久状态；重复消息遇到终态时安全返回。
 */
export async function executeImageProcessAsyncTaskBinding(
  input: { taskId: string },
  principal: Principal,
  _context: OperationContext,
  dependencies: ImageAsyncTaskBindingDependencies = defaultDependencies
): Promise<ImageAsyncTaskOutput> {
  if (principal.type !== "system") {
    throw new OperationError("forbidden", "System worker authentication required");
  }
  const now = dependencies.now();
  const claimToken = dependencies.createClaimToken();
  const claimed = await dependencies.repository.claimById({
    taskId: input.taskId,
    claimToken,
    now,
    claimExpiresAt: new Date(now.getTime() + IMAGE_ASYNC_TASK_CLAIM_TTL_MS),
  });
  if (!claimed) {
    const existing = await dependencies.repository.findById(input.taskId);
    if (!existing) {
      throw new OperationError("not_found", "Image async task not found");
    }
    if (existing.status === "completed" || existing.status === "failed") {
      return toImageAsyncTaskOutput(existing);
    }
    return toImageAsyncTaskOutput(existing);
  }

  const restoredPrincipal: Principal = {
    type: "apiKey",
    credentialKind: "external",
    userId: claimed.userId,
    apiKeyId: claimed.apiKeyId,
    plan: claimed.plan,
  };
  try {
    const concurrency = await dependencies.getGenerationConcurrency(
      claimed.plan
    );
    const errors = await runImageTaskGenerations(
      claimed,
      restoredPrincipal,
      dependencies,
      concurrency
    );
    const finished = errors.length
      ? await dependencies.repository.fail({
          taskId: claimed.id,
          claimToken,
          now: dependencies.now(),
          error: errors[0] ?? "Image generation failed. Please retry later.",
        })
      : await dependencies.repository.complete({
          taskId: claimed.id,
          claimToken,
          now: dependencies.now(),
        });
    const finalTask =
      finished ??
      (await dependencies.repository.findById(claimed.id)) ??
      claimed;
    if (
      finalTask.callbackUrl &&
      (finalTask.status === "completed" || finalTask.status === "failed")
    ) {
      try {
        await dependencies.deliverCallback(finalTask);
      } catch (error) {
        // 回调是生成后的外部通知，不得反向改写已经结算的图片和财务终态。
        dependencies.reportCallbackFailure(error, finalTask.id);
      }
    }
    return toImageAsyncTaskOutput(finalTask);
  } catch (error) {
    // WHY：配置或数据库等基础设施故障必须释放 claim 后抛给 BullMQ 重试；业务生成
    // 错误已在上方显式写 failed，不会进入此分支造成重复外呼。
    await dependencies.repository
      .release({
        taskId: claimed.id,
        claimToken,
        now: dependencies.now(),
      })
      .catch((releaseError) =>
        dependencies.reportGenerationFailure(releaseError, claimed.id)
      );
    throw error;
  }
}

bindOperationExecute(imageEnqueueAsync, (input, principal, context) =>
  executeImageEnqueueAsyncBinding(input, principal, context)
);

bindOperationExecute(imageGetAsyncTask, (input, principal, context) =>
  executeImageGetAsyncTaskBinding(input, principal, context)
);

bindOperationExecute(imageProcessAsyncTask, (input, principal, context) =>
  executeImageProcessAsyncTaskBinding(input, principal, context)
);
