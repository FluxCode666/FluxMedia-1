/**
 * 图片异步任务 UOL binding 测试。
 *
 * 职责：验证单项任务创建、用户准入与分组快照、Worker 的 API Key 复核、
 * generation 对账、claim/admission heartbeat、终态释放确认及 callback 单次投递。
 */
import {
  type OperationContext,
  OperationError,
  type Principal,
} from "@repo/shared/uol";
import { describe, expect, it, vi } from "vitest";

import {
  createImageAsyncTaskInputDigest,
  type ImageAsyncTaskRecord,
  type ImageAsyncTaskRepository,
} from "@/features/image-generation/image-async-task-repository";
import {
  executeImageEnqueueAsyncBinding,
  executeImageGetAsyncTaskBinding,
  executeImageProcessAsyncTaskBinding,
  type ImageAsyncTaskBindingDependencies,
  type ImageGenerationReconciliationRecord,
} from "./image-async-task";

const NOW = new Date("2026-08-04T00:00:00.000Z");
const LEASE_EXPIRES_AT = new Date(NOW.getTime() + 22 * 60_000);
const RENEWAL_DUE_AT = new Date(NOW.getTime() + 11 * 60_000);
const GENERATION_INPUT = {
  operation: "generate" as const,
  prompt: "test image",
  model: "gpt-image-2",
  generationId: "generation-1",
};
const INPUT_DIGEST = createImageAsyncTaskInputDigest(GENERATION_INPUT);
const principal = {
  type: "apiKey",
  credentialKind: "external",
  userId: "user-1",
  apiKeyId: "key-1",
} satisfies Principal;

/** 创建一个具备完整策略和准入快照的图片异步任务。 */
function createTask(
  overrides: Partial<ImageAsyncTaskRecord> = {}
): ImageAsyncTaskRecord {
  return {
    id: "task_123",
    userId: "user-1",
    apiKeyId: "key-1",
    operation: "generate",
    generationInput: GENERATION_INPUT,
    inputDigest: INPUT_DIGEST,
    generationId: "generation-1",
    effectiveUserConcurrency: 20,
    groupIdSnapshot: "group-1",
    groupPrioritySnapshot: 7,
    admissionLeaseToken: "admission-1",
    admissionLeaseExpiresAt: LEASE_EXPIRES_AT,
    admissionLeaseReleasedAt: null,
    mqDeliveryVersion: 0,
    mqDeliveryDueAt: NOW,
    claimRecoveryDueAt: null,
    admissionRenewalDueAt: RENEWAL_DUE_AT,
    terminalReleaseDueAt: null,
    responseFormat: "url",
    callbackUrl: "https://callback.example.com/images",
    status: "queued",
    attemptCount: 0,
    claimToken: null,
    claimExpiresAt: null,
    error: null,
    createdAt: NOW,
    startedAt: null,
    completedAt: null,
    updatedAt: NOW,
    ...overrides,
  };
}

/** 把任务转换为当前 Worker 已成功 claim 的运行态。 */
function createRunningTask(
  overrides: Partial<ImageAsyncTaskRecord> = {}
): ImageAsyncTaskRecord {
  return createTask({
    status: "running",
    attemptCount: 1,
    claimToken: "worker-1",
    claimExpiresAt: LEASE_EXPIRES_AT,
    claimRecoveryDueAt: LEASE_EXPIRES_AT,
    mqDeliveryDueAt: null,
    startedAt: NOW,
    ...overrides,
  });
}

/** 构造带 release due 的终态任务。 */
function createTerminalTask(
  status: "completed" | "failed",
  overrides: Partial<ImageAsyncTaskRecord> = {}
): ImageAsyncTaskRecord {
  return createTask({
    status,
    attemptCount: 1,
    mqDeliveryDueAt: null,
    claimRecoveryDueAt: null,
    admissionRenewalDueAt: null,
    terminalReleaseDueAt: NOW,
    completedAt: NOW,
    error: status === "failed" ? "上游失败" : null,
    ...overrides,
  });
}

