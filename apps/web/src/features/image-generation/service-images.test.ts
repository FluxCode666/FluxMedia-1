/**
 * Images API 生成、编辑与 SSE 解析回归测试。
 *
 * 使用方：Vitest；仅覆盖保留的图片运行时，不访问数据库或真实上游。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

/** 构造一段符合 Images API 约定的 SSE 事件。 */
function sseBlock(event: string, data: Record<string, unknown>) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** 为动态导入 service.ts 准备 DB-free 测试所需的惰性环境占位。 */
function prepareTestEnvironment() {
  process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";
}

describe("Images API service", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("解析 content-type 错误的 Images SSE 响应", async () => {
    prepareTestEnvironment();
    const { generateImage } = await import("./service");
    const imageBase64 = Buffer.from("image-result").toString("base64");
    const fetchMock = vi.fn(
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
    vi.stubGlobal("fetch", fetchMock);

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
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
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
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                message: "The quota has been exceeded.",
                code: "quota_exceeded",
              },
            }),
            { status: 200, headers: { "Content-Type": "text/event-stream" } }
          )
      )
    );

    const result = await generateImage(
      { baseUrl: "https://api.example.test/v1", apiKey: "test-key" },
      { prompt: "make an icon", model: "gpt-image-2" }
    );

    expect(result.error).toContain("The quota has been exceeded.");
    expect(result.error).toContain("quota_exceeded");
  });

  it("通过 multipart Images API 发送输入图、蒙版和安全引用标签", async () => {
    prepareTestEnvironment();
    const { editImage } = await import("./service");
    const imageBase64 = Buffer.from("edited-image").toString("base64");
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const formData = init?.body;
      expect(formData).toBeInstanceOf(FormData);
      if (!(formData instanceof FormData)) throw new Error("missing FormData");
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
    });
    vi.stubGlobal("fetch", fetchMock);

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
});
