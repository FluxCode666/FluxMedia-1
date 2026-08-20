/**
 * Images API 生成、编辑与 SSE 解析回归测试。
 *
 * 使用方：Vitest；仅覆盖保留的图片运行时，不访问数据库或真实上游。
 */

import { createDefaultApiUpstreamOperations } from "@repo/shared/image-backend/api-upstream-adaptation";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiConfig } from "./types";

const mocks = vi.hoisted(() => ({
  fetchMediaUpstream: vi.fn(),
  fetchMediaUpstreamDownload: vi.fn(),
  logApiUpstreamImageTaskOrphanRisk: vi.fn(),
}));

vi.mock("@/features/image-backend-pool/media-upstream-fetch", () => ({
  fetchMediaUpstream: mocks.fetchMediaUpstream,
  fetchMediaUpstreamDownload: mocks.fetchMediaUpstreamDownload,
}));

vi.mock(
  "@/features/image-backend-pool/api-upstream-observability",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/features/image-backend-pool/api-upstream-observability")
      >();
    return {
      ...actual,
      logApiUpstreamImageTaskOrphanRisk:
        mocks.logApiUpstreamImageTaskOrphanRisk,
    };
  }
);

/** 构造一段符合 Images API 约定的 SSE 事件。 */
function sseBlock(event: string, data: Record<string, unknown>) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** 为动态导入 service.ts 准备 DB-free 测试所需的惰性环境占位。 */
function prepareTestEnvironment() {
  process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";
}

/** 构造启用模型映射和隔离请求脚本的 API 池账号。 */
function createPoolApiConfig(requestScriptBody: string): ApiConfig {
  const operations = createDefaultApiUpstreamOperations();
  const wrappedScript = requestScriptBody.trim()
    ? `
function transformSampleRequest(request) {
${requestScriptBody}
}
return { body: transformSampleRequest(request.body) };
`
    : "";
  operations["images.generate"].requestScript = wrappedScript;
  operations["images.edit"].requestScript = wrappedScript;
  const adapter = {
    baseUrl: "https://api.example.test/v1",
    useStream: false,
    videoSubmissionRetryCount: 2,
    videoProtocolMode: "custom" as const,
    modelMappings: [
      { modelId: "gpt-image-2", upstreamModelId: "vendor-image-id" },
    ],
    authentication: { mode: "bearer" as const },
    credentialScope: "https://api.example.test|bearer",
    operations,
  };
  return {
    baseUrl: adapter.baseUrl,
    apiKey: "test-key",
    backend: {
      type: "pool-api",
      modelMappings: adapter.modelMappings,
      apiUpstreamAdapter: adapter,
    },
  };
}

/** 构造 Images API 成功响应，供请求体适配测试复用。 */
function successfulImageResponse() {
  return Response.json({
    data: [{ b64_json: Buffer.from("image-result").toString("base64") }],
  });
}