/** 创建完整仓储桩；各测试只覆盖需要改变的 CAS 结果。 */
function createRepository(task: ImageAsyncTaskRecord) {
  return {
    create: vi.fn(async () => ({ task, created: true })),
    findById: vi.fn(async (): Promise<ImageAsyncTaskRecord | null> => null),
    updateAdmissionLease: vi.fn(
      async (): Promise<ImageAsyncTaskRecord | null> => task
    ),
    markMqDelivered: vi.fn(
      async (): Promise<ImageAsyncTaskRecord | null> => task
    ),
    prepareClaimRecoveryDelivery: vi.fn(
      async (): Promise<ImageAsyncTaskRecord | null> => task
    ),
    deferAdmissionRenewal: vi.fn(
      async (): Promise<ImageAsyncTaskRecord | null> => task
    ),
    heartbeatClaim: vi.fn(
      async (): Promise<ImageAsyncTaskRecord | null> => task
    ),
    markAdmissionReleased: vi.fn(
      async (): Promise<ImageAsyncTaskRecord | null> => task
    ),
    claimById: vi.fn(async (): Promise<ImageAsyncTaskRecord | null> => null),
    release: vi.fn(async (): Promise<ImageAsyncTaskRecord | null> => task),
    complete: vi.fn(async (): Promise<ImageAsyncTaskRecord | null> => task),
    fail: vi.fn(async (): Promise<ImageAsyncTaskRecord | null> => task),
  } satisfies ImageAsyncTaskRepository;
}

/** 创建记录归属断言的 UOL 上下文。 */
function createContext() {
  return {
    requestId: "request-1",
    assertOwnership: vi.fn(),
  } satisfies OperationContext;
}

/** 创建可观察 DB、Redis、MQ、生成与 callback 顺序的依赖桩。 */
function createDependencies(task = createTask()) {
  const calls: string[] = [];
  const repository = createRepository(task);
  repository.create.mockImplementation(async () => {
    calls.push("database");
    return { task, created: true };
  });
  repository.markMqDelivered.mockImplementation(async () => {
    calls.push("mq-ack");
    return task;
  });
  repository.markAdmissionReleased.mockImplementation(async () => {
    calls.push("release-ack");
    return createTask({
      ...task,
      admissionLeaseReleasedAt: NOW,
      terminalReleaseDueAt: null,
    });
  });
  const dependencies: ImageAsyncTaskBindingDependencies = {
    repository,
    validateCallback: vi.fn(async () => {
      calls.push("callback-validation");
      return "https://callback.example.com/images";
    }),
    getMediaLimitsForUser: vi.fn(async () => ({
      limit: 20,
      effectiveSource: "system_default" as const,
      maxFileSizeMb: 5,
      maxUploadSizeMb: 75,
      maxEditReferenceImages: 16,
      maxFileSizeBytes: 5 * 1024 * 1024,
      maxUploadSizeBytes: 75 * 1024 * 1024,
    })),
    resolveGroupSnapshot: vi.fn(async () => {
      calls.push("group");
      return { id: "group-1", priority: 7 };
    }),
    acquireAdmission: vi.fn(async () => {
      calls.push("admission");
      return {
        status: "acquired" as const,
        lease: {
          token: "admission-1",
          userKey: "user-key-1",
          expiresAt: LEASE_EXPIRES_AT.getTime(),
        },
      };
    }),
    renewAdmission: vi.fn(async () => ({
      status: "renewed" as const,
      expiresAt: LEASE_EXPIRES_AT.getTime(),
    })),
    releaseAdmission: vi.fn(async () => {
      calls.push("release");
    }),
    getGlobalConcurrency: vi.fn(async () => 500),
    acquireExecution: vi.fn(async () => ({
      status: "acquired" as const,
      lease: {
        token: "execution-1",
        expiresAt: LEASE_EXPIRES_AT.getTime(),
      },
    })),
    renewExecution: vi.fn(async () => ({
      status: "renewed" as const,
      expiresAt: LEASE_EXPIRES_AT.getTime(),
    })),
    releaseExecution: vi.fn(async () => {
      calls.push("execution-release");
    }),
    enqueueTask: vi.fn(async () => {
      calls.push("queue");
      return undefined;
    }),
    reportEnqueueFailure: vi.fn(),
    isApiKeyActive: vi.fn(async () => true),
    findGeneration: vi.fn(
      async () => null as ImageGenerationReconciliationRecord | null
    ),
    runGeneration: vi.fn(async () => ({ generationId: "generation-1" })),
    createClaimToken: vi.fn(() => "worker-1"),
    now: vi.fn(() => NOW),
    reportGenerationFailure: vi.fn(),
    deliverCallback: vi.fn(async () => {
      calls.push("callback");
    }),
    reportCallbackFailure: vi.fn(),
  };
  return { calls, dependencies, repository };
}

