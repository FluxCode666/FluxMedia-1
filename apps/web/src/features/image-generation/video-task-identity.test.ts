/**
 * 视频任务幂等标识单元测试。
 *
 * 职责：证明同一 Principal 重放稳定命中，且站内、不同 API Key 之间互不
 * 命中，防止跨凭据重用 clientRequestId 造成越权或误去重。
 */

import { describe, expect, it } from "vitest";

import {
  createVideoPrincipalScope,
  createVideoRequestFingerprint,
  createVideoTaskId,
} from "./video-task-identity";

describe("createVideoTaskId", () => {
  it("同一 Principal 和请求键稳定命中", () => {
    const input = {
      principalScope: "user:user-1",
      clientRequestId: "request-1",
    };
    expect(createVideoTaskId(input)).toBe(createVideoTaskId(input));
  });

  it("站内、外部 API Key 与每把 MCP Key 的所有者作用域互相隔离", () => {
    const sessionTask = createVideoTaskId({
      principalScope: "user:user-1",
      clientRequestId: "same-request",
    });
    const keyATask = createVideoTaskId({
      principalScope: "external:user-1:key-a",
      clientRequestId: "same-request",
    });
    const keyBTask = createVideoTaskId({
      principalScope: "mcp:user-1:key-b",
      clientRequestId: "same-request",
    });
    const keyCTask = createVideoTaskId({
      principalScope: "mcp:user-1:key-c",
      clientRequestId: "same-request",
    });

    expect(new Set([sessionTask, keyATask, keyBTask, keyCTask]).size).toBe(4);
    expect(sessionTask).toMatch(/^video_[a-f0-9]{40}$/);
  });

  it("从 Principal 准确派生凭据类型和 key 作用域", () => {
    expect(
      createVideoPrincipalScope({
        type: "apiKey",
        credentialKind: "mcp",
        userId: "user-1",
        apiKeyId: "mcp-key-1",
        plan: "pro",
      })
    ).toBe("mcp:user-1:mcp-key-1");
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
