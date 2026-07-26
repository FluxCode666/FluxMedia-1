/**
 * 有界 multipart 正文读取测试。
 *
 * 使用方是模型配置管理 Route；测试锁定声明长度预检、真实流累计上限、取消读取和平台
 * FormData 解析边界，避免伪造 Content-Length 绕过内存保护。
 */
import { describe, expect, it, vi } from "vitest";

import {
  type BoundedMultipartError,
  MAX_MODEL_CONFIGURATION_MULTIPART_BYTES,
  parseBoundedContentLength,
  parseBoundedMultipartFormData,
  readBoundedRequestBody,
} from "./bounded-multipart";

/** 为测试构造可观察取消行为的分块请求正文。 */
function createStreamRequest(
  chunks: readonly Uint8Array[],
  options: {
    contentLength?: string;
    contentType?: string;
    onCancel?: () => void;
    onPull?: () => void;
  } = {}
): Request {
  let index = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        options.onPull?.();
        const chunk = chunks[index];
        index += 1;
        if (chunk) {
          controller.enqueue(chunk);
          return;
        }
        controller.close();
      },
      cancel() {
        options.onCancel?.();
      },
    },
    { highWaterMark: 0 }
  );
  const headers = new Headers();
  if (options.contentLength !== undefined) {
    headers.set("content-length", options.contentLength);
  }
  if (options.contentType !== undefined) {
    headers.set("content-type", options.contentType);
  }
  return new Request("https://app.example.com/api/admin/model-configuration", {
    method: "POST",
    headers,
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

/** 断言异步调用以指定的有界正文错误码失败。 */
async function expectBoundedError(
  promise: Promise<unknown>,
  code: BoundedMultipartError["code"]
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: "BoundedMultipartError",
    code,
  });
}

describe("parseBoundedContentLength", () => {
  it("接受合法长度并允许缺失长度继续流式检查", () => {
    expect(parseBoundedContentLength("42")).toBe(42);
    expect(parseBoundedContentLength("00042")).toBe(42);
    expect(parseBoundedContentLength(null)).toBeNull();
  });

  it.each([
    "",
    "-1",
    "1.5",
    "NaN",
    "Infinity",
    "12x",
    "+12",
  ])("拒绝非法 Content-Length：%s", (value) => {
    expect(() => parseBoundedContentLength(value)).toThrowError(
      expect.objectContaining({ code: "invalid_content_length" })
    );
  });

  it("拒绝超过 6 MiB 的声明长度", () => {
    expect(() =>
      parseBoundedContentLength(
        String(MAX_MODEL_CONFIGURATION_MULTIPART_BYTES + 1)
      )
    ).toThrowError(expect.objectContaining({ code: "body_too_large" }));
  });
});

describe("readBoundedRequestBody", () => {
  it("在声明超限时不读取正文流", async () => {
    const onPull = vi.fn();
    const request = createStreamRequest([new Uint8Array([1])], {
      contentLength: String(MAX_MODEL_CONFIGURATION_MULTIPART_BYTES + 1),
      onPull,
    });

    await expectBoundedError(readBoundedRequestBody(request), "body_too_large");

    expect(onPull).not.toHaveBeenCalled();
  });

  it("正确拼接多个 chunk", async () => {
    const request = createStreamRequest([
      new Uint8Array([1, 2]),
      new Uint8Array([3]),
      new Uint8Array([4, 5]),
    ]);

    await expect(readBoundedRequestBody(request)).resolves.toEqual(
      new Uint8Array([1, 2, 3, 4, 5])
    );
  });

  it("接受刚好 6 MiB 的真实正文", async () => {
    const request = createStreamRequest([
      new Uint8Array(MAX_MODEL_CONFIGURATION_MULTIPART_BYTES),
    ]);

    const body = await readBoundedRequestBody(request);

    expect(body.byteLength).toBe(MAX_MODEL_CONFIGURATION_MULTIPART_BYTES);
  });

  it("真实正文超出 1 字节时立即取消 reader", async () => {
    const onCancel = vi.fn();
    const request = createStreamRequest(
      [
        new Uint8Array(MAX_MODEL_CONFIGURATION_MULTIPART_BYTES),
        new Uint8Array([1]),
      ],
      { onCancel }
    );

    await expectBoundedError(readBoundedRequestBody(request), "body_too_large");

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("伪造偏小的声明长度仍由真实流上限拦截", async () => {
    const onCancel = vi.fn();
    const request = createStreamRequest(
      [new Uint8Array(MAX_MODEL_CONFIGURATION_MULTIPART_BYTES + 1)],
      { contentLength: "1", onCancel }
    );

    await expectBoundedError(readBoundedRequestBody(request), "body_too_large");

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("缺失正文时显式失败", async () => {
    const request = new Request(
      "https://app.example.com/api/admin/model-configuration",
      { method: "POST" }
    );

    await expectBoundedError(readBoundedRequestBody(request), "missing_body");
  });
});

describe("parseBoundedMultipartFormData", () => {
  it("只把有界字节交给平台 FormData 解析器", async () => {
    const source = new FormData();
    source.append("category", "video");
    source.append("configKey", "veo31");
    const request = new Request(
      "https://app.example.com/api/admin/model-configuration",
      { method: "POST", body: source }
    );

    const parsed = await parseBoundedMultipartFormData(request);

    expect(parsed.get("category")).toBe("video");
    expect(parsed.get("configKey")).toBe("veo31");
  });

  it("畸形 multipart 返回明确错误而不透传平台异常", async () => {
    const request = createStreamRequest([new TextEncoder().encode("broken")], {
      contentType: "multipart/form-data; boundary=missing-boundary",
    });

    await expectBoundedError(
      parseBoundedMultipartFormData(request),
      "invalid_multipart"
    );
  });
});
