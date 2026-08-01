/**
 * API 上游脚本契约测试。
 *
 * 职责：锁定六个供应商适配操作、请求信封、响应结果及资源边界，确保管理测试
 * 与生产执行器共享同一套失败关闭规则。
 */
import { describe, expect, it } from "vitest";

import {
  API_UPSTREAM_ADAPTER_OPERATION_IDS,
  API_UPSTREAM_MAX_QUERY_VALUES,
  apiUpstreamRequestEnvelopeSchema,
  apiUpstreamRequestInputSchema,
  apiUpstreamResponseInputSchema,
  apiUpstreamResponseResultForOperationSchema,
  parseApiUpstreamRequestEnvelope,
} from "./api-upstream-script-contract";

describe("API upstream script contract", () => {
  it("固定且仅接受六个供应商适配操作 ID", () => {
    expect(API_UPSTREAM_ADAPTER_OPERATION_IDS).toEqual([
      "images.generate",
      "images.generate.query",
      "images.edit",
      "images.edit.query",
      "videos.generate",
      "videos.query",
    ]);
  });

  it("请求信封允许省略未修改部分并拒绝 GET body", () => {
    expect(
      apiUpstreamRequestEnvelopeSchema.safeParse({ query: {} }).success
    ).toBe(true);
    expect(
      parseApiUpstreamRequestEnvelope("videos.generate", { body: {} })
    ).toEqual({ body: {} });
    expect(() =>
      parseApiUpstreamRequestEnvelope("videos.query", { body: {} })
    ).toThrow();
  });

  it("请求与响应测试输入使用和生产运行时相同的严格形状", () => {
    expect(
      apiUpstreamRequestInputSchema.safeParse({
        query: {},
        body: { model: "gpt-image-2" },
      }).success
    ).toBe(true);
    expect(
      apiUpstreamRequestInputSchema.safeParse({
        model: "gpt-image-2",
      }).success
    ).toBe(false);
    expect(
      apiUpstreamResponseInputSchema.safeParse({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: { status: "processing" },
      }).success
    ).toBe(true);
    expect(
      apiUpstreamResponseInputSchema.safeParse({
        statusCode: 200,
        headers: { authorization: "secret" },
        body: {},
      }).success
    ).toBe(false);
  });

  it("Query 接受标量、保序数组和 null 删除，并限制参数值总数", () => {
    expect(
      apiUpstreamRequestEnvelopeSchema.safeParse({
        query: {
          version: "2026-08",
          page: 2,
          enabled: true,
          tags: ["first", "second"],
          inherited: null,
        },
      }).success
    ).toBe(true);
    expect(
      apiUpstreamRequestEnvelopeSchema.safeParse({
        query: {
          tags: Array.from(
            { length: API_UPSTREAM_MAX_QUERY_VALUES + 1 },
            (_, index) => String(index)
          ),
        },
      }).success
    ).toBe(false);
    expect(
      apiUpstreamRequestEnvelopeSchema.safeParse({
        query: { nested: { illegal: true } },
      }).success
    ).toBe(false);
  });

  it.each([
    "Authorization",
    "Cookie",
    "Host",
    "Content-Type",
    "Content-Length",
    "Connection",
    "Proxy-Authorization",
    "X-Forwarded-For",
    "Origin",
    "X-FluxMedia-Internal",
  ])("拒绝脚本覆盖系统或敏感 Header %s", (headerName) => {
    expect(
      apiUpstreamRequestEnvelopeSchema.safeParse({
        headers: { [headerName]: "unsafe" },
      }).success
    ).toBe(false);
  });

  it("拒绝非法 Header 名、换行值及危险 JSON 键", () => {
    expect(
      apiUpstreamRequestEnvelopeSchema.safeParse({
        headers: { "not a header": "value" },
      }).success
    ).toBe(false);
    expect(
      apiUpstreamRequestEnvelopeSchema.safeParse({
        headers: { "X-Trace": "safe\r\ninjected: value" },
      }).success
    ).toBe(false);
    expect(
      apiUpstreamRequestEnvelopeSchema.safeParse({
        body: JSON.parse('{"__proto__":{"polluted":true}}'),
      }).success
    ).toBe(false);
  });

  it("生成非终态要求 taskId，查询可继承上下文任务 ID", () => {
    const generateSchema =
      apiUpstreamResponseResultForOperationSchema("images.generate");
    const querySchema = apiUpstreamResponseResultForOperationSchema(
      "images.generate.query"
    );

    expect(generateSchema.safeParse({ status: "processing" }).success).toBe(
      false
    );
    expect(
      generateSchema.safeParse({ status: "processing", taskId: "task-a" })
        .success
    ).toBe(true);
    expect(querySchema.safeParse({ status: "pending" }).success).toBe(true);
  });

  it("轮询间隔只允许非终态的 1 到 300 整数", () => {
    const schema =
      apiUpstreamResponseResultForOperationSchema("videos.generate");
    for (const pollAfterSeconds of [1, 300]) {
      expect(
        schema.safeParse({
          status: "processing",
          taskId: "task-a",
          pollAfterSeconds,
        }).success
      ).toBe(true);
    }
    for (const pollAfterSeconds of [0, 1.5, 301]) {
      expect(
        schema.safeParse({
          status: "processing",
          taskId: "task-a",
          pollAfterSeconds,
        }).success
      ).toBe(false);
    }
    expect(
      schema.safeParse({
        status: "completed",
        outputs: [{ kind: "video", url: "https://cdn.example.com/video.mp4" }],
        pollAfterSeconds: 5,
      }).success
    ).toBe(false);
  });

  it("图片允许多 URL 或 Base64 输出，视频只允许 URL", () => {
    const imageSchema =
      apiUpstreamResponseResultForOperationSchema("images.generate");
    const videoSchema =
      apiUpstreamResponseResultForOperationSchema("videos.generate");
    const imageResult = {
      status: "completed",
      outputs: [
        { kind: "image", url: "https://cdn.example.com/a.png" },
        {
          kind: "image",
          base64: "opaque:image-output:1",
          mediaType: "image/png",
        },
      ],
    };

    expect(imageSchema.safeParse(imageResult).success).toBe(true);
    expect(videoSchema.safeParse(imageResult).success).toBe(false);
    expect(
      videoSchema.safeParse({
        status: "completed",
        outputs: [{ kind: "video", base64: "not-supported" }],
      }).success
    ).toBe(false);
  });

  it("标准媒体输出只允许绝对 HTTP(S) URL", () => {
    expect(
      apiUpstreamResponseResultForOperationSchema("images.generate").safeParse({
        status: "completed",
        outputs: [{ kind: "image", url: "ftp://cdn.example.com/image.png" }],
      }).success
    ).toBe(false);
    expect(
      apiUpstreamResponseResultForOperationSchema("videos.query").safeParse({
        status: "completed",
        outputs: [{ kind: "video", url: "data:video/mp4;base64,AAAA" }],
      }).success
    ).toBe(false);
  });

  it("失败结果要求稳定分类和错误码且 retryable 默认为 false", () => {
    const schema =
      apiUpstreamResponseResultForOperationSchema("videos.generate");
    const parsed = schema.parse({
      status: "failed",
      error: { category: "rate_limit", code: "vendor_rate_limited" },
    });

    expect(parsed).toMatchObject({ status: "failed", retryable: false });
    expect(
      schema.safeParse({
        status: "failed",
        error: { category: "unknown-vendor-value", code: "unstable code" },
      }).success
    ).toBe(false);
  });
});
