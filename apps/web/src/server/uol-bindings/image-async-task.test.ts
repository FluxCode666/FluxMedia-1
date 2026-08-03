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
});
