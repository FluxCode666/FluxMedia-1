/**
 * 视频具名输入持久存储测试。
 *
 * 职责：验证全部来源都会实际加载后复制、对象采用边界、共享 256 数量保护，以及
 * MIME、字节、bucket 和失败清理不会回退到客户端引用。
 */
import type { MediaInputReference } from "@repo/shared/image-generation/media-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  putObject: vi.fn(),
  deleteObject: vi.fn(),
  getStorageRuntimeSnapshot: vi.fn(),
}));
const cleanupQueue = vi.hoisted(() => ({
  enqueueVideoInputCleanup: vi.fn(),
}));
const mediaLoader = vi.hoisted(() => ({
  loadMediaInputs: vi.fn(),
  getMediaInputReferenceMaxBytes: vi.fn(() => undefined),
  getVideoReferenceMediaAddressPolicy: vi.fn(() => undefined),
}));
const mediaMetadata = vi.hoisted(() => ({
  validateReferenceAudioMetadata: vi.fn(),
  validateReferenceVideoMetadata: vi.fn(),
  assertReferenceVideoTotalDuration: vi.fn(),
}));

vi.mock("@repo/shared/storage/providers", () => ({
  getStorageRuntimeSnapshot: storage.getStorageRuntimeSnapshot,
}));

vi.mock("./video-input-cleanup-queue", () => ({
  enqueueVideoInputCleanup: cleanupQueue.enqueueVideoInputCleanup,
  parseVideoInputCleanupObjects: (value: unknown) => value,
}));

vi.mock("./media-input-loader", () => ({
  getMediaInputReferenceMaxBytes: mediaLoader.getMediaInputReferenceMaxBytes,
  getVideoReferenceMediaAddressPolicy:
    mediaLoader.getVideoReferenceMediaAddressPolicy,
  loadMediaInputs: mediaLoader.loadMediaInputs,
}));
vi.mock("./reference-media-metadata", () => ({
  validateReferenceAudioMetadata: mediaMetadata.validateReferenceAudioMetadata,
  validateReferenceVideoMetadata: mediaMetadata.validateReferenceVideoMetadata,
  assertReferenceVideoTotalDuration:
    mediaMetadata.assertReferenceVideoTotalDuration,
}));

import { createLifecycleCleanupObjects } from "./video-input-lifecycle";
import {
  cleanupUnusedStagedVideoInputs,
  stageVideoInputManifest,
  VIDEO_INPUT_UPLOAD_TIMEOUT_MS,
} from "./video-input-storage";
import { VIDEO_STAGING_RESERVATION_TTL_MS } from "./video-task-admission";

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("video-input"),
]);
const MP4_BYTES = Buffer.concat([
  Buffer.alloc(4, 0),
  Buffer.from("ftypisom"),
  Buffer.alloc(16, 0),
]);
const QUICKTIME_BYTES = Buffer.concat([
  Buffer.alloc(4, 0),
  Buffer.from("ftypqt  "),
  Buffer.alloc(16, 0),
]);
const MP3_BYTES = Buffer.from("ID3reference-audio");

/** 构造声明与实际测试字节一致的 data 引用。 */
function createDataReference(): MediaInputReference {
  return {
    source: "data",
    mimeType: "image/png",
    base64: PNG_BYTES.toString("base64"),
    byteLength: PNG_BYTES.byteLength,
  };
}

/** 为当前测试配置成功存储与按输入顺序返回的实际媒体。 */
function setupSuccessfulStorage(): void {
  storage.getStorageRuntimeSnapshot.mockResolvedValue({
    provider: {
      putObject: storage.putObject,
      deleteObject: storage.deleteObject,
    },
    bucketName: "uploads",
  });
  storage.putObject.mockResolvedValue(undefined);
  mediaLoader.loadMediaInputs.mockImplementation(
    async (input: { references: MediaInputReference[] }) =>
      input.references.map(() => ({ data: PNG_BYTES, type: "image/png" }))
  );
}

