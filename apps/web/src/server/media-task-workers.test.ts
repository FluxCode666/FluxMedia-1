/**
 * Redis 媒体任务 Worker 消息处理单测。
 *
 * 使用方：Vitest；验证 fail-closed 解析、PostgreSQL 委托和版本化延迟重投，不连接
 * Redis 或数据库。
 */

import { describe, expect, it, vi } from "vitest";

import { processVideoTaskJob } from "./media-task-workers";

describe("media task workers", () => {
  it("处理视频任务后按 PostgreSQL 返回时间重投", async () => {
    const schedule = {
      taskId: "video-1",
      stateVersion: 4,
      runAt: new Date("2026-08-04T00:00:15.000Z"),
    };
    const processTask = vi.fn().mockResolvedValue(schedule);
    const enqueueTask = vi.fn().mockResolvedValue(undefined);

    await processVideoTaskJob(
      {
        kind: "video-generation",
        taskId: "video-1",
        stateVersion: 3,
      },
      { processTask, enqueueTask }
    );

    expect(processTask).toHaveBeenCalledWith("video-1");
    expect(enqueueTask).toHaveBeenCalledWith(schedule);
  });

  it("终态任务不再投递", async () => {
    const processTask = vi.fn().mockResolvedValue(null);
    const enqueueTask = vi.fn().mockResolvedValue(undefined);

    await processVideoTaskJob(
      {
        kind: "video-generation",
        taskId: "video-1",
        stateVersion: 8,
      },
      { processTask, enqueueTask }
    );

    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it("非法消息在任何业务调用前失败关闭", async () => {
    const processTask = vi.fn();
    const enqueueTask = vi.fn();

    await expect(
      processVideoTaskJob(
        { kind: "video-generation", taskId: "video-1", prompt: "leak" },
        { processTask, enqueueTask }
      )
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(processTask).not.toHaveBeenCalled();
    expect(enqueueTask).not.toHaveBeenCalled();
  });
});
