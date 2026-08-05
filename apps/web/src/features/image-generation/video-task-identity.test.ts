/**
 * 视频任务幂等标识单元测试。
 *
 * 职责：证明同一 Principal 重放稳定命中，且站内、不同 API Key 之间互不
 * 命中，防止跨凭据重用 clientRequestId 造成越权或误去重。
 */

import {
  resolveCanonicalVideoGenerateInput,
  videoGenerateInputSchema,
} from "@repo/shared/uol/operations/video-generation";
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
      })
    ).toBe("mcp:user-1:mcp-key-1");
  });

  it("同键重放可检测内容冲突", () => {
    const first = createVideoRequestFingerprint({
      clientRequestId: "request-1",
      prompt: "first",
      model: "seedance2",
      duration: 15,
      aspectRatio: "9:16",
      resolution: "480p",
      generateAudio: false,
    });
    const replay = createVideoRequestFingerprint({
      clientRequestId: "request-1",
      prompt: "first",
      model: "seedance2",
      duration: 15,
      aspectRatio: "9:16",
      resolution: "480p",
      generateAudio: false,
    });
    const conflict = createVideoRequestFingerprint({
      clientRequestId: "request-1",
      prompt: "changed",
      model: "seedance2",
      duration: 15,
      aspectRatio: "9:16",
      resolution: "480p",
      generateAudio: false,
    });

    expect(replay).toBe(first);
    expect(conflict).not.toBe(first);
  });

  it("省略声音与显式模型默认值生成同一规范指纹", () => {
    const base = {
      clientRequestId: "request-1",
      prompt: "first",
      model: "seedance2",
      duration: 15,
      aspectRatio: "9:16",
      resolution: "480p",
    };
    const omitted = resolveCanonicalVideoGenerateInput(
      videoGenerateInputSchema.parse(base),
      undefined
    );
    const disabled = resolveCanonicalVideoGenerateInput(
      videoGenerateInputSchema.parse({ ...base, generateAudio: false }),
      undefined
    );
    if (!omitted.ok || !disabled.ok) {
      throw new Error("Seedance 默认声音规范化失败");
    }

    expect(createVideoRequestFingerprint(omitted.input)).toBe(
      createVideoRequestFingerprint(disabled.input)
    );
  });

  it("参数、具名位置和参考图顺序都是规范请求语义", () => {
    const first = {
      source: "storage" as const,
      mimeType: "image/png" as const,
      storageKey: "users/user-1/a.png",
      byteLength: 10,
    };
    const second = {
      source: "storage" as const,
      mimeType: "image/png" as const,
      storageKey: "users/user-1/b.png",
      byteLength: 20,
    };
    const base = {
      clientRequestId: "request-1",
      prompt: "first",
      model: "seedance2" as const,
      duration: 15,
      aspectRatio: "9:16" as const,
      resolution: "480p" as const,
      generateAudio: false,
    };

    const references = createVideoRequestFingerprint({
      ...base,
      referenceImages: [first, second],
    });
    expect(
      createVideoRequestFingerprint({
        ...base,
        referenceImages: [second, first],
      })
    ).not.toBe(references);
    expect(
      createVideoRequestFingerprint({ ...base, firstFrame: first })
    ).not.toBe(createVideoRequestFingerprint({ ...base, firstFrame: second }));
    expect(createVideoRequestFingerprint({ ...base, duration: 14 })).not.toBe(
      references
    );
  });
});
