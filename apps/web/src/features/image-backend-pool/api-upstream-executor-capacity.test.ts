/**
 * API 上游执行器容量降级测试。
 *
 * 职责：隔离 Worker Pool 容量入口，验证空响应脚本不依赖 Pool，而需要脚本的
 * 请求在预留容量失败时返回平台繁忙且不访问供应商。
 */

import {
  type ApiUpstreamAdapterDraft,
  createDefaultApiUpstreamOperations,
} from "@repo/shared/image-backend/api-upstream-adaptation";
import { describe, expect, it, vi } from "vitest";

vi.mock("./api-upstream-script-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./api-upstream-script-runtime")>();
  return {
    ...actual,
    reserveApiUpstreamResponsePermit: vi.fn(async () => {
      throw new actual.ApiUpstreamScriptRuntimeError("runtime_saturated", 1);
    }),
  };
});

import { executeApiUpstreamOperation } from "./api-upstream-executor";

/** 创建只使用内置认证与路径的最小 API 适配版本。 */
function createAdapter(): ApiUpstreamAdapterDraft {
  return {
    baseUrl: "http://upstream.internal:8080/v1",
    useStream: false,
    videoSubmissionRetryCount: 2,
    videoProtocolMode: "custom",
    modelMappings: [],
    authentication: { mode: "bearer" },
    credentialScope: "http://upstream.internal:8080|bearer",
    operations: createDefaultApiUpstreamOperations(),
  };
}

describe("executeApiUpstreamOperation capacity fallback", () => {
  it("空响应脚本在 Worker Pool 饱和时仍使用内置协议", async () => {
    const fetcher = vi.fn(async () =>
      Promise.resolve(Response.json({ data: [] }))
    );

    await expect(
      executeApiUpstreamOperation({
        adapter: createAdapter(),
        apiKey: "secret-key",
        operation: "images.generate",
        platformModelId: "gpt-image-2",
        upstreamModelId: "vendor-image",
        contentType: "application/json",
        body: { prompt: "test" },
        maxResponseBytes: 2 * 1024 * 1024,
        fetcher,
      })
    ).resolves.toMatchObject({ kind: "built_in" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("响应脚本无法预留容量时返回平台繁忙且不上游发送", async () => {
    const adapter = createAdapter();
    adapter.operations["images.generate"].responseScript =
      'return { status: "completed", outputs: [] };';
    const fetcher = vi.fn(async () => Response.json({ data: [] }));

    await expect(
      executeApiUpstreamOperation({
        adapter,
        apiKey: "secret-key",
        operation: "images.generate",
        platformModelId: "gpt-image-2",
        upstreamModelId: "vendor-image",
        contentType: "application/json",
        body: { prompt: "test" },
        maxResponseBytes: 2 * 1024 * 1024,
        fetcher,
      })
    ).rejects.toMatchObject({
      code: "platform_busy",
      message: "服务繁忙，请稍后重试",
      retryAfterSeconds: 1,
      stage: "before_send",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
