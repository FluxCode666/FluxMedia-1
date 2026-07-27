import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeSettings = vi.hoisted(() => ({
  globalConcurrency: 500,
}));

const redisSlots = vi.hoisted(() => {
  let nextToken = 1;
  const leases = new Map<string, string>();
  return {
    acquireGate: undefined as Promise<void> | undefined,
    failAcquire: false,
    acquire: vi.fn(
      async (input: {
        userId: string;
        globalConcurrency: number;
        userConcurrency: number;
      }) => {
        if (redisSlots.failAcquire) throw new Error("redis unavailable");
        if (redisSlots.acquireGate) await redisSlots.acquireGate;
        if (leases.size >= input.globalConcurrency) {
          return { status: "blocked" as const, reason: "global" as const };
        }
        const userRunning = [...leases.values()].filter(
          (userId) => userId === input.userId
        ).length;
        if (userRunning >= input.userConcurrency) {
          return { status: "blocked" as const, reason: "user" as const };
        }
        const token = `lease-${nextToken++}`;
        leases.set(token, input.userId);
        return {
          status: "acquired" as const,
          lease: { token, userKey: `user:${input.userId}` },
        };
      }
    ),
    release: vi.fn(async (lease: { token: string }) => {
      leases.delete(lease.token);
    }),
    reset() {
      nextToken = 1;
      leases.clear();
      redisSlots.acquireGate = undefined;
      redisSlots.failAcquire = false;
      redisSlots.acquire.mockClear();
      redisSlots.release.mockClear();
    },
  };
});

vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingNumber: vi.fn(async () => runtimeSettings.globalConcurrency),
}));

vi.mock("./redis-image-generation-slots", () => ({
  acquireImageGenerationSlot: redisSlots.acquire,
  releaseImageGenerationSlot: redisSlots.release,
}));

import { withImageGenerationQueue } from "./queue";