describe("Images API service", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("解析 content-type 错误的 Images SSE 响应", async () => {
    prepareTestEnvironment();
    const { generateImage } = await import("./service");
    const imageBase64 = Buffer.from("image-result").toString("base64");
    const fetchMock = mocks.fetchMediaUpstream.mockImplementation(
      async () =>
        new Response(
          sseBlock("image_generation.completed", {
            type: "image_generation.completed",
            b64_json: imageBase64,
            revised_prompt: "a small test icon",
          }),
          { status: 200, headers: { "Content-Type": "text/plain" } }
        )
    );
    const result = await generateImage(
      {
        baseUrl: "https://api.example.test/v1",
        apiKey: "test-key",
        useStream: true,
      },
      { prompt: "make an icon", model: "gpt-image-2", size: "1024x1024" }
    );

    expect(result.imageBase64).toBe(imageBase64);
    expect(result.revisedPrompt).toBe("a small test icon");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/v1/images/generations",
      expect.objectContaining({
        body: expect.stringContaining('"stream":true'),
      })
    );
  });

  it("以完成事件覆盖较早的局部图片", async () => {
    prepareTestEnvironment();
    const { generateImage } = await import("./service");
    const partialBase64 = Buffer.from("partial-image").toString("base64");
    const finalBase64 = Buffer.from("final-image").toString("base64");
    const partials: string[] = [];
    mocks.fetchMediaUpstream.mockResolvedValue(
      new Response(
        sseBlock("image_generation.partial_image", {
          type: "image_generation.partial_image",
          b64_json: partialBase64,
          partial_image_index: 0,
        }) +
          sseBlock("image_generation.completed", {
            type: "image_generation.completed",
            b64_json: finalBase64,
          }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      )
    );

    const result = await generateImage(
      {
        baseUrl: "https://api.example.test/v1",
        apiKey: "test-key",
        useStream: true,
      },
      { prompt: "make an icon", model: "gpt-image-2", size: "1024x1024" },
      {
        onPartialImage: (image) => {
          if (image.imageBase64) partials.push(image.imageBase64);
        },
      }
    );

    expect(partials).toEqual([partialBase64]);
    expect(result.imageBase64).toBe(finalBase64);
  });

  it("保留 Images SSE 中的结构化错误", async () => {
    prepareTestEnvironment();
    const { generateImage } = await import("./service");
    mocks.fetchMediaUpstream.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message: "The quota has been exceeded.",
            code: "quota_exceeded",
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      )
    );

    const result = await generateImage(
      { baseUrl: "https://api.example.test/v1", apiKey: "test-key" },
      { prompt: "make an icon", model: "gpt-image-2" }
    );

    expect(result.error).toContain("The quota has been exceeded.");
    expect(result.error).toContain("quota_exceeded");
  });

  it("将 Images API 的 image_unsafe 拒绝映射为友好业务提示", async () => {
    prepareTestEnvironment();
    const { generateImage } = await import("./service");
    mocks.fetchMediaUpstream.mockResolvedValue(
      Response.json(
        {
          error_code: "image_unsafe",
          message:
            "The generated images appear to be unsafe. Try modifying the prompts or the seeds.",
        },
        { status: 451 }
      )
    );

    const result = await generateImage(
      { baseUrl: "https://api.example.test/v1", apiKey: "test-key" },
      { prompt: "unsafe prompt", model: "gpt-image-2" }
    );

    expect(result.error).toBe("提示词未通过内容安全审核，请修改提示词后重试。");
  });

  it("文生图未传尺寸时向上游发送 auto", async () => {
    prepareTestEnvironment();
    const { generateImage } = await import("./service");
    mocks.fetchMediaUpstream.mockResolvedValue(successfulImageResponse());

    const result = await generateImage(
      { baseUrl: "https://api.example.test/v1", apiKey: "test-key" },
      { prompt: "make an icon", model: "gpt-image-2" }
    );

    expect(result.error).toBeUndefined();
    const requestInit = mocks.fetchMediaUpstream.mock.calls[0]?.[1];
    expect(JSON.parse(String(requestInit?.body))).toMatchObject({
      size: "auto",
    });
  });

  it("普通平台文生图在外呼前暴露脱敏后的实际请求 JSON", async () => {
    prepareTestEnvironment();
    const { generateImage } = await import("./service");
    const onApiUpstreamRequestSnapshot = vi.fn();
    mocks.fetchMediaUpstream.mockResolvedValue(successfulImageResponse());

    const result = await generateImage(
      { baseUrl: "https://api.example.test/v1", apiKey: "test-key" },
      { prompt: "make an icon", model: "gpt-image-2", size: "1024x1024" },
      { onApiUpstreamRequestSnapshot }
    );

    expect(result.error).toBeUndefined();
    expect(onApiUpstreamRequestSnapshot).toHaveBeenCalledWith({
      operation: "images.generate",
      contentType: "application/json",
      body: expect.objectContaining({
        model: "gpt-image-2",
        size: "1024x1024",
        response_format: "b64_json",
      }),
    });
  });

  it("Adobe gateway 文生图在外呼前暴露实际请求 JSON", async () => {
    prepareTestEnvironment();
    const { generateImage } = await import("./service");
    const onApiUpstreamRequestSnapshot = vi.fn();
    mocks.fetchMediaUpstream.mockResolvedValue(
      Response.json({
        choices: [
          {
            message: {
              content: "![generated](https://cdn.example.test/image.png)",
            },
          },
        ],
      })
    );
    mocks.fetchMediaUpstreamDownload.mockResolvedValue(
      new Response(Buffer.from("image-result"), { status: 200 })
    );

    const result = await generateImage(
      {
        baseUrl: "https://adobe.example.test/v1",
        apiKey: "test-key",
        backend: { type: "pool-adobe", adobeMode: "gateway" },
      },
      { prompt: "make an icon", model: "gpt-image-2", size: "1024x1024" },
      { onApiUpstreamRequestSnapshot }
    );

    expect(result.error).toBeUndefined();
    expect(onApiUpstreamRequestSnapshot).toHaveBeenCalledWith({
      operation: "images.generate",
      contentType: "application/json",
      body: expect.objectContaining({
        model: expect.any(String),
        messages: expect.any(Array),
      }),
    });
  });

  it("生成图片时映射上游模型并执行 JSON 请求脚本", async () => {
    prepareTestEnvironment();
    const { generateImage } = await import("./service");
    mocks.fetchMediaUpstream.mockResolvedValue(successfulImageResponse());
    const onApiUpstreamRequestSnapshot = vi.fn();

    const result = await generateImage(
      createPoolApiConfig(`
request.vendor_size = request.size;
request.adaptation = context.platformModelId + "->" + context.upstreamModelId;
delete request.size;
return request;
`),
      { prompt: "make an icon", model: "gpt-image-2", size: "1024x1024" },
      { onApiUpstreamRequestSnapshot }
    );

    expect(result.error).toBeUndefined();
    expect(mocks.fetchMediaUpstream).toHaveBeenCalledTimes(1);
    const requestInit = mocks.fetchMediaUpstream.mock.calls[0]?.[1];
    const body = JSON.parse(String(requestInit?.body)) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      model: "vendor-image-id",
      vendor_size: "1024x1024",
      adaptation: "gpt-image-2->vendor-image-id",
    });
    expect(body).not.toHaveProperty("size");
    expect(onApiUpstreamRequestSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "images.generate",
        contentType: "application/json",
        body: expect.objectContaining({
          model: "vendor-image-id",
          vendor_size: "1024x1024",
          adaptation: "gpt-image-2->vendor-image-id",
        }),
      })
    );
  });

  it("生成图片请求脚本失败时不调用上游", async () => {
    prepareTestEnvironment();
    const { generateImage } = await import("./service");

    const result = await generateImage(
      createPoolApiConfig('throw new Error("script failure");'),
      { prompt: "make an icon", model: "gpt-image-2" }
    );

    expect(result.error).toMatch(
      /^供应商请求处理失败，请联系管理员（请求标识：apiu_[a-f0-9]{32}）$/
    );
    expect(mocks.fetchMediaUpstream).not.toHaveBeenCalled();
  });

  it("生成脚本返回任务 ID 后只按固定查询路径轮询原任务", async () => {
    prepareTestEnvironment();
    const { generateImage } = await import("./service");
    const config = createPoolApiConfig("");
    const adapter = config.backend?.apiUpstreamAdapter;
    if (!adapter) throw new Error("missing adapter");
    adapter.operations["images.generate"].responseScript = `
      return {
        status: "processing",
        taskId: response.body.vendor_task,
        pollAfterSeconds: 1
      };
    `;
    adapter.operations["images.generate.query"] = {
      path: "/vendor/images/{task_id}",
      requestScript: 'return { query: { detail: "full" } };',
      responseScript: `
        return {
          status: "completed",
          outputs: [{ kind: "image", base64: response.body.image }]
        };
      `,
    };
    const imageBase64 = Buffer.from("async-image").toString("base64");
    mocks.fetchMediaUpstream
      .mockResolvedValueOnce(
        Response.json({
          vendor_task: "task/1",
          poll_url: "https://attacker.example/status/task-1",
        })
      )
      .mockResolvedValueOnce(Response.json({ image: imageBase64 }));

    const result = await generateImage(config, {
      prompt: "make an icon",
      model: "gpt-image-2",
    });

    expect(result.imageBase64).toBe(imageBase64);
    expect(mocks.fetchMediaUpstream).toHaveBeenCalledTimes(2);
    expect(mocks.fetchMediaUpstream.mock.calls[1]?.[0]).toBe(
      "https://api.example.test/v1/vendor/images/task%2F1?detail=full"
    );
    expect(mocks.logApiUpstreamImageTaskOrphanRisk).toHaveBeenCalledWith({
      operation: "images.generate",
      platformModelId: "gpt-image-2",
      observability: { memberId: undefined, groupId: undefined },
    });
  });

  it("图片生成接受异步任务但查询路径未配置时立即失败关闭", async () => {
    prepareTestEnvironment();
    const { generateImage } = await import("./service");
    const config = createPoolApiConfig("");
    const adapter = config.backend?.apiUpstreamAdapter;
    if (!adapter) throw new Error("missing adapter");
    adapter.operations["images.generate"].responseScript = `
      return {
        status: "processing",
        taskId: response.body.vendor_task
      };
    `;
    mocks.fetchMediaUpstream.mockResolvedValueOnce(
      Response.json({ vendor_task: "task-1" })
    );

    const result = await generateImage(config, {
      prompt: "make an icon",
      model: "gpt-image-2",
    });

    expect(result).toMatchObject({
      error: "供应商请求处理失败，请联系管理员",
      backendSwitchAllowed: false,
    });
    expect(mocks.fetchMediaUpstream).toHaveBeenCalledTimes(1);
    expect(mocks.logApiUpstreamImageTaskOrphanRisk).toHaveBeenCalledTimes(1);
  });

  it("任务 ID 返回后模拟进程终止不会再次提交生成请求", async () => {
    prepareTestEnvironment();
    const { generateImage } = await import("./service");
    const controller = new AbortController();
    const config = createPoolApiConfig("");
    const adapter = config.backend?.apiUpstreamAdapter;
    if (!adapter) throw new Error("missing adapter");
    adapter.operations["images.generate"].responseScript = `
      return {
        status: "processing",
        taskId: response.body.vendor_task
      };
    `;
    adapter.operations["images.generate.query"].path =
      "/vendor/images/{task_id}";
    mocks.fetchMediaUpstream.mockImplementationOnce(async () => {
      controller.abort(new Error("simulated process shutdown"));
      return Response.json({ vendor_task: "task-after-submit" });
    });

    await expect(
      generateImage(config, {
        prompt: "make an icon",
        model: "gpt-image-2",
        signal: controller.signal,
      })
    ).resolves.toMatchObject({ error: "simulated process shutdown" });

    expect(mocks.fetchMediaUpstream).toHaveBeenCalledTimes(1);
    expect(mocks.logApiUpstreamImageTaskOrphanRisk).toHaveBeenCalledTimes(1);
  });

  it("轮询中模拟进程终止只查询原任务且不重发生成 POST", async () => {
    prepareTestEnvironment();
    const { generateImage } = await import("./service");
    const controller = new AbortController();
    const config = createPoolApiConfig("");
    const adapter = config.backend?.apiUpstreamAdapter;
    if (!adapter) throw new Error("missing adapter");
    adapter.operations["images.generate"].responseScript = `
      return {
        status: "processing",
        taskId: response.body.vendor_task,
        pollAfterSeconds: 1
      };
    `;
    adapter.operations["images.generate.query"] = {
      path: "/vendor/images/{task_id}",
      requestScript: "",
      responseScript: `
        return {
          status: "processing",
          progress: response.body.progress,
          pollAfterSeconds: 1
        };
      `,
    };
    mocks.fetchMediaUpstream
      .mockResolvedValueOnce(Response.json({ vendor_task: "task-during-poll" }))
      .mockImplementationOnce(async () => {
        controller.abort(new Error("simulated process shutdown"));
        return Response.json({ progress: 50 });
      });

    await expect(
      generateImage(config, {
        prompt: "make an icon",
        model: "gpt-image-2",
        signal: controller.signal,
      })
    ).resolves.toMatchObject({ error: "simulated process shutdown" });

    expect(mocks.fetchMediaUpstream).toHaveBeenCalledTimes(2);
    expect(mocks.fetchMediaUpstream.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
    });
    expect(mocks.fetchMediaUpstream.mock.calls[1]?.[1]).toMatchObject({
      method: "GET",
    });
    expect(mocks.logApiUpstreamImageTaskOrphanRisk).toHaveBeenCalledTimes(1);
  });

  it.each([
    { retryable: false, backendSwitchAllowed: false },
    { retryable: true, backendSwitchAllowed: true },
  ])("仅在响应脚本显式设置 retryable=$retryable 时允许切换账号", async ({
    retryable,
    backendSwitchAllowed,
  }) => {
    prepareTestEnvironment();
    const { generateImage } = await import("./service");
    const config = createPoolApiConfig("");
    const adapter = config.backend?.apiUpstreamAdapter;
    if (!adapter) throw new Error("missing adapter");
    adapter.operations["images.generate"].responseScript = `
        return {
          status: "failed",
          error: { category: "upstream", code: "image_submit_failed" },
          retryable: ${String(retryable)}
        };
      `;
    mocks.fetchMediaUpstream.mockResolvedValueOnce(
      Response.json({ status: "failed" })
    );

    const result = await generateImage(config, {
      prompt: "make an icon",
      model: "gpt-image-2",
    });

    expect(result).toMatchObject({
      error: "供应商图片任务失败，请联系管理员",
      backendSwitchAllowed,
    });
    expect(mocks.fetchMediaUpstream).toHaveBeenCalledTimes(1);
  });

  it("响应脚本把图片 data URL 规范为现有管线使用的纯 Base64", async () => {
    prepareTestEnvironment();
    const { generateImage } = await import("./service");
    const config = createPoolApiConfig("");
    const adapter = config.backend?.apiUpstreamAdapter;
    if (!adapter) throw new Error("missing adapter");
    adapter.operations["images.generate"].responseScript = `
      return {
        status: "completed",
        outputs: [{ kind: "image", base64: response.body.image_data }]
      };
    `;
    const imageBase64 = Buffer.from("data-url-image").toString("base64");
    mocks.fetchMediaUpstream.mockResolvedValueOnce(
      Response.json({ image_data: `data:image/png;base64,${imageBase64}` })
    );

    const result = await generateImage(config, {
      prompt: "make an icon",
      model: "gpt-image-2",
    });

    expect(result.imageBase64).toBe(imageBase64);
  });

  it("通过 multipart Images API 发送输入图、蒙版和安全引用标签", async () => {
    prepareTestEnvironment();
    const { editImage } = await import("./service");
    const imageBase64 = Buffer.from("edited-image").toString("base64");
    const fetchMock = mocks.fetchMediaUpstream.mockImplementation(
      async (_url: string, init?: { body?: unknown }) => {
        const formData = init?.body;
        expect(formData).toBeInstanceOf(FormData);
        if (!(formData instanceof FormData))
          throw new Error("missing FormData");
        expect(formData.get("image")).toBeInstanceOf(Blob);
        expect(formData.get("mask")).toBeInstanceOf(Blob);
        expect(String(formData.get("prompt"))).toContain(
          '<ref id="edit-reference-1" prompt="source &amp;&quot;.png" />'
        );
        return new Response(
          JSON.stringify({ data: [{ b64_json: imageBase64 }] }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    );

    const result = await editImage(
      { baseUrl: "https://api.example.test/v1", apiKey: "test-key" },
      {
        prompt: "参考 @图1 调整颜色",
        model: "gpt-image-2",
        images: [
          {
            name: 'source &".png',
            type: "image/png",
            data: Buffer.from("source-image"),
          },
        ],
        mask: {
          name: "mask.png",
          type: "image/png",
          data: Buffer.from("mask-image"),
        },
      }
    );

    expect(result.imageBase64).toBe(imageBase64);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/v1/images/edits",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("普通平台图生图保存文件描述而不保存二进制正文", async () => {
    prepareTestEnvironment();
    const { editImage } = await import("./service");
    const onApiUpstreamRequestSnapshot = vi.fn();
    mocks.fetchMediaUpstream.mockResolvedValue(successfulImageResponse());

    const result = await editImage(
      { baseUrl: "https://api.example.test/v1", apiKey: "test-key" },
      {
        prompt: "adjust colors",
        model: "gpt-image-2",
        images: [
          {
            name: "source.png",
            type: "image/png",
            data: Buffer.from("source-image"),
          },
        ],
      },
      { onApiUpstreamRequestSnapshot }
    );

    expect(result.error).toBeUndefined();
    expect(onApiUpstreamRequestSnapshot).toHaveBeenCalledWith({
      operation: "images.edit",
      contentType: "multipart/form-data",
      body: expect.objectContaining({
        image: expect.objectContaining({
          type: "File",
          name: "source.png",
          mimeType: "image/png",
          data: "[REDACTED]",
        }),
      }),
    });
  });

  it("编辑图片时映射上游模型并允许脚本重命名媒体字段", async () => {
    prepareTestEnvironment();
    const { editImage } = await import("./service");
    mocks.fetchMediaUpstream.mockImplementation(
      async (_url: string, init?: { body?: unknown }) => {
        const formData = init?.body;
        expect(formData).toBeInstanceOf(FormData);
        if (!(formData instanceof FormData)) {
          throw new Error("missing FormData");
        }
        expect(formData.get("model")).toBe("vendor-image-id");
        expect(formData.get("source_image")).toBeInstanceOf(Blob);
        expect(formData.has("image")).toBe(false);
        return successfulImageResponse();
      }
    );

    const result = await editImage(
      createPoolApiConfig(`
request.source_image = request.image;
delete request.image;
return request;
`),
      {
        prompt: "adjust colors",
        model: "gpt-image-2",
        images: [
          {
            name: "source.png",
            type: "image/png",
            data: Buffer.from("source-image"),
          },
        ],
      }
    );

    expect(result.error).toBeUndefined();
    expect(mocks.fetchMediaUpstream).toHaveBeenCalledTimes(1);
  });

  it("图生图未传尺寸时向上游发送 auto", async () => {
    prepareTestEnvironment();
    const { editImage } = await import("./service");
    mocks.fetchMediaUpstream.mockImplementation(
      async (_url: string, init?: RequestInit) => {
        const formData = init?.body;
        expect(formData).toBeInstanceOf(FormData);
        if (!(formData instanceof FormData)) {
          throw new Error("missing FormData");
        }
        expect(formData.get("size")).toBe("auto");
        return successfulImageResponse();
      }
    );

    const result = await editImage(
      { baseUrl: "https://api.example.test/v1", apiKey: "test-key" },
      {
        prompt: "adjust colors",
        model: "gpt-image-2",
        images: [
          {
            name: "source.png",
            type: "image/png",
            data: Buffer.from("source-image"),
          },
        ],
      }
    );

    expect(result.error).toBeUndefined();
  });

  it("编辑多图时重命名 image[]、mask 并保持媒体顺序", async () => {
    prepareTestEnvironment();
    const { editImage } = await import("./service");
    mocks.fetchMediaUpstream.mockImplementation(
      async (_url: string, init?: { body?: unknown }) => {
        const formData = init?.body;
        expect(formData).toBeInstanceOf(FormData);
        if (!(formData instanceof FormData)) {
          throw new Error("missing FormData");
        }
        const sources = formData.getAll("source[]");
        expect(sources).toHaveLength(2);
        expect(sources.every((source) => source instanceof Blob)).toBe(true);
        expect(
          await Promise.all(
            sources.map((source) =>
              source instanceof Blob ? source.text() : String(source)
            )
          )
        ).toEqual(["first-image", "second-image"]);
        expect(formData.get("alpha_mask")).toBeInstanceOf(Blob);
        expect(formData.has("image[]")).toBe(false);
        expect(formData.has("mask")).toBe(false);
        return successfulImageResponse();
      }
    );

    const result = await editImage(
      createPoolApiConfig(`
if (Object.hasOwn(request, "image[]")) {
  request["source[]"] = request["image[]"];
  delete request["image[]"];
}
if (Object.hasOwn(request, "mask")) {
  request.alpha_mask = request.mask;
  delete request.mask;
}
return request;
`),
      {
        prompt: "combine source images",
        model: "gpt-image-2",
        images: [
          {
            name: "first.png",
            type: "image/png",
            data: Buffer.from("first-image"),
          },
          {
            name: "second.png",
            type: "image/png",
            data: Buffer.from("second-image"),
          },
        ],
        mask: {
          name: "mask.png",
          type: "image/png",
          data: Buffer.from("mask-image"),
        },
      }
    );

    expect(result.error).toBeUndefined();
    expect(mocks.fetchMediaUpstream).toHaveBeenCalledTimes(1);
  });

  it("编辑图片脚本接收字符串文本字段并按 multipart 规则重编码", async () => {
    prepareTestEnvironment();
    const { editImage } = await import("./service");
    mocks.fetchMediaUpstream.mockImplementation(
      async (_url: string, init?: { body?: unknown }) => {
        const formData = init?.body;
        expect(formData).toBeInstanceOf(FormData);
        if (!(formData instanceof FormData)) {
          throw new Error("missing FormData");
        }
        expect(formData.get("count")).toBe("1");
        expect(JSON.parse(String(formData.get("options")))).toEqual({
          width: 1024,
          compression: 80,
          streaming: true,
        });
        expect(formData.get("image")).toBeInstanceOf(Blob);
        expect(formData.has("n")).toBe(false);
        expect(formData.has("width")).toBe(false);
        expect(formData.has("output_compression")).toBe(false);
        expect(formData.has("stream")).toBe(false);
        return successfulImageResponse();
      }
    );
    const config = {
      ...createPoolApiConfig(`
if (
  typeof request.n !== "string" ||
  typeof request.width !== "string" ||
  typeof request.output_compression !== "string" ||
  request.stream !== "true"
) {
  throw new Error("Unexpected multipart input types");
}
request.count = Number(request.n);
request.options = {
  width: Number(request.width),
  compression: Number(request.output_compression),
  streaming: request.stream === "true",
};
delete request.n;
delete request.width;
delete request.output_compression;
delete request.stream;
return request;
`),
      useStream: true,
    } satisfies ApiConfig;

    const result = await editImage(config, {
      prompt: "adjust colors",
      model: "gpt-image-2",
      size: "1024x1024",
      outputCompression: 80,
      images: [
        {
          name: "source.png",
          type: "image/png",
          data: Buffer.from("source-image"),
        },
      ],
    });

    expect(result.error).toBeUndefined();
    expect(mocks.fetchMediaUpstream).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["删除", "delete request.image; return request;"],
    ["复制", "request.image_copy = request.image; return request;"],
    [
      "嵌套到对象",
      "request.payload = { image: request.image }; delete request.image; return request;",
    ],
  ])("编辑图片脚本%s媒体令牌时失败关闭", async (_caseName, script) => {
    prepareTestEnvironment();
    const { editImage } = await import("./service");

    const result = await editImage(createPoolApiConfig(script), {
      prompt: "adjust colors",
      model: "gpt-image-2",
      images: [
        {
          name: "source.png",
          type: "image/png",
          data: Buffer.from("source-image"),
        },
      ],
    });

    expect(result.error).toMatch(
      /^供应商请求处理失败，请联系管理员（请求标识：apiu_[a-f0-9]{32}）$/
    );
    expect(mocks.fetchMediaUpstream).not.toHaveBeenCalled();
  });
});
