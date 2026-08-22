/**
 * JSON-safe 媒体引用契约测试。
 *
 * 职责：验证 data、storage、remote 三种跨传输媒体 DTO，以及 MIME、单项和总字节
 * 边界；真实远程下载仍需在 operation 执行时经过 SSRF 与内容复验。
 */
import { describe, expect, it } from "vitest";

import {
  MAX_MEDIA_INPUT_BYTES,
  MAX_MEDIA_INPUT_FILE_BYTES,
  mediaInputReferenceSchema,
  mediaInputReferencesSchema,
  parseMediaInputReferencesWithPolicy,
  videoInputManifestSchema,
  videoInputReferenceManifestSchema,
} from "./media-contract";

describe("media input reference contract", () => {
  it.each([
    {
      source: "data",
      mimeType: "image/png",
      base64: "aW1hZ2U=",
      byteLength: 5,
    },
    {
      source: "storage",
      mimeType: "image/jpeg",
      storageKey: "users/u1/input.jpg",
      storageBucket: "generations",
      byteLength: 128,
    },
    {
      source: "remote",
      mimeType: "image/webp",
      url: "https://cdn.example.com/input.webp",
      byteLength: 256,
    },
  ])("accepts $source media reference", (input) => {
    expect(mediaInputReferenceSchema.safeParse(input).success).toBe(true);
  });

  it("rejects invalid MIME, unsafe URL and unknown fields", () => {
    expect(
      mediaInputReferenceSchema.safeParse({
        source: "data",
        mimeType: "text/html",
        base64: "PGh0bWw+",
        byteLength: 6,
      }).success
    ).toBe(false);
    expect(
      mediaInputReferenceSchema.safeParse({
        source: "remote",
        mimeType: "image/png",
        url: "http://127.0.0.1/input.png",
        byteLength: 10,
      }).success
    ).toBe(false);
    expect(
      mediaInputReferenceSchema.safeParse({
        source: "storage",
        mimeType: "image/png",
        storageKey: "users/u1/input.png",
        byteLength: 10,
        authorization: "secret",
      }).success
    ).toBe(false);
  });

  it("拒绝不一致的 base64 字节声明", () => {
    expect(
      mediaInputReferenceSchema.safeParse({
        source: "data",
        mimeType: "image/png",
        base64: "aW1hZ2U=",
        byteLength: 100,
      }).success
    ).toBe(false);
  });

  it("单文件保持 200 MiB，单次请求允许到 512 MiB", () => {
    const storageReference = (index: number, byteLength: number) => ({
      source: "storage" as const,
      mimeType: "image/png" as const,
      storageKey: `users/u1/${index}.png`,
      byteLength,
    });
    const remainingAtTotalLimit =
      MAX_MEDIA_INPUT_BYTES - MAX_MEDIA_INPUT_FILE_BYTES * 2;
    const atTotalLimit = [
      storageReference(1, MAX_MEDIA_INPUT_FILE_BYTES),
      storageReference(2, MAX_MEDIA_INPUT_FILE_BYTES),
      storageReference(3, remainingAtTotalLimit),
    ];

    expect(MAX_MEDIA_INPUT_FILE_BYTES).toBe(200 * 1024 * 1024);
    expect(MAX_MEDIA_INPUT_BYTES).toBe(512 * 1024 * 1024);
    expect(
      mediaInputReferenceSchema.safeParse(
        storageReference(0, MAX_MEDIA_INPUT_FILE_BYTES)
      ).success
    ).toBe(true);
    expect(
      mediaInputReferenceSchema.safeParse(
        storageReference(0, MAX_MEDIA_INPUT_FILE_BYTES + 1)
      ).success
    ).toBe(false);
    expect(mediaInputReferencesSchema.safeParse(atTotalLimit).success).toBe(
      true
    );
    expect(
      mediaInputReferencesSchema.safeParse([
        ...atTotalLimit.slice(0, -1),
        storageReference(3, remainingAtTotalLimit + 1),
      ]).success
    ).toBe(false);
  });

  it("校验大体积 base64 时不会耗尽正则调用栈", () => {
    const base64 = "A".repeat(5_000_000);
    const input = {
      source: "data",
      mimeType: "image/png",
      base64,
      byteLength: 3_750_000,
    };

    expect(mediaInputReferenceSchema.safeParse(input).success).toBe(true);
    expect(
      mediaInputReferenceSchema.safeParse({
        ...input,
        base64: `${base64.slice(0, -1)}!`,
      }).success
    ).toBe(false);
  });

  it("具名任务输入清单只接受 storage 并保持首尾帧与参考图互斥", () => {
    const storage = {
      source: "storage" as const,
      mimeType: "image/png" as const,
      storageKey: "user-1/video-inputs/video-1/attempt-1/input.png",
      storageBucket: "uploads",
      byteLength: 12,
    };
    expect(
      videoInputManifestSchema.safeParse({
        firstFrame: storage,
        lastFrame: { ...storage, storageKey: `${storage.storageKey}.last` },
      }).success
    ).toBe(true);
    expect(
      videoInputManifestSchema.safeParse({
        firstFrame: storage,
        referenceImages: [storage],
      }).success
    ).toBe(false);
    expect(
      videoInputManifestSchema.safeParse({
        firstFrame: storage,
        referenceVideos: [
          {
            ...storage,
            mimeType: "video/mp4",
            storageKey: `${storage.storageKey}.mp4`,
          },
        ],
      }).success
    ).toBe(false);
    expect(
      videoInputManifestSchema.safeParse({
        firstFrame: storage,
        referenceAudios: [
          {
            ...storage,
            mimeType: "audio/mpeg",
            storageKey: `${storage.storageKey}.mp3`,
          },
        ],
      }).success
    ).toBe(false);
    expect(
      videoInputManifestSchema.safeParse({
        firstFrame: {
          source: "remote",
          mimeType: "image/png",
          url: "https://cdn.example.com/input.png",
          byteLength: 12,
        },
      }).success
    ).toBe(false);
  });

  it("任务创建前具名清单仍允许 data、storage 与 remote 来源", () => {
    expect(
      videoInputReferenceManifestSchema.safeParse({
        referenceImages: [
          {
            source: "data",
            mimeType: "image/png",
            base64: "aW1hZ2U=",
            byteLength: 5,
          },
          {
            source: "remote",
            mimeType: "image/png",
            url: "https://cdn.example.com/input.png",
            byteLength: 12,
          },
        ],
      }).success
    ).toBe(true);
  });

  it("按具名语义限制图片、视频和音频 MIME", () => {
    const remoteVideo = {
      source: "remote" as const,
      mimeType: "video/mp4" as const,
      url: "https://cdn.example.com/reference.mp4",
    };
    const remoteAudio = {
      source: "remote" as const,
      mimeType: "audio/mpeg" as const,
      url: "https://cdn.example.com/reference.mp3",
    };
    expect(
      videoInputReferenceManifestSchema.safeParse({
        firstFrame: remoteVideo,
      }).success
    ).toBe(false);
    expect(
      videoInputReferenceManifestSchema.safeParse({
        referenceVideos: [remoteVideo],
        referenceAudios: [remoteAudio],
      }).success
    ).toBe(true);
  });

  it("使用运行时策略统一拒绝单文件、总量和编辑参考图超限", () => {
    const policy = {
      maxFileSizeMb: 5,
      maxUploadSizeMb: 8,
      maxFileSizeBytes: 5 * 1024 * 1024,
      maxUploadSizeBytes: 8 * 1024 * 1024,
      maxEditReferenceImages: 2,
    };
    const reference = (index: number, byteLength: number) => ({
      source: "storage" as const,
      mimeType: "image/png" as const,
      storageKey: `users/u1/${index}.png`,
      byteLength,
    });

    expect(
      parseMediaInputReferencesWithPolicy(
        [reference(1, 4 * 1024 * 1024), reference(2, 4 * 1024 * 1024)],
        policy
      )
    ).toHaveLength(2);
    expect(() =>
      parseMediaInputReferencesWithPolicy(
        [reference(1, 5 * 1024 * 1024 + 1)],
        policy
      )
    ).toThrow();
    expect(() =>
      parseMediaInputReferencesWithPolicy(
        [reference(1, 4 * 1024 * 1024), reference(2, 4 * 1024 * 1024 + 1)],
        policy
      )
    ).toThrow();
    expect(() =>
      parseMediaInputReferencesWithPolicy(
        [reference(1, 1), reference(2, 1), reference(3, 1)],
        policy
      )
    ).toThrow();
  });
});
