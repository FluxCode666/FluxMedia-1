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
  plan: "pro",
} satisfies Principal;

/** 创建一个最小合法图片异步任务输入，测试按需覆盖字段。 */
function createInput() {
  return {
    taskId: "task_123",
    generationInputs: [
      {
        operation: "generate" as const,
        prompt: "first image",
        model: "gpt-image-2",
        generationId: "generation-1",
      },
      {
        operation: "generate" as const,
        prompt: "second image",
        model: "gpt-image-2",
        generationId: "generation-2",
      },
    ],
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

  it("接受同一操作且 generationId 唯一的 JSON-safe 批次", () => {
    expect(imageEnqueueAsyncInputSchema.safeParse(createInput()).success).toBe(
      true
    );
  });

  it("拒绝重复 generationId 和混合操作批次", () => {
    const duplicate = createInput();
    duplicate.generationInputs[1] = {
      operation: "generate",
      prompt: "second image",
      model: "gpt-image-2",
      generationId: "generation-1",
    };
    expect(imageEnqueueAsyncInputSchema.safeParse(duplicate).success).toBe(
      false
    );

    const mixed = {
      ...createInput(),
      generationInputs: [
        createInput().generationInputs[0],
        {
          operation: "edit" as const,
          prompt: "edit image",
          model: "gpt-image-2",
          generationId: "generation-3",
          images: [
            {
              source: "storage" as const,
              mimeType: "image/png",
              storageKey: "users/user-1/input.png",
              byteLength: 100,
            },
          ],
        },
      ],
    };
    expect(imageEnqueueAsyncInputSchema.safeParse(mixed).success).toBe(false);
  });

  it("拒绝把异步编辑 data 或 remote 媒体持久化进任务输入", () => {
    const dataInput = {
      ...createInput(),
      generationInputs: [
        {
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
      ],
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

  it("按外部 API 能力推导批次能力且不接收身份字段", () => {
    const requirement = imageEnqueueAsync.capabilities?.[0];
    if (!requirement || !("derive" in requirement)) {
      throw new Error("image.enqueueAsync 缺少动态套餐能力声明");
    }
    expect(requirement.derive(createInput(), externalPrincipal)).toEqual([
      "externalApi.images.generate",
      "externalApi.images.batch",
    ]);
    expect(
      imageEnqueueAsyncInputSchema.safeParse({
        ...createInput(),
        userId: "attacker",
        apiKeyId: "attacker-key",
      }).success
    ).toBe(false);
  });
});
