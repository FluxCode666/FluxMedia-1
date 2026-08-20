/**
 * Gemini 视频适配器契约测试。
 *
 * 覆盖官方请求嵌套、媒体边界、Operation 成功/失败投影和不安全 URI 拒绝；不发起网络
 * 请求，确保协议解析可在 DB-free 环境验证。
 */
import { describe, expect, it } from "vitest";

import {
  buildGeminiVideoRequest,
  parseGeminiVideoPollResult,
  parseGeminiVideoSubmission,
} from "./gemini-video";

const image = {
  bytesBase64Encoded: "aGVsbG8=",
  mimeType: "image/png",
};

describe("Gemini video adapter", () => {
  it("builds the official instances and parameters body", () => {
    const request = buildGeminiVideoRequest({
      model: "veo-3.1-generate-preview",
      prompt: "A lighthouse at sunset",
      duration: 8,
      aspectRatio: "16:9",
      resolution: "1080p",
      firstFrame: image,
      lastFrame: image,
    });

    expect(request.path).toBe(
      "/v1beta/models/veo-3.1-generate-preview:predictLongRunning"
    );
    expect(request.body).toEqual({
      instances: [
        {
          prompt: "A lighthouse at sunset",
          image,
          lastFrame: image,
        },
      ],
      parameters: {
        aspectRatio: "16:9",
        resolution: "1080p",
        durationSeconds: 8,
      },
    });
  });

  it("uses bounded reference images and rejects unsupported fields", () => {
    const request = buildGeminiVideoRequest({
      model: "veo-3.1-generate-preview",
      prompt: "A moving train",
      duration: 6,
      aspectRatio: "16:9",
      resolution: "720p",
      referenceImages: [image, image, image],
    });
    expect(request.body.instances[0].referenceImages).toHaveLength(3);
    expect(() =>
      buildGeminiVideoRequest({
        model: "veo-3.1-generate-preview",
        prompt: "A moving train",
        duration: 8,
        aspectRatio: "16:9",
        resolution: "720p",
        firstFrame: image,
        referenceImages: [image],
      })
    ).toThrow("mutually exclusive");
    expect(() =>
      buildGeminiVideoRequest({
        model: "veo-3.1-generate-preview",
        prompt: "A moving train",
        duration: 5,
        aspectRatio: "16:9",
        resolution: "720p",
      })
    ).toThrow("4, 6, or 8");
  });

  it("accepts only a complete upstream Operation name", () => {
    expect(
      parseGeminiVideoSubmission({
        name: "models/veo-3.1-generate-preview/operations/op-123",
      })
    ).toMatchObject({
      status: "pending",
      upstreamOperationName:
        "models/veo-3.1-generate-preview/operations/op-123",
    });
    expect(() =>
      parseGeminiVideoSubmission({
        name: "https://example.com/models/veo/operations/op-123",
      })
    ).toThrow();
  });

  it("parses pending, official success and Google Status failure", () => {
    expect(parseGeminiVideoPollResult({ done: false })).toEqual({
      status: "pending",
      raw: { done: false },
    });
    expect(
      parseGeminiVideoPollResult({
        done: true,
        response: {
          generateVideoResponse: {
            generatedSamples: [
              { video: { uri: "https://storage.example/video.mp4" } },
            ],
          },
        },
      })
    ).toMatchObject({
      status: "completed",
      videoUrl: "https://storage.example/video.mp4",
    });
    expect(
      parseGeminiVideoPollResult({
        done: true,
        error: { code: 7, message: "permission denied" },
      })
    ).toMatchObject({
      status: "failed",
      error: { code: 7, message: "permission denied" },
    });
    expect(() =>
      parseGeminiVideoPollResult({
        done: true,
        response: {
          generateVideoResponse: {
            generatedSamples: [{ video: { uri: "http://insecure/video.mp4" } }],
          },
        },
      })
    ).toThrow("HTTPS");
  });
});