const input = {
  taskId: "task_123",
  generationInput: GENERATION_INPUT,
  responseFormat: "url" as const,
  callbackUrl: "https://callback.example.com/images",
};

describe("image async task UOL bindings", () => {
  it("新建异步任务前应用系统媒体大小策略", async () => {
    const { dependencies, repository } = createDependencies();
    vi.mocked(dependencies.getMediaLimitsForUser).mockResolvedValueOnce({
      limit: 20,
      effectiveSource: "system_default",
      maxFileSizeMb: 4,
      maxUploadSizeMb: 75,
      maxEditReferenceImages: 16,
      maxFileSizeBytes: 4 * 1024 * 1024,
      maxUploadSizeBytes: 75 * 1024 * 1024,
    });
    const oversizedInput = {
      ...input,
      generationInput: {
        operation: "edit" as const,
        prompt: "test image",
        model: "gpt-image-2",
        generationId: "generation-media-limit",
        images: [
          {
            source: "storage" as const,
            mimeType: "image/png" as const,
            storageKey: "user-1/image-inputs/input.png",
            storageBucket: "uploads",
            byteLength: 5 * 1024 * 1024,
          },
        ],
      },
    };

    await expect(
      executeImageEnqueueAsyncBinding(
        oversizedInput,
        principal,
        createContext(),
        dependencies
      )
    ).rejects.toMatchObject({ code: "validation_error" });
    expect(dependencies.acquireAdmission).not.toHaveBeenCalled();
    expect(repository.create).not.toHaveBeenCalled();
  });

  it("取得用户准入并持久化分组快照后才按快照优先级投递", async () => {
    const { calls, dependencies, repository } = createDependencies();
    const context = createContext();

    await expect(
      executeImageEnqueueAsyncBinding(input, principal, context, dependencies)
    ).resolves.toMatchObject({
      taskId: "task_123",
      status: "queued",
      generationId: "generation-1",
    });
    expect(calls).toEqual([
      "callback-validation",
      "admission",
      "group",
      "database",
      "queue",
      "mq-ack",
    ]);
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        apiKeyId: "key-1",
        legacyPlan: "retired",
        effectiveUserConcurrency: 20,
        groupIdSnapshot: "group-1",
        groupPrioritySnapshot: 7,
      })
    );
    expect(dependencies.enqueueTask).toHaveBeenCalledWith({
      taskId: "task_123",
      deliveryVersion: 0,
      priority: 8,
    });
    expect(context.assertOwnership).toHaveBeenCalledWith(
      "image async task",
      "user-1"
    );
  });

  it("MQ 投递失败时保留 due 且不释放已被任务采用的准入槽", async () => {
    const { dependencies, repository } = createDependencies();
    const failure = new Error("redis unavailable");
    vi.mocked(dependencies.enqueueTask).mockRejectedValue(failure);

    await expect(
      executeImageEnqueueAsyncBinding(
        input,
        principal,
        createContext(),
        dependencies
      )
    ).resolves.toMatchObject({ status: "queued" });
    expect(dependencies.reportEnqueueFailure).toHaveBeenCalledWith(
      failure,
      "task_123"
    );
    expect(repository.markMqDelivered).not.toHaveBeenCalled();
    expect(dependencies.releaseAdmission).not.toHaveBeenCalled();
  });

  it("用户并发已满时返回稳定 429 领域错误且不创建任务", async () => {
    const { dependencies, repository } = createDependencies();
    vi.mocked(dependencies.acquireAdmission).mockResolvedValue({
      status: "blocked",
      reason: "user",
    });

    await expect(
      executeImageEnqueueAsyncBinding(
        input,
        principal,
        createContext(),
        dependencies
      )
    ).rejects.toMatchObject({
      code: "concurrency_limit_exceeded",
      httpStatus: 429,
    });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it("同一 taskId 改写单项输入时返回幂等冲突且不碰 Redis", async () => {
    const existing = createTask({
      generationInput: { ...GENERATION_INPUT, prompt: "different image" },
      inputDigest: createImageAsyncTaskInputDigest({
        ...GENERATION_INPUT,
        prompt: "different image",
      }),
    });
    const { dependencies, repository } = createDependencies(existing);
    repository.findById.mockResolvedValue(existing);

    await expect(
      executeImageEnqueueAsyncBinding(
        input,
        principal,
        createContext(),
        dependencies
      )
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(dependencies.acquireAdmission).not.toHaveBeenCalled();
    expect(dependencies.enqueueTask).not.toHaveBeenCalled();
  });

  it("查询同时校验 userId 和 API Key 域", async () => {
    const repository = createRepository(createTask());
    repository.findById.mockResolvedValue(createTask());
    await expect(
      executeImageGetAsyncTaskBinding(
        { taskId: "task_123" },
        { ...principal, apiKeyId: "key-other" },
        createContext(),
        repository
      )
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("Worker 复核 Key、续期租约并直接执行一次单项管线", async () => {
    const running = createRunningTask();
    const completed = createTerminalTask("completed");
    const released = createTerminalTask("completed", {
      admissionLeaseReleasedAt: NOW,
      terminalReleaseDueAt: null,
    });
    const { calls, dependencies, repository } = createDependencies(running);
    repository.claimById.mockResolvedValue(running);
    repository.heartbeatClaim.mockResolvedValue(running);
    repository.complete.mockResolvedValue(completed);
    repository.markAdmissionReleased.mockImplementation(async () => {
      calls.push("release-ack");
      return released;
    });
    vi.mocked(dependencies.runGeneration).mockImplementation(async (run) => {
      await run.executionFence.assertActive();
      return { generationId: "generation-1" };
    });
    vi.mocked(dependencies.findGeneration)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        userId: "user-1",
        status: "completed",
        error: null,
        inputDigest: INPUT_DIGEST,
      });

    await expect(
      executeImageProcessAsyncTaskBinding(
        { taskId: "task_123" },
        { type: "system", reason: "media-task-worker" },
        createContext(),
        dependencies
      )
    ).resolves.toMatchObject({ status: "completed" });
    expect(dependencies.isApiKeyActive).toHaveBeenCalledWith({
      userId: "user-1",
      apiKeyId: "key-1",
    });
    expect(repository.heartbeatClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task_123",
        claimToken: "worker-1",
        admissionLeaseToken: "admission-1",
      })
    );
    expect(repository.heartbeatClaim).toHaveBeenCalledTimes(2);
    expect(dependencies.runGeneration).toHaveBeenCalledTimes(1);
    expect(dependencies.runGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        task: running,
        admissionLease: expect.objectContaining({ token: "admission-1" }),
        executionLease: expect.objectContaining({ token: "execution-1" }),
        executionFence: expect.objectContaining({
          signal: expect.any(AbortSignal),
          assertActive: expect.any(Function),
        }),
      })
    );
    expect(calls.slice(-4)).toEqual([
      "execution-release",
      "release",
      "release-ack",
      "callback",
    ]);
  });

  it("全站执行槽满时保留 admission 并按持久优先级延迟新投递", async () => {
    const running = createRunningTask();
    const queued = createTask({
      attemptCount: 1,
      mqDeliveryVersion: 1,
      mqDeliveryDueAt: NOW,
    });
    const acknowledged = createTask({
      attemptCount: 1,
      mqDeliveryVersion: 1,
      mqDeliveryDueAt: null,
    });
    const { dependencies, repository } = createDependencies(running);
    repository.claimById.mockResolvedValue(running);
    repository.release.mockResolvedValue(queued);
    repository.markMqDelivered.mockResolvedValue(acknowledged);
    vi.mocked(dependencies.acquireExecution).mockResolvedValue({
      status: "blocked",
      reason: "global",
    });

    await expect(
      executeImageProcessAsyncTaskBinding(
        { taskId: "task_123" },
        { type: "system", reason: "media-task-worker" },
        createContext(),
        dependencies
      )
    ).resolves.toMatchObject({ status: "queued" });
    expect(repository.release).toHaveBeenCalledWith({
      taskId: "task_123",
      claimToken: "worker-1",
      now: NOW,
    });
    expect(dependencies.enqueueTask).toHaveBeenCalledWith({
      taskId: "task_123",
      deliveryVersion: 1,
      priority: 8,
      runAt: new Date(NOW.getTime() + 1_000),
    });
    expect(repository.markMqDelivered).toHaveBeenCalledWith({
      taskId: "task_123",
      deliveryVersion: 1,
      mqDeliveryDueAt: NOW,
      now: NOW,
    });
    expect(dependencies.runGeneration).not.toHaveBeenCalled();
    expect(repository.fail).not.toHaveBeenCalled();
    expect(dependencies.releaseAdmission).not.toHaveBeenCalled();
    expect(dependencies.releaseExecution).not.toHaveBeenCalled();
  });

  it("Key 已停用但已有 completed generation 时仍先按真相投影终态", async () => {
    const running = createRunningTask();
    const completed = createTerminalTask("completed");
    const { dependencies, repository } = createDependencies(running);
    repository.claimById.mockResolvedValue(running);
    repository.complete.mockResolvedValue(completed);
    repository.markAdmissionReleased.mockResolvedValue(
      createTerminalTask("completed", {
        admissionLeaseReleasedAt: NOW,
        terminalReleaseDueAt: null,
      })
    );
    vi.mocked(dependencies.findGeneration).mockResolvedValue({
      userId: "user-1",
      status: "completed",
      error: null,
      inputDigest: INPUT_DIGEST,
    });
    vi.mocked(dependencies.isApiKeyActive).mockResolvedValue(false);

    await expect(
      executeImageProcessAsyncTaskBinding(
        { taskId: "task_123" },
        { type: "system", reason: "media-task-worker" },
        createContext(),
        dependencies
      )
    ).resolves.toMatchObject({ status: "completed" });
    expect(dependencies.runGeneration).not.toHaveBeenCalled();
    expect(dependencies.isApiKeyActive).not.toHaveBeenCalled();
    expect(repository.complete).toHaveBeenCalledTimes(1);
  });

  it("Key 已停用但已有 pending generation 时仍进入恢复且绝不二次外呼", async () => {
    const running = createRunningTask();
    const { dependencies, repository } = createDependencies(running);
    repository.claimById.mockResolvedValue(running);
    repository.release.mockResolvedValue(createTask());
    vi.mocked(dependencies.findGeneration).mockResolvedValue({
      userId: "user-1",
      status: "pending",
      error: null,
      inputDigest: INPUT_DIGEST,
    });
    vi.mocked(dependencies.isApiKeyActive).mockResolvedValue(false);

    await expect(
      executeImageProcessAsyncTaskBinding(
        { taskId: "task_123" },
        { type: "system", reason: "media-task-worker" },
        createContext(),
        dependencies
      )
    ).rejects.toMatchObject({ code: "not_ready" });
    expect(dependencies.runGeneration).not.toHaveBeenCalled();
    expect(dependencies.isApiKeyActive).not.toHaveBeenCalled();
    expect(repository.release).toHaveBeenCalledWith(
      expect.objectContaining({ claimToken: "worker-1" })
    );
  });

  it("heartbeat 丢失后即使 generation 已完成也不由旧 Worker 写终态", async () => {
    vi.useFakeTimers();
    try {
      const running = createRunningTask();
      const { dependencies, repository } = createDependencies(running);
      repository.claimById.mockResolvedValue(running);
      repository.heartbeatClaim
        .mockResolvedValueOnce(running)
        .mockResolvedValueOnce(null);
      repository.release.mockResolvedValue(null);
      vi.mocked(dependencies.findGeneration)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          userId: "user-1",
          status: "completed",
          error: null,
          inputDigest: INPUT_DIGEST,
        });
      vi.mocked(dependencies.runGeneration).mockImplementation(async (run) => {
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect(run.executionFence.signal.aborted).toBe(true);
        return { generationId: "generation-1" };
      });

      await expect(
        executeImageProcessAsyncTaskBinding(
          { taskId: "task_123" },
          { type: "system", reason: "media-task-worker" },
          createContext(),
          dependencies
        )
      ).rejects.toMatchObject({ code: "conflict" });
      expect(repository.complete).not.toHaveBeenCalled();
      expect(dependencies.releaseAdmission).not.toHaveBeenCalled();
      expect(dependencies.deliverCallback).not.toHaveBeenCalled();
      expect(repository.release).toHaveBeenCalledWith(
        expect.objectContaining({ claimToken: "worker-1" })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("API Key 入队后停用时任务失败并释放 admission", async () => {
    const running = createRunningTask();
    const failed = createTerminalTask("failed", {
      error: "用于创建该任务的 API Key 已停用",
    });
    const { dependencies, repository } = createDependencies(running);
    repository.claimById.mockResolvedValue(running);
    repository.fail.mockResolvedValue(failed);
    repository.markAdmissionReleased.mockResolvedValue(
      createTerminalTask("failed", {
        error: "用于创建该任务的 API Key 已停用",
        admissionLeaseReleasedAt: NOW,
        terminalReleaseDueAt: null,
      })
    );
    vi.mocked(dependencies.isApiKeyActive).mockResolvedValue(false);

    await expect(
      executeImageProcessAsyncTaskBinding(
        { taskId: "task_123" },
        { type: "system", reason: "media-task-worker" },
        createContext(),
        dependencies
      )
    ).resolves.toMatchObject({ status: "failed" });
    expect(dependencies.runGeneration).not.toHaveBeenCalled();
    expect(dependencies.releaseAdmission).toHaveBeenCalledTimes(1);
    expect(repository.markAdmissionReleased).toHaveBeenCalledTimes(1);
  });

  it("无 generation 的业务错误收敛 failed，基础设施错误则释放 claim 重试", async () => {
    const running = createRunningTask();
    const failed = createTerminalTask("failed", { error: "上游拒绝请求" });
    const business = createDependencies(running);
    business.repository.claimById.mockResolvedValue(running);
    business.repository.heartbeatClaim.mockResolvedValue(running);
    business.repository.fail.mockResolvedValue(failed);
    business.repository.markAdmissionReleased.mockResolvedValue(
      createTerminalTask("failed", {
        error: "上游拒绝请求",
        admissionLeaseReleasedAt: NOW,
        terminalReleaseDueAt: null,
      })
    );
    vi.mocked(business.dependencies.runGeneration).mockRejectedValue(
      new OperationError("upstream_error", "上游拒绝请求")
    );

    await expect(
      executeImageProcessAsyncTaskBinding(
        { taskId: "task_123" },
        { type: "system", reason: "media-task-worker" },
        createContext(),
        business.dependencies
      )
    ).resolves.toMatchObject({ status: "failed" });
    expect(business.repository.fail).toHaveBeenCalledWith(
      expect.objectContaining({ error: "上游拒绝请求" })
    );

    const infrastructure = createDependencies(running);
    infrastructure.repository.claimById.mockResolvedValue(running);
    infrastructure.repository.heartbeatClaim.mockResolvedValue(running);
    infrastructure.repository.release.mockResolvedValue(createTask());
    const failure = new Error("database unavailable");
    vi.mocked(infrastructure.dependencies.runGeneration).mockRejectedValue(
      failure
    );

    await expect(
      executeImageProcessAsyncTaskBinding(
        { taskId: "task_123" },
        { type: "system", reason: "media-task-worker" },
        createContext(),
        infrastructure.dependencies
      )
    ).rejects.toBe(failure);
    expect(infrastructure.repository.release).toHaveBeenCalledWith(
      expect.objectContaining({ claimToken: "worker-1" })
    );
  });

  it("generation 用户或摘要不一致时失败关闭", async () => {
    const running = createRunningTask();
    const { dependencies, repository } = createDependencies(running);
    repository.claimById.mockResolvedValue(running);
    repository.release.mockResolvedValue(createTask());
    vi.mocked(dependencies.findGeneration).mockResolvedValue({
      userId: "user-other",
      status: "completed",
      error: null,
      inputDigest: INPUT_DIGEST,
    });

    await expect(
      executeImageProcessAsyncTaskBinding(
        { taskId: "task_123" },
        { type: "system", reason: "media-task-worker" },
        createContext(),
        dependencies
      )
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(dependencies.runGeneration).not.toHaveBeenCalled();
  });
});
