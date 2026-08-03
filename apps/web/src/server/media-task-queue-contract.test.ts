/**
 * Redis 媒体任务队列契约单测。
 *
 * 使用方：Vitest；锁定最小消息边界、严格校验和确定性去重身份，不连接 Redis。
 */

import { describe, expect, it } from "vitest";

import {
  createImageTaskJobId,
  createVideoTaskJobId,
  imageTaskJobDataSchema,
  videoTaskJobDataSchema,
} from "./media-task-queue-contract";

describe("media task queue contract", () => {
  it("只接受图片持久任务 ID，不允许把领域负载带入 Redis", () => {
    expect(
      imageTaskJobDataSchema.parse({
        kind: "image-generation",
        taskId: "task_image_1",
      })
    ).toEqual({ kind: "image-generation", taskId: "task_image_1" });
    expect(() =>
      imageTaskJobDataSchema.parse({
        kind: "image-generation",
        taskId: "task_image_1",
        prompt: "不得进入消息",
      })
    ).toThrow();
  });

  it("视频状态版本形成稳定去重身份", () => {
    expect(
      videoTaskJobDataSchema.parse({
        kind: "video-generation",
        taskId: "video_1",
        stateVersion: 3,
      })
    ).toEqual({
      kind: "video-generation",
      taskId: "video_1",
      stateVersion: 3,
    });
    expect(createVideoTaskJobId("video_1", 3)).toBe("video_1-3");
    expect(createImageTaskJobId("task_image_1")).toBe("task_image_1");
  });

  it("拒绝非法任务 ID 与负状态版本", () => {
    expect(() => createImageTaskJobId(" ")).toThrow();
    expect(() => createVideoTaskJobId("video_1", -1)).toThrow();
  });
});
