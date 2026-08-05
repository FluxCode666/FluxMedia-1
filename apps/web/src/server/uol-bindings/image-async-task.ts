/**
 * 图片异步任务 UOL late binding。
 *
 * 职责：从外部 API Principal 构造最小持久身份，幂等创建 PostgreSQL 任务并在提交后
 * 最佳努力投递 BullMQ；查询时同时校验 userId 与 API Key 域，防止同账号 Key 间越权。
 * 使用方：根 uol-bindings 聚合器；Worker 处理 binding 在同模块后续接入。
 */
import { createHash, randomUUID } from "node:crypto";
import { logError } from "@repo/shared/logger";
import type { OperationContext, Principal } from "@repo/shared/uol";
import {
  bindOperationExecute,
  createConcurrencyLimitExceededError,
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
  imageProcessAsyncTask,
} from "@repo/shared/uol/operations/image-generation";
import { z } from "zod";

import { validateCallbackUrl } from "@/features/external-api/async-image-tasks";
import {
  createImageAsyncTaskInputDigest,
  defaultImageAsyncTaskRepository,
  type ImageAsyncTaskRecord,
  type ImageAsyncTaskRepository,
} from "@/features/image-generation/image-async-task-repository";
import {
  type RedisImageGenerationAdmissionAcquisition,
  type RedisImageGenerationAdmissionLease,
  type RedisImageGenerationExecutionAcquisition,
  type RedisImageGenerationExecutionLease,
  restoreImageGenerationAdmissionLease,
} from "@/features/image-generation/redis-image-generation-slots";
import type {
  ImageGenerationExecutionFence,
  ImageQuality,
} from "@/features/image-generation/types";
import { enqueueImageTask } from "@/server/media-task-queues";

/*
 * 类型与恢复函数来自同一 Redis 租约模块；Worker 只重建已持久 token，
 * 不根据数据库快照自行制造新的准入槽。
 */
type ImageAdmissionRenewal =
  | { status: "renewed"; expiresAt: number }
  | { status: "lost" };

/** 图片 Worker 的单次 claim 租约；超过现有图片管线最长排队窗口后由补偿器恢复。 */
export const IMAGE_ASYNC_TASK_CLAIM_TTL_MS = 22 * 60_000;
const IMAGE_ASYNC_TASK_HEARTBEAT_INTERVAL_MS = 5 * 60_000;
const IMAGE_ASYNC_TASK_GLOBAL_RETRY_DELAY_MS = 1_000;