describe("video input storage", () => {
  beforeEach(() => {
    mediaMetadata.validateReferenceVideoMetadata.mockResolvedValue({
      durationSeconds: 5,
      width: 1280,
      height: 720,
      framesPerSecond: 30,
    });
    mediaMetadata.validateReferenceAudioMetadata.mockResolvedValue({
      durationSeconds: 5,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("把 data 首帧与 storage 尾帧都复制为任务隔离的具名对象", async () => {
    setupSuccessfulStorage();
    const result = await stageVideoInputManifest({
      userId: "user-1",
      videoId: "video-1",
      attemptId: "reservation-1",
      manifest: {
        firstFrame: createDataReference(),
        lastFrame: {
          source: "storage",
          mimeType: "image/png",
          storageKey: "user-1/existing.png",
          storageBucket: "uploads",
          byteLength: PNG_BYTES.byteLength,
        },
      },
    });

    expect(mediaLoader.loadMediaInputs).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        references: [
          expect.objectContaining({ source: "data" }),
          expect.objectContaining({ source: "storage" }),
        ],
      })
    );
    expect(result.manifest).toEqual({
      firstFrame: expect.objectContaining({
        source: "storage",
        storageKey: expect.stringContaining("/reservation-1/first-frame-0-"),
      }),
      lastFrame: expect.objectContaining({
        source: "storage",
        storageKey: expect.stringContaining("/reservation-1/last-frame-0-"),
      }),
    });
    expect(storage.putObject).toHaveBeenCalledTimes(2);
    expect(result.objects).toHaveLength(2);
    expect(result.objects.every((object) => object.reason === "orphan")).toBe(
      true
    );
  });

  it("把 storage 与 remote 参考图全部复制且保持顺序", async () => {
    setupSuccessfulStorage();
    const result = await stageVideoInputManifest({
      userId: "user-1",
      videoId: "video-1",
      attemptId: "reservation-1",
      manifest: {
        referenceImages: [
          {
            source: "storage",
            mimeType: "image/png",
            storageKey: "user-1/existing.png",
            storageBucket: "uploads",
            byteLength: PNG_BYTES.byteLength,
          },
          {
            source: "remote",
            mimeType: "image/png",
            url: "https://cdn.example.com/reference.png",
            byteLength: PNG_BYTES.byteLength,
          },
        ],
      },
    });

    expect(
      result.manifest.referenceImages?.map((reference) => reference.storageKey)
    ).toEqual([
      expect.stringContaining("/reference-0-"),
      expect.stringContaining("/reference-1-"),
    ]);
    expect(storage.putObject).toHaveBeenCalledTimes(2);
  });

  it.each([
    10, 20, 256,
  ])("允许 %i 张小参考图通过共享基础设施边界", async (count) => {
    setupSuccessfulStorage();

    const result = await stageVideoInputManifest({
      userId: "user-1",
      videoId: "video-1",
      attemptId: "reservation-1",
      manifest: {
        referenceImages: Array.from({ length: count }, createDataReference),
      },
    });

    expect(result.manifest.referenceImages).toHaveLength(count);
    expect(storage.putObject).toHaveBeenCalledTimes(count);
  });

  it("第 257 张在实际读取和对象写入前失败", async () => {
    setupSuccessfulStorage();

    await expect(
      stageVideoInputManifest({
        userId: "user-1",
        videoId: "video-1",
        attemptId: "reservation-1",
        manifest: {
          referenceImages: Array.from({ length: 257 }, createDataReference),
        },
      })
    ).rejects.toThrow();
    expect(mediaLoader.loadMediaInputs).not.toHaveBeenCalled();
    expect(storage.putObject).not.toHaveBeenCalled();
  });

  it("实际 MIME 与声明不一致时不写对象", async () => {
    setupSuccessfulStorage();
    const jpegBytes = Buffer.alloc(PNG_BYTES.byteLength);
    jpegBytes.set([0xff, 0xd8, 0xff]);
    mediaLoader.loadMediaInputs.mockResolvedValueOnce([
      { data: jpegBytes, type: "image/png" },
    ]);

    await expect(
      stageVideoInputManifest({
        userId: "user-1",
        videoId: "video-1",
        attemptId: "reservation-1",
        manifest: { firstFrame: createDataReference() },
      })
    ).rejects.toThrow();
    expect(storage.putObject).not.toHaveBeenCalled();
  });

  it("实际字节与声明不一致时不写对象", async () => {
    setupSuccessfulStorage();
    mediaLoader.loadMediaInputs.mockResolvedValueOnce([
      {
        data: Buffer.concat([PNG_BYTES, Buffer.from("extra")]),
        type: "image/png",
      },
    ]);

    await expect(
      stageVideoInputManifest({
        userId: "user-1",
        videoId: "video-1",
        attemptId: "reservation-1",
        manifest: { firstFrame: createDataReference() },
      })
    ).rejects.toThrow("字节数与声明不一致");
    expect(storage.putObject).not.toHaveBeenCalled();
  });

  it("参考视频和音频会在转存前执行真实元数据校验", async () => {
    setupSuccessfulStorage();
    mediaLoader.loadMediaInputs.mockImplementation(
      async (input: { references: MediaInputReference[] }) =>
        input.references.map((reference) =>
          reference.mimeType === "video/mp4"
            ? { data: MP4_BYTES, type: "video/mp4" }
            : { data: MP3_BYTES, type: "audio/mpeg" }
        )
    );
    const videoReference: MediaInputReference = {
      source: "storage",
      mimeType: "video/mp4",
      storageKey: "user-1/reference.mp4",
      storageBucket: "uploads",
      byteLength: MP4_BYTES.byteLength,
    };
    const audioReference: MediaInputReference = {
      source: "storage",
      mimeType: "audio/mpeg",
      storageKey: "user-1/reference.mp3",
      storageBucket: "uploads",
      byteLength: MP3_BYTES.byteLength,
    };

    const result = await stageVideoInputManifest({
      userId: "user-1",
      videoId: "video-1",
      attemptId: "reservation-1",
      manifest: {
        referenceVideos: [videoReference],
        referenceAudios: [audioReference],
      },
    });

    expect(mediaMetadata.validateReferenceVideoMetadata).toHaveBeenCalledWith(
      MP4_BYTES
    );
    expect(mediaMetadata.validateReferenceAudioMetadata).toHaveBeenCalledWith(
      MP3_BYTES
    );
    expect(
      mediaMetadata.assertReferenceVideoTotalDuration
    ).toHaveBeenCalledWith([expect.objectContaining({ durationSeconds: 5 })]);
    expect(result.manifest.referenceVideos).toHaveLength(1);
    expect(result.manifest.referenceAudios).toHaveLength(1);
  });

  it("允许 mp4 声明对应 QuickTime 容器的参考视频", async () => {
    setupSuccessfulStorage();
    mediaLoader.loadMediaInputs.mockResolvedValueOnce([
      { data: QUICKTIME_BYTES, type: "video/mp4" },
    ]);

    const result = await stageVideoInputManifest({
      userId: "user-1",
      videoId: "video-1",
      attemptId: "reservation-1",
      manifest: {
        referenceVideos: [
          {
            source: "storage",
            mimeType: "video/mp4",
            storageKey: "user-1/reference.mp4",
            storageBucket: "uploads",
            byteLength: QUICKTIME_BYTES.byteLength,
          },
        ],
      },
    });

    expect(result.manifest.referenceVideos).toHaveLength(1);
    expect(storage.putObject).toHaveBeenCalledWith(
      expect.any(String),
      "uploads",
      QUICKTIME_BYTES,
      "video/mp4",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("读取和全部上传共享同一个绝对 deadline", async () => {
    setupSuccessfulStorage();
    await stageVideoInputManifest({
      userId: "user-1",
      videoId: "video-1",
      attemptId: "reservation-1",
      manifest: { firstFrame: createDataReference() },
    });

    const loadSignal = mediaLoader.loadMediaInputs.mock.calls[0]?.[0]?.signal;
    const uploadSignal = storage.putObject.mock.calls[0]?.[4]?.signal;
    expect(loadSignal).toBeInstanceOf(AbortSignal);
    expect(uploadSignal).toBe(loadSignal);
    expect(VIDEO_INPUT_UPLOAD_TIMEOUT_MS).toBeLessThan(
      VIDEO_STAGING_RESERVATION_TTL_MS
    );
  });

  it("持久任务采用同一清单时竞争失败请求不会误删", async () => {
    setupSuccessfulStorage();
    const staged = await stageVideoInputManifest({
      userId: "user-1",
      videoId: "video-1",
      attemptId: "reservation-1",
      manifest: { firstFrame: createDataReference() },
    });

    await cleanupUnusedStagedVideoInputs({
      objects: staged.objects,
      persistedManifest: staged.manifest,
    });

    expect(storage.deleteObject).not.toHaveBeenCalled();
  });

  it("只从任务白名单清单派生 lifecycle_delete 身份", async () => {
    setupSuccessfulStorage();
    const staged = await stageVideoInputManifest({
      userId: "user-1",
      videoId: "video-1",
      attemptId: "reservation-1",
      manifest: { firstFrame: createDataReference() },
    });

    expect(
      createLifecycleCleanupObjects({
        userId: "user-1",
        videoId: "video-1",
        manifest: staged.manifest,
      })
    ).toEqual([
      expect.objectContaining({
        reason: "lifecycle_delete",
        attemptId: "reservation-1",
      }),
    ]);
  });
});
