/**
 * Gemini 视频 DB-free 合约测试。
 *
 * 使用方：Vitest；验证公共请求和 Operation 输出的严格字段、时长兼容和 URL 协议边界。
 */
import { describe, expect, it } from "vitest";
import {
  geminiOperationOutputSchema,
  geminiVideoRequestSchema,
} from "./gemini-contract";

describe("Gemini video contract", () => {
  it("accepts the frozen predictLongRunning shape", () => {
    const parsed = geminiVideoRequestSchema.safeParse({
      instances: [{ prompt: "A white cat in neon Tokyo" }],
      parameters: {
        aspectRatio: "16:9",
        resolution: "720p",
        durationSeconds: "8",
      },
    });
    expect(parsed.success).toBe(true);
    expect(
      geminiVideoRequestSchema.safeParse({
        instances: [{ prompt: "test" }],
        parameters: { durationSeconds: "8" },
      }).success
    ).toBe(true);
  });

  it("accepts a large inline image without recursive regex stack overflow", () => {
    const data = Buffer.alloc(9 * 1024 * 1024, 0xab).toString("base64");
    const parsed = geminiVideoRequestSchema.safeParse({
      instances: [
        {
          prompt: "Use the reference image",
          image: { inlineData: { mimeType: "image/png", data } },
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts HTTP and HTTPS reference video and audio extensions", () => {
    expect(
      geminiVideoRequestSchema.safeParse({
        instances: [
          {
            prompt: "Replace the subject while preserving the motion",
            reference_videos: ["https://media.example/reference.mp4"],
            reference_audios: ["https://media.example/reference.wav"],
          },
        ],
      }).success
    ).toBe(true);
    expect(
      geminiVideoRequestSchema.safeParse({
        instances: [
          {
            prompt: "test",
            reference_videos: ["http://media.example/reference.mp4"],
            reference_audios: ["http://media.example/reference.mp3"],
          },
        ],
      }).success
    ).toBe(true);
    expect(
      geminiVideoRequestSchema.safeParse({
        instances: [
          {
            prompt: "test",
            reference_audios: [
              "https://media.example/reference.mp3",
              "https://media.example/second.mp3",
            ],
          },
        ],
      }).success
    ).toBe(false);
    expect(
      geminiVideoRequestSchema.safeParse({
        instances: [
          {
            prompt: "test",
            reference_videos: ["ftp://media.example/reference.mp4"],
          },
        ],
      }).success
    ).toBe(false);
  });

  it("rejects body model and unsupported fields", () => {
    expect(
      geminiVideoRequestSchema.safeParse({
        model: "veo-3.1-generate-preview",
        instances: [{ prompt: "test" }],
      }).success
    ).toBe(false);
    expect(
      geminiVideoRequestSchema.safeParse({
        instances: [{ prompt: "test" }],
        parameters: { negativePrompt: "no text" },
      }).success
    ).toBe(false);
  });

  it("enforces Operation response/error exclusivity", () => {
    const pending = geminiOperationOutputSchema.safeParse({
      name: "models/veo-3.1-generate-preview/operations/opaque-operation-1234",
      done: false,
    });
    expect(pending.success).toBe(true);
    expect(
      geminiOperationOutputSchema.safeParse({
        name: "models/veo-3.1-generate-preview/operations/opaque-operation-1234",
        done: true,
      }).success
    ).toBe(false);
  });

  it("allows HTTP and HTTPS generated video URIs", () => {
    expect(
      geminiOperationOutputSchema.safeParse({
        name: "models/veo-3.1-generate-preview/operations/opaque-operation-1234",
        done: true,
        response: {
          generateVideoResponse: {
            generatedSamples: [
              { video: { uri: "http://storage.example/video.mp4" } },
            ],
          },
        },
      }).success
    ).toBe(true);
    expect(
      geminiOperationOutputSchema.safeParse({
        name: "models/veo-3.1-generate-preview/operations/opaque-operation-1234",
        done: true,
        response: {
          generateVideoResponse: {
            generatedSamples: [
              { video: { uri: "ftp://storage.example/video.mp4" } },
            ],
          },
        },
      }).success
    ).toBe(false);
  });
});