// 队列模块持有进程级等待任务与调度定时器。为避免用例之间互相污染本地回调状态，
// 需要新鲜实例的用例通过 vi.resetModules + 动态 import 取得隔离副本。
async function importFreshQueue() {
  vi.resetModules();
  return await import("./queue");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

async function flushTasks() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("withImageGenerationQueue", () => {
  beforeEach(() => {
    runtimeSettings.globalConcurrency = 500;
    redisSlots.reset();
  });

  it("Redis 不可用时拒绝请求且不回退进程内槽位", async () => {
    const { withImageGenerationQueue: queue } = await importFreshQueue();
    const run = vi.fn(async () => "should-not-run");
    redisSlots.failAcquire = true;

    await expect(
      queue({ userId: "user-a", priority: "normal", userConcurrency: 1 }, run)
    ).rejects.toThrow("redis unavailable");
    expect(run).not.toHaveBeenCalled();
  });

  it("Redis 获槽响应晚于排队超时时释放迟到租约且不执行任务", async () => {
    const { withImageGenerationQueue: queue } = await importFreshQueue();
    const acquisition = deferred<void>();
    const run = vi.fn(async () => "should-not-run");
    redisSlots.acquireGate = acquisition.promise;

    const queued = queue(
      {
        userId: "user-a",
        priority: "normal",
        userConcurrency: 1,
        timeoutMs: 5,
      },
      run
    );
    await expect(queued).rejects.toThrow(/queue is busy/i);

    acquisition.resolve();
    await flushTasks();
    expect(run).not.toHaveBeenCalled();
    expect(redisSlots.release).toHaveBeenCalledTimes(1);
  });

  it("limits running tasks by the configured global concurrency", async () => {
    runtimeSettings.globalConcurrency = 1;
    const first = deferred<string>();
    const started: string[] = [];

    const firstRun = withImageGenerationQueue(
      {
        userId: "user-a",
        priority: "normal",
        userConcurrency: 10,
      },
      async () => {
        started.push("first");
        return await first.promise;
      }
    );
    const secondRun = withImageGenerationQueue(
      {
        userId: "user-b",
        priority: "normal",
        userConcurrency: 10,
      },
      async () => {
        started.push("second");
        return "second";
      }
    );

    await flushTasks();
    expect(started).toEqual(["first"]);

    first.resolve("first");
    await firstRun;
    await flushTasks();

    expect(started).toEqual(["first", "second"]);
    await expect(secondRun).resolves.toBe("second");
  });

  it("limits per-user concurrency independent of global", async () => {
    const { withImageGenerationQueue: queue } = await importFreshQueue();
    const first = deferred<string>();
    const started: string[] = [];

    // 同一用户的两个任务，userConcurrency=1：第二个必须等到第一个完成。
    const firstRun = queue(
      { userId: "user-a", priority: "normal", userConcurrency: 1 },
      async () => {
        started.push("a1");
        return await first.promise;
      }
    );
    const secondRun = queue(
      { userId: "user-a", priority: "normal", userConcurrency: 1 },
      async () => {
        started.push("a2");
        return "a2";
      }
    );
    // 另一用户不受前者占用影响，应当立即起跑（全局并发充足）。
    const otherRun = queue(
      { userId: "user-b", priority: "normal", userConcurrency: 1 },
      async () => {
        started.push("b1");
        return "b1";
      }
    );

    await flushTasks();
    expect(started).toEqual(["a1", "b1"]);
    await expect(otherRun).resolves.toBe("b1");

    first.resolve("a1");
    await firstRun;
    await flushTasks();

    expect(started).toEqual(["a1", "b1", "a2"]);
    await expect(secondRun).resolves.toBe("a2");
  });

  it("runs higher priority before normal", async () => {
    runtimeSettings.globalConcurrency = 1;
    const { withImageGenerationQueue: queue } = await importFreshQueue();
    const blocker = deferred<string>();
    const started: string[] = [];

    // 先占满唯一的全局槽位，使后续任务全部排队等待调度。
    const blockerRun = queue(
      { userId: "blocker", priority: "normal", userConcurrency: 10 },
      async () => {
        started.push("blocker");
        return await blocker.promise;
      }
    );

    await flushTasks();
    expect(started).toEqual(["blocker"]);

    // 先入队 normal，再入队 highest；释放槽位后应优先调度 highest（优先级加权）。
    const normalRun = queue(
      { userId: "normal-user", priority: "normal", userConcurrency: 10 },
      async () => {
        started.push("normal");
        return "normal";
      }
    );
    const highestRun = queue(
      { userId: "highest-user", priority: "highest", userConcurrency: 10 },
      async () => {
        started.push("highest");
        return "highest";
      }
    );

    blocker.resolve("blocker");
    await blockerRun;
    await flushTasks();

    expect(started).toEqual(["blocker", "highest", "normal"]);
    await expect(highestRun).resolves.toBe("highest");
    await expect(normalRun).resolves.toBe("normal");
  });

  it("frees user slot after completion", async () => {
    const { withImageGenerationQueue: queue } = await importFreshQueue();
    const started: string[] = [];

    // 串行跑两个同用户任务（userConcurrency=1），第二个能起跑即证明第一个完成后
    // runningByUser 计数被正确清理、槽位已释放。
    await queue(
      { userId: "user-a", priority: "normal", userConcurrency: 1 },
      async () => {
        started.push("a1");
        return "a1";
      }
    );
    await queue(
      { userId: "user-a", priority: "normal", userConcurrency: 1 },
      async () => {
        started.push("a2");
        return "a2";
      }
    );

    expect(started).toEqual(["a1", "a2"]);
  });

  it("任务失败时仍释放 Redis 槽位", async () => {
    const { withImageGenerationQueue: queue } = await importFreshQueue();

    await expect(
      queue(
        { userId: "user-a", priority: "normal", userConcurrency: 1 },
        async () => {
          throw new Error("upstream failed");
        }
      )
    ).rejects.toThrow("upstream failed");

    expect(redisSlots.release).toHaveBeenCalledTimes(1);
    await expect(
      queue(
        { userId: "user-a", priority: "normal", userConcurrency: 1 },
        async () => "second"
      )
    ).resolves.toBe("second");
  });

  it("rejects queued task after timeout with concurrency-limit message when user at limit", async () => {
    const { withImageGenerationQueue: queue } = await importFreshQueue();
    const blocker = deferred<string>();

    // 占满该用户的唯一并发槽位，使下一个同用户任务排队并最终超时。
    const blockerRun = queue(
      { userId: "user-a", priority: "normal", userConcurrency: 1 },
      async () => await blocker.promise
    );

    await flushTasks();

    const queuedRun = queue(
      {
        userId: "user-a",
        priority: "normal",
        userConcurrency: 1,
        timeoutMs: 5,
      },
      async () => "never"
    );

    await expect(queuedRun).rejects.toThrow(/concurrency limit reached/i);

    blocker.resolve("blocker");
    await blockerRun;
  });

  it("rejects with busy message when global slots exhausted", async () => {
    runtimeSettings.globalConcurrency = 1;
    const { withImageGenerationQueue: queue } = await importFreshQueue();
    const blocker = deferred<string>();

    // 用 user-a 占满唯一的全局槽位；user-b 仍在自身并发额度内，却因全局繁忙超时。
    const blockerRun = queue(
      { userId: "user-a", priority: "normal", userConcurrency: 10 },
      async () => await blocker.promise
    );

    await flushTasks();

    const queuedRun = queue(
      {
        userId: "user-b",
        priority: "normal",
        userConcurrency: 10,
        timeoutMs: 5,
      },
      async () => "never"
    );

    await expect(queuedRun).rejects.toThrow(/queue is busy/i);

    blocker.resolve("blocker");
    await blockerRun;
  });
});
