/**
 * 视频任务幂等标识单元测试。
 *
 * 职责：证明同一 Principal 重放稳定命中，且站内、不同 API Key 之间互不
 * 命中，防止跨凭据重用 clientRequestId 造成越权或误去重。
 */

import { describe, expect, it } from "vitest";

import {
  createVideoRequestFingerprint,
  createVideoTaskId,
} from "./video-task-identity";

describe("createVideoTaskId", () => {
  it("同一 Principal 和请求键稳定命中", () => {
    const input = { userId: "user-1", clientRequestId: "request-1" };
    expect(createVideoTaskId(input)).toBe(createVideoTaskId(input));
  });

  it("站内与不同 API Key 的所有者作用域互相隔离", () => {
    const sessionTask = createVideoTaskId({
      userId: "user-1",
      clientRequestId: "same-request",
    });
    const keyATask = createVideoTaskId({
      userId: "user-1",
      apiKeyId: "key-a",
      clientRequestId: "same-request",
    });
    const keyBTask = createVideoTaskId({
      userId: "user-1",
      apiKeyId: "key-b",
      clientRequestId: "same-request",
    });

    expect(new Set([sessionTask, keyATask, keyBTask]).size).toBe(3);
    expect(sessionTask).toMatch(/^video_[a-f0-9]{40}$/);
  });

  it("同键重放可检测内容冲突", () => {
    const first = createVideoRequestFingerprint({
      clientRequestId: "request-1",
      prompt: "first",
      model: "model-1",
    });
    const replay = createVideoRequestFingerprint({
      clientRequestId: "request-1",
      prompt: "first",
      model: "model-1",
    });
    const conflict = createVideoRequestFingerprint({
      clientRequestId: "request-1",
      prompt: "changed",
      model: "model-1",
    });

    expect(replay).toBe(first);
    expect(conflict).not.toBe(first);
  });
});
