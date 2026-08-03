/**
 * Node 进程关闭顺序测试。
 *
 * 职责：验证调度器、MQ Worker、Queue 与脚本池按优先级分批关闭，同优先级失败不会
 * 阻塞后续批次，避免 Redis Queue 先于消费者释放。
 */
import { describe, expect, it, vi } from "vitest";

import { runShutdownHandlersInPriorityOrder } from "./process-lifecycle";

describe("process lifecycle shutdown order", () => {
  it("等待低数值优先级完成后才启动下一批", async () => {
    const calls: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const running = runShutdownHandlersInPriorityOrder([
      {
        priority: 20,
        handler: async () => {
          calls.push("worker:start");
          await first;
          calls.push("worker:end");
        },
      },
      {
        priority: 30,
        handler: () => {
          calls.push("queue");
        },
      },
    ]);

    await vi.waitFor(() => expect(calls).toEqual(["worker:start"]));
    releaseFirst?.();
    await running;
    expect(calls).toEqual(["worker:start", "worker:end", "queue"]);
  });

  it("同优先级并行结算且单个失败不阻止下一批", async () => {
    const calls: string[] = [];
    await runShutdownHandlersInPriorityOrder([
      {
        priority: 10,
        handler: () => {
          calls.push("scheduler");
          throw new Error("scheduler stop failed");
        },
      },
      {
        priority: 10,
        handler: () => {
          calls.push("admission");
        },
      },
      {
        priority: 20,
        handler: () => {
          calls.push("worker");
        },
      },
    ]);

    expect(calls.slice(0, 2).sort()).toEqual(["admission", "scheduler"]);
    expect(calls[2]).toBe("worker");
  });
});
