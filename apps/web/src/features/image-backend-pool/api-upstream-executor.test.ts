/**
 * API 上游通用执行器测试。
 *
 * 职责：用真实 QuickJS Worker 和可注入传输验证路径、Query、认证、脚本阶段及
 * 一次外呼不变量；不访问网络或真实供应商。
 */
import {
  type ApiUpstreamAdapterDraft,
  createDefaultApiUpstreamOperations,
} from "@repo/shared/image-backend/api-upstream-adaptation";
import { describe, expect, it, vi } from "vitest";

import {
  type ApiUpstreamExecutionError,
  executeApiUpstreamOperation,
} from "./api-upstream-executor";

/** 构造不含密钥的默认版本配置，测试只覆盖显式改动。 */
function createAdapter(
  overrides: Partial<ApiUpstreamAdapterDraft> = {}
): ApiUpstreamAdapterDraft {
  const base: ApiUpstreamAdapterDraft = {
    baseUrl: "http://upstream.internal:8080/v1",
    useStream: false,
    videoSubmissionRetryCount: 2,
    videoProtocolMode: "custom",
    videoInputCapabilities: {
      referenceVideos: false,
      referenceAudios: false,
    },
    modelMappings: [],
    authentication: { mode: "bearer" },
    credentialScope: "http://upstream.internal:8080|bearer",
    operations: createDefaultApiUpstreamOperations(),
  };
  return {
    ...base,
    ...overrides,
    videoInputCapabilities:
      overrides.videoInputCapabilities ?? base.videoInputCapabilities,
  };
}

