/**
 * API 上游真实请求快照脱敏测试。
 *
 * 覆盖签名 URL、凭据字段、data URL、长 Base64、Blob 与格式大小边界，证明管理端
 * 可看到真实字段结构，但数据库不会保存临时凭据或媒体正文。
 */

import { describe, expect, it } from "vitest";

import { createApiUpstreamRequestSnapshot } from "./api-upstream-request-snapshot";

describe("createApiUpstreamRequestSnapshot", () => {
  it("保留脚本后字段结构并脱敏签名 URL、凭据和媒体正文", () => {
    const snapshot = createApiUpstreamRequestSnapshot({
      operation: "videos.generate",
      contentType: "application/json",
      body: {
        model: "seedance-2.0",
        reference_mode: "media",
        reference_image_urls: [
          "https://oss.example.com/media/input.png?X-Amz-Signature=fake&X-Amz-Expires=3600",
        ],
        api_token: "private-token",
        inline_image: `data:image/png;base64,${"A".repeat(1_024)}`,
        encoded: "A".repeat(1_024),
      },
    });

    expect(snapshot).toEqual({
      operation: "videos.generate",
      contentType: "application/json",
      body: {
        model: "seedance-2.0",
        reference_mode: "media",
        reference_image_urls: [
          "https://oss.example.com/media/input.png?[REDACTED]",
        ],
        api_token: "[REDACTED]",
        inline_image: "data:image/png;base64,[REDACTED 1024 characters]",
        encoded: "[REDACTED BASE64 1024 characters]",
      },
    });
  });

  it("将 multipart Blob 转为可格式化的媒体描述", () => {
    const snapshot = createApiUpstreamRequestSnapshot({
      operation: "images.edit",
      contentType: "multipart/form-data",
      body: {
        prompt: "repair the image",
        image: new Blob([new Uint8Array([1, 2, 3])], {
          type: "image/png",
        }),
      },
    });

    expect(snapshot.body).toEqual({
      prompt: "repair the image",
      image: {
        type: "Blob",
        mimeType: "image/png",
        sizeBytes: 3,
        data: "[REDACTED]",
      },
    });
  });
});
