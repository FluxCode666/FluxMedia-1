/**
 * Images API 生成、编辑与 SSE 解析回归测试。
 *
 * 使用方：Vitest；仅覆盖保留的图片运行时，不访问数据库或真实上游。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiConfig } from "./types";

const mocks = vi.hoisted(() => ({
  fetchMediaUpstream: vi.fn(),
  fetchMediaUpstreamDownload: vi.fn(),
}));

vi.mock("@/features/image-backend-pool/media-upstream-fetch", () => ({
  fetchMediaUpstream: mocks.fetchMediaUpstream,
  fetchMediaUpstreamDownload: mocks.fetchMediaUpstreamDownload,
}));

/** 构造一段符合 Images API 约定的 SSE 事件。 */
function sseBlock(event: string, data: Record<string, unknown>) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** 为动态导入 service.ts 准备 DB-free 测试所需的惰性环境占位。 */
function prepareTestEnvironment() {
  process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";
}

/** 构造启用模型映射和隔离请求脚本的 API 池账号。 */
function createPoolApiConfig(requestTransformScript: string): ApiConfig {
  return {
    baseUrl: "https://api.example.test/v1",
    apiKey: "test-key",
    backend: {
      type: "pool-api",
      modelMappings: [
        { modelId: "gpt-image-2", upstreamModelId: "vendor-image-id" },
      ],
      requestTransformScript,
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

  it("生成图片时映射上游模型并执行 JSON 请求脚本", async () => {
    prepareTestEnvironment();
    const { generateImage } = await import("./service");
    mocks.fetchMediaUpstream.mockResolvedValue(successfulImageResponse());

    const result = await generateImage(
      createPoolApiConfig(`
request.vendor_size = request.size;
request.adaptation = context.platformModelId + "->" + context.upstreamModelId;
delete request.size;
return request;
`),
      { prompt: "make an icon", model: "gpt-image-2", size: "1024x1024" }
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
  });

  it("生成图片请求脚本失败时不调用上游", async () => {
    prepareTestEnvironment();
    const { generateImage } = await import("./service");

    const result = await generateImage(
      createPoolApiConfig('throw new Error("script failure");'),
      { prompt: "make an icon", model: "gpt-image-2" }
    );

    expect(result.error).toBe("API 账号请求处理脚本执行失败");
    expect(mocks.fetchMediaUpstream).not.toHaveBeenCalled();
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

    expect(result.error).toContain("API 账号请求处理脚本返回了非法");
    expect(mocks.fetchMediaUpstream).not.toHaveBeenCalled();
  });
});