describe("executeApiUpstreamOperation", () => {
  it("在外呼前合并请求信封、重复 Query 并最后注入认证", async () => {
    const adapter = createAdapter();
    adapter.operations["images.generate"] = {
      path: "/custom/images",
      requestScript: `
        return {
          query: { size: null, tag: ["first", "second"] },
          headers: { "X-Vendor-Mode": "fast" },
          body: { ...request.body, model_id: context.upstreamModelId }
        };
      `,
      responseScript: "",
    };
    const fetcher = vi.fn(
      async (_url: string, _init: Record<string, unknown>) =>
        new Response('{"data":[]}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );
    const onRequestSnapshot = vi.fn();

    const result = await executeApiUpstreamOperation({
      adapter,
      apiKey: "secret-key",
      operation: "images.generate",
      platformModelId: "seedance2",
      upstreamModelId: "seedance-2.0",
      contentType: "application/json",
      query: { size: "1024x1024", keep: true },
      body: { prompt: "test", model: "seedance2" },
      maxResponseBytes: 2 * 1024 * 1024,
      fetcher,
      onRequestSnapshot,
    });

    expect(result.kind).toBe("built_in");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe(
      "http://upstream.internal:8080/v1/custom/images?keep=true&tag=first&tag=second"
    );
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: "Bearer secret-key",
        "Content-Type": "application/json",
        "X-Vendor-Mode": "fast",
      },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      prompt: "test",
      model: "seedance2",
      model_id: "seedance-2.0",
    });
    expect(onRequestSnapshot).toHaveBeenCalledWith({
      operation: "images.generate",
      contentType: "application/json",
      body: {
        prompt: "test",
        model: "seedance2",
        model_id: "seedance-2.0",
      },
    });
    expect(onRequestSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      fetcher.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
  });

  it("响应脚本统一异步状态并采用较长的 Retry-After", async () => {
    const adapter = createAdapter();
    adapter.operations["videos.generate"] = {
      path: "",
      requestScript: "",
      responseScript: `
        return {
          status: "processing",
          taskId: response.body.vendor_task,
          pollAfterSeconds: 2
        };
      `,
    };
    const fetcher = vi.fn(async () =>
      Promise.resolve(
        new Response('{"vendor_task":"task-1"}', {
          status: 202,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": "7",
          },
        })
      )
    );

    const result = await executeApiUpstreamOperation({
      adapter,
      apiKey: "secret-key",
      operation: "videos.generate",
      platformModelId: "seedance2",
      upstreamModelId: "seedance-2.0",
      contentType: "application/json",
      body: { prompt: "test" },
      maxResponseBytes: 2 * 1024 * 1024,
      fetcher,
    });

    expect(result).toMatchObject({
      kind: "scripted",
      pollAfterSeconds: 7,
      result: { status: "processing", taskId: "task-1" },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("请求脚本失败发生在外呼前，响应脚本失败发生在外呼后", async () => {
    const requestFailureAdapter = createAdapter();
    requestFailureAdapter.operations["images.generate"].requestScript =
      "throw new Error('hidden request body');";
    const requestFetcher = vi.fn(async () => new Response("{}"));
    const requestSnapshot = vi.fn();

    await expect(
      executeApiUpstreamOperation({
        adapter: requestFailureAdapter,
        apiKey: "secret-key",
        operation: "images.generate",
        platformModelId: "gpt-image-2",
        upstreamModelId: "vendor-image",
        contentType: "application/json",
        body: { prompt: "secret prompt" },
        maxResponseBytes: 2 * 1024 * 1024,
        fetcher: requestFetcher,
        onRequestSnapshot: requestSnapshot,
      })
    ).rejects.toMatchObject({
      code: "request_script_failed",
      stage: "before_send",
    } satisfies Partial<ApiUpstreamExecutionError>);
    expect(requestFetcher).not.toHaveBeenCalled();
    expect(requestSnapshot).not.toHaveBeenCalled();

    const responseFailureAdapter = createAdapter();
    responseFailureAdapter.operations["images.generate"].responseScript =
      "throw new Error('hidden response body');";
    const responseFetcher = vi.fn(async () =>
      Promise.resolve(
        new Response('{"secret":"provider payload"}', {
          headers: { "Content-Type": "application/json" },
        })
      )
    );
    await expect(
      executeApiUpstreamOperation({
        adapter: responseFailureAdapter,
        apiKey: "secret-key",
        operation: "images.generate",
        platformModelId: "gpt-image-2",
        upstreamModelId: "vendor-image",
        contentType: "application/json",
        body: { prompt: "secret prompt" },
        maxResponseBytes: 2 * 1024 * 1024,
        fetcher: responseFetcher,
      })
    ).rejects.toMatchObject({
      code: "response_script_failed",
      stage: "after_send",
      message: expect.stringMatching(
        /^供应商请求处理失败，请联系管理员（请求标识：apiu_[a-f0-9]{32}）$/
      ),
    } satisfies Partial<ApiUpstreamExecutionError>);
    expect(responseFetcher).toHaveBeenCalledTimes(1);
  });

  it("拒绝脚本覆盖自定义认证 Header", async () => {
    const adapter = createAdapter({
      authentication: { mode: "custom_header", headerName: "X-Api-Key" },
      credentialScope: "http://upstream.internal:8080|custom_header:x-api-key",
    });
    adapter.operations["images.generate"].requestScript = `
      return { headers: { "x-api-key": "script-secret" } };
    `;
    const fetcher = vi.fn(async () => new Response("{}"));

    await expect(
      executeApiUpstreamOperation({
        adapter,
        apiKey: "host-secret",
        operation: "images.generate",
        platformModelId: "gpt-image-2",
        upstreamModelId: "gpt-image-2",
        contentType: "application/json",
        body: { prompt: "test" },
        maxResponseBytes: 2 * 1024 * 1024,
        fetcher,
      })
    ).rejects.toMatchObject({ stage: "before_send" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ".",
    "..",
  ])("拒绝任务 ID %s 形成 URL dot segment", async (taskId) => {
    const fetcher = vi.fn(async () => new Response("{}"));

    await expect(
      executeApiUpstreamOperation({
        adapter: createAdapter(),
        apiKey: "secret-key",
        operation: "videos.query",
        platformModelId: "seedance2",
        upstreamModelId: "seedance-2.0",
        contentType: "application/json",
        taskId,
        maxResponseBytes: 2 * 1024 * 1024,
        fetcher,
      })
    ).rejects.toMatchObject({
      code: "invalid_configuration",
      stage: "before_send",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("multipart 生成缺少宿主专用编码器时失败关闭", async () => {
    const fetcher = vi.fn(async () => new Response("{}"));

    await expect(
      executeApiUpstreamOperation({
        adapter: createAdapter(),
        apiKey: "secret-key",
        operation: "images.edit",
        platformModelId: "gpt-image-2",
        upstreamModelId: "vendor-image",
        contentType: "multipart/form-data",
        body: { image: "opaque-token" },
        maxResponseBytes: 2 * 1024 * 1024,
        fetcher,
      })
    ).rejects.toMatchObject({
      code: "invalid_configuration",
      stage: "before_send",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("合并后的 Query 超过总值预算时不上游发送", async () => {
    const adapter = createAdapter();
    adapter.operations["images.generate"].requestScript =
      'return { query: { overflow: "value" } };';
    const query = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [`key_${index}`, "value"])
    );
    const fetcher = vi.fn(async () => new Response("{}"));

    await expect(
      executeApiUpstreamOperation({
        adapter,
        apiKey: "secret-key",
        operation: "images.generate",
        platformModelId: "gpt-image-2",
        upstreamModelId: "vendor-image",
        contentType: "application/json",
        query,
        body: { prompt: "test" },
        maxResponseBytes: 2 * 1024 * 1024,
        fetcher,
      })
    ).rejects.toMatchObject({
      code: "request_script_failed",
      stage: "before_send",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("拒绝把宿主媒体令牌从 Body 复制到业务 Header", async () => {
    const adapter = createAdapter();
    adapter.operations["images.generate"].requestScript = `
      return {
        headers: { "X-Media-Token": request.body.image }
      };
    `;
    const fetcher = vi.fn(async () => new Response("{}"));

    await expect(
      executeApiUpstreamOperation({
        adapter,
        apiKey: "secret-key",
        operation: "images.generate",
        platformModelId: "gpt-image-2",
        upstreamModelId: "vendor-image",
        contentType: "application/json",
        body: { image: "opaque-media-token" },
        opaqueValues: new Map([["opaque-media-token", "protected-media"]]),
        maxResponseBytes: 2 * 1024 * 1024,
        fetcher,
      })
    ).rejects.toMatchObject({
      code: "request_script_failed",
      stage: "before_send",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [
      "Header",
      `return {
        headers: { "X-Media-Token": request.body.image },
        body: { prompt: "test" }
      };`,
    ],
    [
      "Query",
      `return {
        query: { media: request.body.image },
        body: { prompt: "test" }
      };`,
    ],
  ])("拒绝把宿主媒体令牌从 Body 移到%s", async (_target, script) => {
    const adapter = createAdapter();
    adapter.operations["images.generate"].requestScript = script;
    const fetcher = vi.fn(async () => new Response("{}"));

    await expect(
      executeApiUpstreamOperation({
        adapter,
        apiKey: "secret-key",
        operation: "images.generate",
        platformModelId: "gpt-image-2",
        upstreamModelId: "vendor-image",
        contentType: "application/json",
        body: { image: "opaque-media-token" },
        opaqueValues: new Map([["opaque-media-token", "protected-media"]]),
        maxResponseBytes: 2 * 1024 * 1024,
        fetcher,
      })
    ).rejects.toMatchObject({
      code: "request_script_failed",
      stage: "before_send",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("认证密钥包含 CR 或 LF 时不上游发送", async () => {
    const fetcher = vi.fn(async () => new Response("{}"));

    await expect(
      executeApiUpstreamOperation({
        adapter: createAdapter(),
        apiKey: "secret\r\ninjected",
        operation: "images.generate",
        platformModelId: "gpt-image-2",
        upstreamModelId: "vendor-image",
        contentType: "application/json",
        body: { prompt: "test" },
        maxResponseBytes: 2 * 1024 * 1024,
        fetcher,
      })
    ).rejects.toMatchObject({
      code: "invalid_configuration",
      stage: "before_send",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("响应流读取失败与管理员响应脚本失败使用不同错误码", async () => {
    const adapter = createAdapter();
    adapter.operations["images.generate"].responseScript =
      'return { status: "completed", outputs: [] };';
    const fetcher = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("hidden upstream stream failure"));
            },
          }),
          { headers: { "Content-Type": "application/json" } }
        )
    );

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
      code: "response_read_failed",
      stage: "after_send",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
