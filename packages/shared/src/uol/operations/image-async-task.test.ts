/**
 * 图片异步任务 UOL 契约测试。
 *
 * 职责：固定 PostgreSQL 持久输入、最小公开状态和系统 Worker 权限边界，防止完整
 * 媒体、凭据或混合批次绕过统一图片 operation。
 */
import { describe, expect, it } from "vitest";

import { assertAccess } from "../access";
import type { Principal } from "../principal";
import { getOperation } from "../registry";
import {
  imageEnqueueAsync,
  imageEnqueueAsyncInputSchema,
  imageProcessAsyncTask,
} from "./image-generation";

const externalPrincipal = {
  type: "apiKey",
  credentialKind: "external",
  userId: "user-1",
  apiKeyId: "key-1",
} satisfies Principal;

/** 创建一个最小合法图片异步任务输入，测试按需覆盖字段。 */
function createInput() {
  return {
    taskId: "task_123",
    generationInput: {
      operation: "generate" as const,
      prompt: "first image",
      model: "gpt-image-2",
      generationId: "generation-1",
    },
    responseFormat: "url" as const,
    callbackUrl: "https://callback.example.com/images",
  };
}

describe("image async task operation contracts", () => {
  it("注册三个异步任务 operation 并声明最小副作用", () => {
    expect(getOperation("image.enqueueAsync")).toBe(imageEnqueueAsync);
    expect(getOperation("image.getAsyncTask")?.readOnly).toBe(true);
    expect(getOperation("image.processAsyncTask")).toBe(imageProcessAsyncTask);
    expect(imageEnqueueAsync.sideEffects).toEqual(["queue", "storage"]);
    expect(imageProcessAsyncTask.sideEffects).toEqual([
      "billing",
      "storage",
      "external-call",
      "queue",
    ]);
  });

  it("接受单个 JSON-safe generation input", () => {
    expect(imageEnqueueAsyncInputSchema.safeParse(createInput()).success).toBe(
      true
    );
  });

  it("拒绝旧批次数组和单项 count 字段", () => {
    const legacyBatch = {
      ...createInput(),
      generationInputs: [
        createInput().generationInput,
        createInput().generationInput,
      ],
    };
    expect(imageEnqueueAsyncInputSchema.safeParse(legacyBatch).success).toBe(
      false
    );
    expect(
      imageEnqueueAsyncInputSchema.safeParse({
        ...createInput(),
        generationInput: { ...createInput().generationInput, count: 1 },
      }).success
    ).toBe(false);
  });

  it("拒绝把异步编辑 data 或 remote 媒体持久化进任务输入", () => {
    const dataInput = {
      ...createInput(),
      generationInput: {
        operation: "edit" as const,
        prompt: "edit image",
        model: "gpt-image-2",
        generationId: "generation-3",
        images: [
          {
            source: "data" as const,
            mimeType: "image/png" as const,
            base64: "dGVzdA==",
            byteLength: 4,
          },
        ],
      },
    };
    expect(imageEnqueueAsyncInputSchema.safeParse(dataInput).success).toBe(
      false
    );
  });

  it("只允许 system Principal 调用 Worker operation", () => {
    expect(() =>
      assertAccess(imageProcessAsyncTask.access, externalPrincipal)
    ).toThrowError(/System-only operation/);
    expect(() =>
      assertAccess(imageProcessAsyncTask.access, {
        type: "system",
        reason: "media-task-worker",
      })
    ).not.toThrow();
  });

  it("不接收客户端身份或套餐字段", () => {
    expect(
      imageEnqueueAsyncInputSchema.safeParse({
        ...createInput(),
        userId: "attacker",
        apiKeyId: "attacker-key",
        plan: "enterprise",
      }).success
    ).toBe(false);
  });
});