const imageGenerationReconciliationRowSchema = z
  .object({
    userId: z.string().trim().min(1),
    status: z.enum(["pending", "completed", "failed"]),
    error: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict();

/** Worker 对账所需的最小 generation 视图。 */
export interface ImageGenerationReconciliationRecord {
  userId: string;
  status: "pending" | "completed" | "failed";
  error: string | null;
  inputDigest: string | null;
}

/** 图片异步创建 binding 的可替换依赖。 */
export interface ImageAsyncTaskBindingDependencies {
  repository: ImageAsyncTaskRepository;
  validateCallback(value: string): Promise<string>;
  getMediaLimitsForUser(userId: string): Promise<{
    limit: number;
    effectiveSource: "system_default" | "user_override";
  }>;
  resolveGroupSnapshot(input: {
    userId: string;
    apiKeyId: string;
    requestedGroupId?: string;
  }): Promise<{ id: string; priority: number }>;
  acquireAdmission(input: {
    userId: string;
    userConcurrency: number;
    token: string;
  }): Promise<RedisImageGenerationAdmissionAcquisition>;
  renewAdmission(
    lease: RedisImageGenerationAdmissionLease
  ): Promise<ImageAdmissionRenewal>;
  releaseAdmission(lease: RedisImageGenerationAdmissionLease): Promise<void>;
  getGlobalConcurrency(): Promise<number>;
  acquireExecution(input: {
    globalConcurrency: number;
  }): Promise<RedisImageGenerationExecutionAcquisition>;
  renewExecution(
    lease: RedisImageGenerationExecutionLease
  ): Promise<ImageAdmissionRenewal>;
  releaseExecution(lease: RedisImageGenerationExecutionLease): Promise<void>;
  enqueueTask(input: {
    taskId: string;
    deliveryVersion: number;
    priority: number;
    runAt?: Date;
  }): Promise<unknown>;
  reportEnqueueFailure(error: unknown, taskId: string): void;
  isApiKeyActive(input: { userId: string; apiKeyId: string }): Promise<boolean>;
  findGeneration(
    generationId: string
  ): Promise<ImageGenerationReconciliationRecord | null>;
  runGeneration(input: {
    task: ImageAsyncTaskRecord;
    admissionLease: RedisImageGenerationAdmissionLease;
    executionLease: RedisImageGenerationExecutionLease;
    executionFence: ImageGenerationExecutionFence;
  }): Promise<{ generationId: string }>;
  createClaimToken(): string;
  now(): Date;
  reportGenerationFailure(error: unknown, taskId: string): void;
  deliverCallback(task: ImageAsyncTaskRecord): Promise<void>;
  reportCallbackFailure(error: unknown, taskId: string): void;
}

const defaultDependencies: ImageAsyncTaskBindingDependencies = {
  repository: defaultImageAsyncTaskRepository,
  validateCallback: validateCallbackUrl,
  async getMediaLimitsForUser(userId) {
    const { mediaLimitService } = await import(
      "@repo/shared/image-generation/media-limit-service"
    );
    return mediaLimitService.getForUser(userId);
  },
  async resolveGroupSnapshot(input) {
    const { resolveTrustedGroupSnapshot } = await import(
      "@/features/image-backend-pool/runtime-service"
    );
    const snapshot = await resolveTrustedGroupSnapshot(input);
    return { id: snapshot.id, priority: snapshot.priority };
  },
  async acquireAdmission(input) {
    const { acquireImageGenerationAdmission } = await import(
      "@/features/image-generation/redis-image-generation-slots"
    );
    return acquireImageGenerationAdmission(input);
  },
  async renewAdmission(lease) {
    const { renewImageGenerationAdmission } = await import(
      "@/features/image-generation/redis-image-generation-slots"
    );
    return renewImageGenerationAdmission(lease);
  },
  async releaseAdmission(lease) {
    const { releaseImageGenerationAdmission } = await import(
      "@/features/image-generation/redis-image-generation-slots"
    );
    return releaseImageGenerationAdmission(lease);
  },
  async getGlobalConcurrency() {
    const { getImageGenerationGlobalConcurrency } = await import(
      "@/features/image-generation/queue"
    );
    return getImageGenerationGlobalConcurrency();
  },
  async acquireExecution(input) {
    const { acquireImageGenerationExecution } = await import(
      "@/features/image-generation/redis-image-generation-slots"
    );
    return acquireImageGenerationExecution(input);
  },
  async renewExecution(lease) {
    const { renewImageGenerationExecution } = await import(
      "@/features/image-generation/redis-image-generation-slots"
    );
    return renewImageGenerationExecution(lease);
  },
  async releaseExecution(lease) {
    const { releaseImageGenerationExecution } = await import(
      "@/features/image-generation/redis-image-generation-slots"
    );
    return releaseImageGenerationExecution(lease);
  },
  enqueueTask: enqueueImageTask,
  reportEnqueueFailure(error, taskId) {
    logError(error, {
      source: "image-async-task-mq-enqueue",
      taskId,
    });
  },
  async isApiKeyActive(input) {
    const [{ db }, { externalApiKey }, { and, eq }] = await Promise.all([
      import("@repo/database"),
      import("@repo/database/schema"),
      import("drizzle-orm"),
    ]);
    const [row] = await db
      .select({ id: externalApiKey.id })
      .from(externalApiKey)
      .where(
        and(
          eq(externalApiKey.id, input.apiKeyId),
          eq(externalApiKey.userId, input.userId),
          eq(externalApiKey.isActive, true)
        )
      )
      .limit(1);
    return Boolean(row);
  },
  async findGeneration(generationId) {
    const [{ db }, { generation }, { eq }] = await Promise.all([
      import("@repo/database"),
      import("@repo/database/schema"),
      import("drizzle-orm"),
    ]);
    const [rawRow] = await db
      .select({
        userId: generation.userId,
        status: generation.status,
        error: generation.error,
        metadata: generation.metadata,
      })
      .from(generation)
      .where(eq(generation.id, generationId))
      .limit(1);
    if (!rawRow) return null;
    const row = imageGenerationReconciliationRowSchema.parse(rawRow);
    const inputDigest = row.metadata?.uolInputDigest;
    return {
      userId: row.userId,
      status: row.status,
      error: row.error,
      inputDigest: typeof inputDigest === "string" ? inputDigest : null,
    };
  },
  async runGeneration({
    task,
    admissionLease,
    executionLease,
    executionFence,
  }) {
    if (
      task.effectiveUserConcurrency === null ||
      !task.groupIdSnapshot ||
      task.groupPrioritySnapshot === null
    ) {
      throw new Error("图片异步任务缺少执行策略快照");
    }
    const { runImageGenerationForUser } = await import(
      "@/features/image-generation/operations"
    );
    const input = task.generationInput;
    const common = {
      userId: task.userId,
      apiKeyId: task.apiKeyId,
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
      inputDigest: task.inputDigest,
      executionFence,
      executionAuthorization: { lease: executionLease },
      admissionAuthorization: {
        userId: task.userId,
        lease: admissionLease,
        limit: task.effectiveUserConcurrency,
        effectiveSource: "system_default" as const,
      },
      groupAuthorization: {
        groupId: task.groupIdSnapshot,
        priority: task.groupPrioritySnapshot,
      },
    };
    const result =
      input.operation === "generate"
        ? await runImageGenerationForUser({ mode: "generate", ...common })
        : await runImageGenerationForUser({
            mode: "edit",
            ...common,
            images: [],
            mediaInputReferences: {
              images: input.images,
              ...(input.operation === "mask" ? { mask: input.mask } : {}),
            },
          });
    await executionFence.assertActive();
    if (result.error) {
      throw new OperationError(
        result.errorCode ?? "upstream_error",
        result.error,
        result.errorDetails
      );
    }
    if (result.generationId !== task.generationId) {
      throw new OperationError(
        "idempotency_conflict",
        "Image generation result does not match the async task"
      );
    }
    return { generationId: result.generationId };
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
    model: task.generationInput.model,
    operation: task.operation,
    status: task.status,
    generationId: task.generationId,
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
  if (
    task.userId !== principal.userId ||
    task.apiKeyId !== principal.apiKeyId
  ) {
    throw new OperationError("not_found", "Image async task not found");
  }
  context.assertOwnership("image async task", task.userId);
}

/** 校验相同 taskId 的幂等重放没有改变图片输入或回调目标。 */
function assertImageAsyncTaskReplay(
  task: ImageAsyncTaskRecord,
  input: ImageEnqueueAsyncInput
): void {
  if (
    task.id !== input.taskId ||
    task.inputDigest !==
      createImageAsyncTaskInputDigest(input.generationInput) ||
    task.generationId !== input.generationInput.generationId ||
    task.responseFormat !== input.responseFormat ||
    task.callbackUrl !== (input.callbackUrl ?? null)
  ) {
    throw new OperationError(
      "idempotency_conflict",
      "taskId was already used with different image async input"
    );
  }
}

/** 为同一用户和 taskId 派生可重入且不泄露原始标识的 Redis lease token。 */
function createImageAsyncAdmissionToken(
  userId: string,
  taskId: string
): string {
  return `image-task:${createHash("sha256")
    .update(`${userId}\0${taskId}`)
    .digest("hex")}`;
}

/** 在 Redis 服务端 expiry 的前半段安排续期，避免依赖应用服务器绝对时钟。 */
function getAdmissionRenewalDueAt(now: Date, expiresAt: number): Date {
  const remainingMs = expiresAt - now.getTime();
  if (remainingMs <= 1) {
    throw new Error("图片异步任务取得的用户准入租约已过期");
  }
  return new Date(now.getTime() + Math.floor(remainingMs / 2));
}

/** 把持久分组快照映射为 BullMQ 正整数 priority；零仍表示最高业务优先级。 */
function getImageTaskQueuePriority(task: ImageAsyncTaskRecord): number {
  if (task.groupPrioritySnapshot === null) {
    throw new Error("图片异步任务缺少分组优先级快照");
  }
  return task.groupPrioritySnapshot + 1;
}

/** 新任务持久化失败时释放尚未被任务行采用的用户准入槽。 */
async function releaseUnadoptedAdmission(
  dependencies: ImageAsyncTaskBindingDependencies,
  lease: RedisImageGenerationAdmissionLease,
  taskId: string
): Promise<void> {
  try {
    await dependencies.releaseAdmission(lease);
  } catch (error) {
    dependencies.reportEnqueueFailure(error, taskId);
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
  const existing = await dependencies.repository.findById(input.taskId);
  if (existing) {
    assertImageAsyncTaskPrincipal(existing, principal, context);
    assertImageAsyncTaskReplay(existing, normalizedInput);
    if (existing.status === "completed" || existing.status === "failed") {
      return toImageAsyncTaskOutput(existing);
    }
  }

  const mediaLimits = await dependencies.getMediaLimitsForUser(
    principal.userId
  );
  const admissionToken =
    existing?.admissionLeaseToken ??
    createImageAsyncAdmissionToken(principal.userId, input.taskId);
  if (!admissionToken) {
    throw new OperationError(
      "internal_error",
      "Image async task is missing admission state"
    );
  }
  const admission = await dependencies.acquireAdmission({
    userId: principal.userId,
    userConcurrency: existing?.effectiveUserConcurrency ?? mediaLimits.limit,
    token: admissionToken,
  });
  if (admission.status === "blocked") {
    throw createConcurrencyLimitExceededError({
      limit: existing?.effectiveUserConcurrency ?? mediaLimits.limit,
      effectiveSource: mediaLimits.effectiveSource,
    });
  }
  const now = dependencies.now();
  const admissionLeaseExpiresAt = new Date(admission.lease.expiresAt);
  const admissionRenewalDueAt = getAdmissionRenewalDueAt(
    now,
    admission.lease.expiresAt
  );

  if (existing) {
    const updated = await dependencies.repository.updateAdmissionLease({
      taskId: existing.id,
      admissionLeaseToken: admission.lease.token,
      admissionLeaseExpiresAt,
      admissionRenewalDueAt,
      now,
    });
    if (!updated) {
      await releaseUnadoptedAdmission(
        dependencies,
        admission.lease,
        existing.id
      );
      return toImageAsyncTaskOutput(
        (await dependencies.repository.findById(existing.id)) ?? existing
      );
    }
    try {
      await dependencies.enqueueTask({
        taskId: updated.id,
        deliveryVersion: updated.mqDeliveryVersion,
        priority: getImageTaskQueuePriority(updated),
      });
      if (updated.mqDeliveryDueAt) {
        await dependencies.repository.markMqDelivered({
          taskId: updated.id,
          deliveryVersion: updated.mqDeliveryVersion,
          mqDeliveryDueAt: updated.mqDeliveryDueAt,
          now: dependencies.now(),
        });
      }
    } catch (error) {
      dependencies.reportEnqueueFailure(error, updated.id);
    }
    return toImageAsyncTaskOutput(updated);
  }

  let leaseAdopted = false;
  try {
    const groupSnapshot = await dependencies.resolveGroupSnapshot({
      userId: principal.userId,
      apiKeyId: principal.apiKeyId,
      ...(input.generationInput.backendGroupId
        ? { requestedGroupId: input.generationInput.backendGroupId }
        : {}),
    });
    const result = await dependencies.repository.create({
      task: normalizedInput,
      userId: principal.userId,
      apiKeyId: principal.apiKeyId,
      legacyPlan: principal.plan,
      effectiveUserConcurrency: mediaLimits.limit,
      groupIdSnapshot: groupSnapshot.id,
      groupPrioritySnapshot: groupSnapshot.priority,
      admissionLeaseToken: admission.lease.token,
      admissionLeaseExpiresAt,
      admissionRenewalDueAt,
      now,
    });
    leaseAdopted = result.task.admissionLeaseToken === admission.lease.token;
    assertImageAsyncTaskPrincipal(result.task, principal, context);
    assertImageAsyncTaskReplay(result.task, normalizedInput);

    if (result.task.status === "queued") {
      try {
        await dependencies.enqueueTask({
          taskId: result.task.id,
          deliveryVersion: result.task.mqDeliveryVersion,
          priority: getImageTaskQueuePriority(result.task),
        });
        if (result.task.mqDeliveryDueAt) {
          await dependencies.repository.markMqDelivered({
            taskId: result.task.id,
            deliveryVersion: result.task.mqDeliveryVersion,
            mqDeliveryDueAt: result.task.mqDeliveryDueAt,
            now: dependencies.now(),
          });
        }
      } catch (error) {
        // WHY：数据库已提交后 Redis 失败不能回滚任务；due 扫描会按同一优先级补投。
        dependencies.reportEnqueueFailure(error, result.task.id);
      }
    }
    return toImageAsyncTaskOutput(result.task);
  } finally {
    if (!leaseAdopted) {
      await releaseUnadoptedAdmission(
        dependencies,
        admission.lease,
        input.taskId
      );
    }
  }
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

/** 从任务真相重建用户准入租约；缺失状态必须失败关闭。 */
function restoreImageTaskAdmissionLease(
  task: ImageAsyncTaskRecord
): RedisImageGenerationAdmissionLease {
  if (!task.admissionLeaseToken || !task.admissionLeaseExpiresAt) {
    throw new OperationError(
      "internal_error",
      "Image async task is missing admission lease state"
    );
  }
  return restoreImageGenerationAdmissionLease({
    userId: task.userId,
    token: task.admissionLeaseToken,
    expiresAt: task.admissionLeaseExpiresAt,
  });
}

/** 校验 generation 真相仍属于当前用户和同一规范化输入。 */
function assertGenerationMatchesImageTask(
  task: ImageAsyncTaskRecord,
  generation: ImageGenerationReconciliationRecord
): void {
  if (
    generation.userId !== task.userId ||
    generation.inputDigest !== task.inputDigest
  ) {
    throw new OperationError(
      "idempotency_conflict",
      "Persisted generation does not match the image async task"
    );
  }
}

/** 把 generation 终态以当前 claim token 投影到任务行。 */
async function settleImageTaskFromGeneration(
  task: ImageAsyncTaskRecord,
  claimToken: string,
  generation: ImageGenerationReconciliationRecord,
  dependencies: ImageAsyncTaskBindingDependencies
): Promise<{ task: ImageAsyncTaskRecord; transitioned: boolean }> {
  if (generation.status === "pending") {
    throw new OperationError(
      "not_ready",
      "Image generation is still pending reconciliation"
    );
  }
  const settled =
    generation.status === "completed"
      ? await dependencies.repository.complete({
          taskId: task.id,
          claimToken,
          now: dependencies.now(),
        })
      : await dependencies.repository.fail({
          taskId: task.id,
          claimToken,
          now: dependencies.now(),
          error:
            generation.error?.slice(0, 2_000) ??
            "Image generation failed. Please retry later.",
        });
  return {
    task: settled ?? (await dependencies.repository.findById(task.id)) ?? task,
    transitioned: Boolean(settled),
  };
}

/** 终态提交后释放 Redis admission，并以 token CAS 写入持久确认。 */
async function releaseTerminalImageTaskAdmission(
  task: ImageAsyncTaskRecord,
  dependencies: ImageAsyncTaskBindingDependencies
): Promise<ImageAsyncTaskRecord> {
  if (
    (task.status !== "completed" && task.status !== "failed") ||
    task.admissionLeaseReleasedAt ||
    !task.admissionLeaseToken ||
    !task.admissionLeaseExpiresAt
  ) {
    return task;
  }
  try {
    const lease = restoreImageTaskAdmissionLease(task);
    await dependencies.releaseAdmission(lease);
    return (
      (await dependencies.repository.markAdmissionReleased({
        taskId: task.id,
        admissionLeaseToken: lease.token,
        now: dependencies.now(),
      })) ??
      (await dependencies.repository.findById(task.id)) ??
      task
    );
  } catch (error) {
    // WHY：任务终态已经提交，释放或 ack 失败只能保留 terminal due 供恢复扫描收敛。
    dependencies.reportGenerationFailure(error, task.id);
    return task;
  }
}

/** 释放短生命周期全站执行槽；失败只等待 Redis TTL，不能重跑已产生副作用的管线。 */
async function releaseImageTaskExecutionSafely(
  taskId: string,
  lease: RedisImageGenerationExecutionLease,
  dependencies: ImageAsyncTaskBindingDependencies
): Promise<void> {
  try {
    await dependencies.releaseExecution(lease);
  } catch (error) {
    dependencies.reportGenerationFailure(error, taskId);
  }
}

/**
 * 全站槽满时释放 claim 并投递带持久 priority 的 delayed 新代次。
 *
 * admission 不释放，任务也不写 failed；Queue.add 失败时保留 MQ due，由恢复扫描补投。
 */
async function deferImageTaskForGlobalCapacity(
  task: ImageAsyncTaskRecord,
  claimToken: string,
  dependencies: ImageAsyncTaskBindingDependencies
): Promise<ImageAsyncTaskRecord> {
  const now = dependencies.now();
  const queued = await dependencies.repository.release({
    taskId: task.id,
    claimToken,
    now,
  });
  if (!queued) {
    return (await dependencies.repository.findById(task.id)) ?? task;
  }
  try {
    await dependencies.enqueueTask({
      taskId: queued.id,
      deliveryVersion: queued.mqDeliveryVersion,
      priority: getImageTaskQueuePriority(queued),
      runAt: new Date(now.getTime() + IMAGE_ASYNC_TASK_GLOBAL_RETRY_DELAY_MS),
    });
    if (!queued.mqDeliveryDueAt) return queued;
    return (
      (await dependencies.repository.markMqDelivered({
        taskId: queued.id,
        deliveryVersion: queued.mqDeliveryVersion,
        mqDeliveryDueAt: queued.mqDeliveryDueAt,
        now: dependencies.now(),
      })) ?? queued
    );
  } catch (error) {
    dependencies.reportEnqueueFailure(error, task.id);
    return queued;
  }
}

/** 只有赢得终态 CAS 的 Worker 才投递 callback，避免重复消息重复通知。 */
async function deliverImageTaskCallbackAfterTransition(
  task: ImageAsyncTaskRecord,
  transitioned: boolean,
  dependencies: ImageAsyncTaskBindingDependencies
): Promise<void> {
  if (!transitioned || !task.callbackUrl) return;
  try {
    await dependencies.deliverCallback(task);
  } catch (error) {
    // 回调是生成后的外部通知，不得反向改写已经结算的图片和财务终态。
    dependencies.reportCallbackFailure(error, task.id);
  }
}

/** 同时续期 Redis admission 与 PostgreSQL claim；任一 fencing CAS 失败即停工。 */
async function renewImageTaskWorkerLeases(
  task: ImageAsyncTaskRecord,
  claimToken: string,
  leases: {
    admission: RedisImageGenerationAdmissionLease;
    execution: RedisImageGenerationExecutionLease;
  },
  dependencies: ImageAsyncTaskBindingDependencies
): Promise<{
  admission: RedisImageGenerationAdmissionLease;
  execution: RedisImageGenerationExecutionLease;
}> {
  const [admissionRenewal, executionRenewal] = await Promise.all([
    dependencies.renewAdmission(leases.admission),
    dependencies.renewExecution(leases.execution),
  ]);
  if (admissionRenewal.status === "lost") {
    throw new OperationError(
      "conflict",
      "Image async task admission lease was lost"
    );
  }
  if (executionRenewal.status === "lost") {
    throw new OperationError(
      "conflict",
      "Image async task global execution lease was lost"
    );
  }
  const now = dependencies.now();
  const admissionLeaseExpiresAt = new Date(admissionRenewal.expiresAt);
  const heartbeat = await dependencies.repository.heartbeatClaim({
    taskId: task.id,
    claimToken,
    admissionLeaseToken: leases.admission.token,
    now,
    claimExpiresAt: new Date(now.getTime() + IMAGE_ASYNC_TASK_CLAIM_TTL_MS),
    admissionLeaseExpiresAt,
    admissionRenewalDueAt: getAdmissionRenewalDueAt(
      now,
      admissionRenewal.expiresAt
    ),
  });
  if (!heartbeat) {
    throw new OperationError("conflict", "Image async task claim was lost");
  }
  return {
    admission: {
      ...leases.admission,
      expiresAt: admissionRenewal.expiresAt,
    },
    execution: {
      ...leases.execution,
      expiresAt: executionRenewal.expiresAt,
    },
  };
}

/**
 * 在长任务执行期间串行续期，并把首个 fencing 失败广播为取消信号。
 *
 * 主动 `assertActive` 与周期心跳共享同一 Promise 链，避免并行 CAS 乱序；一旦 claim 或
 * admission 丢失，后续所有副作用边界都会收到同一失败原因。
 */
function startImageTaskWorkerHeartbeat(
  task: ImageAsyncTaskRecord,
  claimToken: string,
  initialLeases: {
    admission: RedisImageGenerationAdmissionLease;
    execution: RedisImageGenerationExecutionLease;
  },
  dependencies: ImageAsyncTaskBindingDependencies
): {
  executionFence: ImageGenerationExecutionFence;
  stop(): Promise<{
    leases: {
      admission: RedisImageGenerationAdmissionLease;
      execution: RedisImageGenerationExecutionLease;
    };
    error: unknown | null;
  }>;
} {
  let leases = initialLeases;
  let heartbeatError: unknown | null = null;
  let inFlight = Promise.resolve();
  const abortController = new AbortController();

  /** 串行执行一次租约复核；首个失败会中止管线且保持稳定错误。 */
  const scheduleRenewal = (): Promise<void> => {
    const renewal = inFlight.then(async () => {
      if (heartbeatError) throw heartbeatError;
      try {
        leases = await renewImageTaskWorkerLeases(
          task,
          claimToken,
          leases,
          dependencies
        );
      } catch (error) {
        heartbeatError = error;
        abortController.abort(error);
        throw error;
      }
    });
    inFlight = renewal.catch(() => undefined);
    return renewal;
  };
  const timer = setInterval(() => {
    void scheduleRenewal().catch(() => undefined);
  }, IMAGE_ASYNC_TASK_HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return {
    executionFence: {
      signal: abortController.signal,
      async assertActive() {
        if (heartbeatError) throw heartbeatError;
        await scheduleRenewal();
      },
    },
    async stop() {
      clearInterval(timer);
      await inFlight;
      return { leases, error: heartbeatError };
    },
  };
}

/** 不具备安全重试语义的领域错误会收敛任务失败，其余错误交回 BullMQ。 */
function shouldRetryImageTaskError(error: unknown): boolean {
  return (
    !(error instanceof OperationError) ||
    error.code === "internal_error" ||
    error.code === "not_ready" ||
    error.code === "timeout" ||
    error.code === "conflict"
  );
}

/**
 * 系统 Worker 按 taskId 原子 claim 并执行单项图片任务。
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
    throw new OperationError(
      "forbidden",
      "System worker authentication required"
    );
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

  let heartbeat: ReturnType<typeof startImageTaskWorkerHeartbeat> | undefined;
  let executionLease: RedisImageGenerationExecutionLease | undefined;
  try {
    const existingGeneration = await dependencies.findGeneration(
      claimed.generationId
    );
    if (existingGeneration) {
      assertGenerationMatchesImageTask(claimed, existingGeneration);
      const settlement = await settleImageTaskFromGeneration(
        claimed,
        claimToken,
        existingGeneration,
        dependencies
      );
      const terminal = await releaseTerminalImageTaskAdmission(
        settlement.task,
        dependencies
      );
      await deliverImageTaskCallbackAfterTransition(
        terminal,
        settlement.transitioned,
        dependencies
      );
      return toImageAsyncTaskOutput(terminal);
    }

    // WHY：API Key 复核只约束新的生成副作用。generation 已存在时必须先按持久真相
    // 对账，否则 Key 在外呼或扣费后被停用会把已完成任务错误投影为失败。
    if (
      !(await dependencies.isApiKeyActive({
        userId: claimed.userId,
        apiKeyId: claimed.apiKeyId,
      }))
    ) {
      const failed = await dependencies.repository.fail({
        taskId: claimed.id,
        claimToken,
        now: dependencies.now(),
        error: "用于创建该任务的 API Key 已停用",
      });
      const terminal = await releaseTerminalImageTaskAdmission(
        failed ??
          (await dependencies.repository.findById(claimed.id)) ??
          claimed,
        dependencies
      );
      await deliverImageTaskCallbackAfterTransition(
        terminal,
        Boolean(failed),
        dependencies
      );
      return toImageAsyncTaskOutput(terminal);
    }

    const execution = await dependencies.acquireExecution({
      globalConcurrency: await dependencies.getGlobalConcurrency(),
    });
    if (execution.status === "blocked") {
      return toImageAsyncTaskOutput(
        await deferImageTaskForGlobalCapacity(claimed, claimToken, dependencies)
      );
    }
    executionLease = execution.lease;
    let workerLeases = await renewImageTaskWorkerLeases(
      claimed,
      claimToken,
      {
        admission: restoreImageTaskAdmissionLease(claimed),
        execution: executionLease,
      },
      dependencies
    );
    executionLease = workerLeases.execution;
    heartbeat = startImageTaskWorkerHeartbeat(
      claimed,
      claimToken,
      workerLeases,
      dependencies
    );

    let generationError: unknown | null = null;
    try {
      await dependencies.runGeneration({
        task: claimed,
        admissionLease: workerLeases.admission,
        executionLease: workerLeases.execution,
        executionFence: heartbeat.executionFence,
      });
    } catch (error) {
      generationError = error;
      dependencies.reportGenerationFailure(error, claimed.id);
    }
    const heartbeatResult = await heartbeat.stop();
    heartbeat = undefined;
    workerLeases = heartbeatResult.leases;
    executionLease = workerLeases.execution;
    await releaseImageTaskExecutionSafely(
      claimed.id,
      executionLease,
      dependencies
    );
    executionLease = undefined;

    // WHY：旧 Worker 已知失去 claim/admission 后不得再投影 generation 终态、释放
    // admission 或投递 callback；generation 真相由下一位合法 claim 持有者负责收敛。
    if (heartbeatResult.error) throw heartbeatResult.error;

    const generated = await dependencies.findGeneration(claimed.generationId);
    if (generated) {
      assertGenerationMatchesImageTask(claimed, generated);
      if (generated.status !== "pending") {
        const settlement = await settleImageTaskFromGeneration(
          claimed,
          claimToken,
          generated,
          dependencies
        );
        const terminal = await releaseTerminalImageTaskAdmission(
          settlement.task,
          dependencies
        );
        await deliverImageTaskCallbackAfterTransition(
          terminal,
          settlement.transitioned,
          dependencies
        );
        return toImageAsyncTaskOutput(terminal);
      }
      throw new OperationError(
        "not_ready",
        "Image generation is still pending reconciliation"
      );
    }
    if (!generationError) {
      throw new OperationError(
        "internal_error",
        "Image generation completed without persisted state"
      );
    }
    if (shouldRetryImageTaskError(generationError)) throw generationError;

    const failed = await dependencies.repository.fail({
      taskId: claimed.id,
      claimToken,
      now: dependencies.now(),
      error: getImageTaskFailureMessage(generationError),
    });
    const terminal = await releaseTerminalImageTaskAdmission(
      failed ?? (await dependencies.repository.findById(claimed.id)) ?? claimed,
      dependencies
    );
    await deliverImageTaskCallbackAfterTransition(
      terminal,
      Boolean(failed),
      dependencies
    );
    return toImageAsyncTaskOutput(terminal);
  } catch (error) {
    if (heartbeat) {
      const stopped = await heartbeat.stop();
      executionLease = stopped.leases.execution;
      if (stopped.error) {
        dependencies.reportGenerationFailure(stopped.error, claimed.id);
      }
    }
    // WHY：基础设施故障或 generation pending 必须释放 claim 后重试；已有 generation
    // 会在下一次 claim 时先对账，绝不会再次外呼。
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
  } finally {
    if (executionLease) {
      await releaseImageTaskExecutionSafely(
        claimed.id,
        executionLease,
        dependencies
      );
    }
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
