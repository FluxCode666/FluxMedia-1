/**
 * 图片异步任务 UOL binding 测试。
 *
 * 职责：验证身份只来自外部 API Principal、数据库提交先于 MQ、投递失败优雅降级，
 * 以及 userId/API Key 双重归属和 taskId 幂等冲突。
 */
import type { OperationContext, Principal } from "@repo/shared/uol";
import { describe, expect, it, vi } from "vitest";

import type {
  ImageAsyncTaskRecord,
  ImageAsyncTaskRepository,
} from "@/features/image-generation/image-async-task-repository";
import {
  executeImageEnqueueAsyncBinding,
  executeImageGetAsyncTaskBinding,
  executeImageProcessAsyncTaskBinding,
  type ImageAsyncTaskBindingDependencies,
} from "./image-async-task";

const NOW = new Date("2026-08-04T00:00:00.000Z");
const principal = {
  type: "apiKey",
  credentialKind: "external",
  userId: "user-1",
  apiKeyId: "key-1",
  plan: "pro",
} satisfies Principal;

/** 创建一个最小合法图片异步任务记录。 */
function createTask(
  overrides: Partial<ImageAsyncTaskRecord> = {}
): ImageAsyncTaskRecord {
  return {
    id: "task_123",
    userId: "user-1",
    apiKeyId: "key-1",
    plan: "pro",
    operation: "generate",
    generationInputs: [
      {
        operation: "generate",
        prompt: "test image",
        model: "gpt-image-2",
        generationId: "generation-1",
      },
    ],
    generationIds: ["generation-1"],
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

/** 创建只暴露本组测试所需方法的仓储桩。 */
function createRepository(task: ImageAsyncTaskRecord) {
  return {
    create: vi.fn().mockResolvedValue({ task, created: true }),
    findById: vi.fn().mockResolvedValue(task),
    claimById: vi.fn(),
    release: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn(),
  } satisfies ImageAsyncTaskRepository;
}

/** 创建记录归属断言的 UOL 上下文。 */
function createContext() {
  return {
    requestId: "request-1",
    assertOwnership: vi.fn(),
  } satisfies OperationContext;
}

/** 创建一组可观察创建、校验和 MQ 顺序的 binding 依赖。 */
function createDependencies(task = createTask()) {
  const calls: string[] = [];
  const repository = createRepository(task);
  repository.create.mockImplementation(async () => {
    calls.push("database");
    return { task, created: true };
  });
  const dependencies: ImageAsyncTaskBindingDependencies = {
    repository,
    validateCallback: vi.fn(async () => {
      calls.push("callback");
      return "https://callback.example.com/images";
    }),
    getQueuePriority: vi.fn(async () => 50),
    enqueueTask: vi.fn(async () => {
      calls.push("queue");
      return undefined;
    }),
    reportEnqueueFailure: vi.fn(),
    runGeneration: vi.fn(async () => undefined),
    getGenerationConcurrency: vi.fn(async () => 2),
    createClaimToken: vi.fn(() => "worker-1"),
    now: vi.fn(() => NOW),
    reportGenerationFailure: vi.fn(),
  };
  return { calls, dependencies, repository };
}

const input = {
  taskId: "task_123",
  generationInputs: [
    {
      operation: "generate" as const,
      prompt: "test image",
      model: "gpt-image-2",
      generationId: "generation-1",
    },
  ],
  responseFormat: "url" as const,
  callbackUrl: "https://callback.example.com/images",
};

describe("image async task UOL bindings", () => {
  it("先校验回调并提交数据库，再按套餐优先级投递最小任务", async () => {
    const { calls, dependencies, repository } = createDependencies();
    const context = createContext();

    await expect(
      executeImageEnqueueAsyncBinding(input, principal, context, dependencies)
    ).resolves.toMatchObject({
      taskId: "task_123",
      status: "queued",
      generationIds: ["generation-1"],
    });
    expect(calls).toEqual(["callback", "database", "queue"]);
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        apiKeyId: "key-1",
        plan: "pro",
      })
    );
    expect(dependencies.enqueueTask).toHaveBeenCalledWith({
      taskId: "task_123",
      priority: 50,
    });
    expect(context.assertOwnership).toHaveBeenCalledWith(
      "image async task",
      "user-1"
    );
  });

  it("Redis 投递失败时保留 queued 数据库任务并报告故障", async () => {
    const { dependencies } = createDependencies();
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
  });

  it("拒绝非外部 API Principal 且不创建任务", async () => {
    const { dependencies, repository } = createDependencies();
    await expect(
      executeImageEnqueueAsyncBinding(
        input,
        { type: "user", userId: "user-1", role: "user" },
        createContext(),
        dependencies
      )
    ).rejects.toMatchObject({ code: "unauthenticated" });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it("同一 taskId 改写持久输入时返回幂等冲突且不投递", async () => {
    const { dependencies } = createDependencies(
      createTask({
        generationInputs: [
          {
            operation: "generate",
            prompt: "different image",
            model: "gpt-image-2",
            generationId: "generation-1",
          },
        ],
      })
    );
    await expect(
      executeImageEnqueueAsyncBinding(
        input,
        principal,
        createContext(),
        dependencies
      )
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(dependencies.enqueueTask).not.toHaveBeenCalled();
  });

  it("查询同时校验 userId 和 API Key 域", async () => {
    const repository = createRepository(createTask());
    await expect(
      executeImageGetAsyncTaskBinding(
        { taskId: "task_123" },
        { ...principal, apiKeyId: "key-other" },
        createContext(),
        repository
      )
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("Worker 从数据库恢复 API Key Principal 并在全部 generation 完成后 CAS 完成", async () => {
    const task = createTask({
      generationInputs: [
        {
          operation: "generate",
          prompt: "first",
          model: "gpt-image-2",
          generationId: "generation-1",
        },
        {
          operation: "generate",
          prompt: "second",
          model: "gpt-image-2",
          generationId: "generation-2",
        },
      ],
      generationIds: ["generation-1", "generation-2"],
      status: "running",
      attemptCount: 1,
      claimToken: "worker-1",
      claimExpiresAt: new Date(NOW.getTime() + 22 * 60_000),
      startedAt: NOW,
    });
    const { dependencies, repository } = createDependencies(task);
    repository.claimById.mockResolvedValue(task);
    repository.complete.mockResolvedValue(
      createTask({ ...task, status: "completed", completedAt: NOW })
    );

    await expect(
      executeImageProcessAsyncTaskBinding(
        { taskId: "task_123" },
        { type: "system", reason: "media-task-worker" },
        createContext(),
        dependencies
      )
    ).resolves.toMatchObject({ status: "completed" });
    expect(dependencies.runGeneration).toHaveBeenCalledTimes(2);
    expect(dependencies.runGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ generationId: "generation-1" }),
      expect.objectContaining({
        type: "apiKey",
        credentialKind: "external",
        userId: "user-1",
        apiKeyId: "key-1",
        plan: "pro",
      }),
      "image-async-task:task_123:generation-1"
    );
    expect(repository.complete).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task_123", claimToken: "worker-1" })
    );
  });

  it("generation 失败时只收敛 task 失败，不让 BullMQ 重复执行已失败 generation", async () => {
    const task = createTask({
      status: "running",
      claimToken: "worker-1",
      claimExpiresAt: new Date(NOW.getTime() + 22 * 60_000),
      startedAt: NOW,
    });
    const { dependencies, repository } = createDependencies(task);
    repository.claimById.mockResolvedValue(task);
    repository.fail.mockResolvedValue(
      createTask({ ...task, status: "failed", error: "上游失败" })
    );
    vi.mocked(dependencies.runGeneration).mockRejectedValueOnce(
      new Error("unexpected internal error")
    );

    await expect(
      executeImageProcessAsyncTaskBinding(
        { taskId: "task_123" },
        { type: "system", reason: "media-task-worker" },
        createContext(),
        dependencies
      )
    ).resolves.toMatchObject({ status: "failed" });
    expect(repository.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task_123",
        claimToken: "worker-1",
        error: "Image generation failed. Please retry later.",
      })
    );
  });

  it("基础设施异常时释放 claim 并交给 BullMQ 重试", async () => {
    const task = createTask({
      status: "running",
      claimToken: "worker-1",
      claimExpiresAt: new Date(NOW.getTime() + 22 * 60_000),
      startedAt: NOW,
    });
    const { dependencies, repository } = createDependencies(task);
    repository.claimById.mockResolvedValue(task);
    repository.release.mockResolvedValue(
      createTask({ ...task, status: "queued", claimToken: null })
    );
    const failure = new Error("settings unavailable");
    vi.mocked(dependencies.getGenerationConcurrency).mockRejectedValue(failure);

    await expect(
      executeImageProcessAsyncTaskBinding(
        { taskId: "task_123" },
        { type: "system", reason: "media-task-worker" },
        createContext(),
        dependencies
      )
    ).rejects.toBe(failure);
    expect(repository.release).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task_123", claimToken: "worker-1" })
    );
  });
});
