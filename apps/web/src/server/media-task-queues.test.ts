/**
 * Redis 媒体任务队列生产者单测。
 *
 * 使用方：Vitest；通过注入端口验证消息最小化、确定性 jobId、延迟与优先级，不连接
 * Redis。
 */

import type { JobsOptions } from "bullmq";
import { describe, expect, it, vi } from "vitest";

import {
  type ImageTaskJobData,
  MEDIA_TASK_JOB_NAME,
  type VideoTaskJobData,
} from "./media-task-queue-contract";
import {
  enqueueImageTask,
  enqueueVideoTask,
  type MediaTaskQueuePort,
} from "./media-task-queues";

/** 构造只记录 add 参数的队列端口。 */
function createQueuePort<TData>() {
  const add = vi.fn(
    async (
      _name: typeof MEDIA_TASK_JOB_NAME,
      _data: TData,
      _options: JobsOptions
    ) => ({ queued: true })
  );
  return { port: { add } satisfies MediaTaskQueuePort<TData>, add };
}

describe("media task queue producer", () => {
  it("图片任务只投递 ID，并规范优先级", async () => {
    const { port, add } = createQueuePort<ImageTaskJobData>();
    await enqueueImageTask({ taskId: "task-1", priority: 0 }, port);

    expect(add).toHaveBeenCalledWith(
      MEDIA_TASK_JOB_NAME,
      { kind: "image-generation", taskId: "task-1" },
      expect.objectContaining({
        attempts: 5,
        delay: 0,
        priority: 1,
        jobId: expect.stringMatching(/^image-[a-f0-9]{64}$/),
      })
    );
  });

  it("图片补偿按数据库 attempt 版本生成新 jobId，但消息仍只含 taskId", async () => {
    const first = createQueuePort<ImageTaskJobData>();
    const retry = createQueuePort<ImageTaskJobData>();
    await enqueueImageTask(
      { taskId: "task-1", deliveryVersion: 0 },
      first.port
    );
    await enqueueImageTask(
      { taskId: "task-1", deliveryVersion: 5 },
      retry.port
    );

    expect(first.add.mock.calls[0]?.[1]).toEqual({
      kind: "image-generation",
      taskId: "task-1",
    });
    expect(retry.add.mock.calls[0]?.[1]).toEqual({
      kind: "image-generation",
      taskId: "task-1",
    });
    expect(first.add.mock.calls[0]?.[2].jobId).not.toBe(
      retry.add.mock.calls[0]?.[2].jobId
    );
  });

  it("视频任务以状态版本去重并按目标时间延迟", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T00:00:00.000Z"));
    const { port, add } = createQueuePort<VideoTaskJobData>();
    try {
      await enqueueVideoTask(
        {
          taskId: "video-1",
          stateVersion: 7,
          runAt: new Date("2026-08-04T00:00:15.000Z"),
        },
        port
      );
    } finally {
      vi.useRealTimers();
    }

    expect(add).toHaveBeenCalledWith(
      MEDIA_TASK_JOB_NAME,
      {
        kind: "video-generation",
        taskId: "video-1",
        stateVersion: 7,
      },
      expect.objectContaining({
        delay: 15_000,
        jobId: expect.stringMatching(/^video-[a-f0-9]{64}$/),
      })
    );
  });
});
