/**
 * 视频任务输入准备顺序的 DB-free 单测。
 *
 * 职责：证明容量拒绝或幂等命中时不会触发对象存储写入，预检通过后才允许转存。
 */
import { describe, expect, it, vi } from "vitest";

import { VideoActiveTaskLimitError } from "./video-task-admission";
import { prepareVideoTaskInputReferences } from "./video-task-preparation";

const DATA_REFERENCE = {
  source: "data" as const,
  mimeType: "image/png" as const,
  base64: Buffer.from("video-input").toString("base64"),
  byteLength: Buffer.byteLength("video-input"),
};
const MEDIA_LIMITS = {
  maxFileSizeMb: 5,
  maxUploadSizeMb: 75,
  maxEditReferenceImages: 16,
  maxFileSizeBytes: 5 * 1024 * 1024,
  maxUploadSizeBytes: 75 * 1024 * 1024,
};

const INPUT = {
  taskId: "video-1",
  userId: "user-1",
  principalScope: "external:user-1:key-1",
  manifest: { firstFrame: DATA_REFERENCE },
  mediaLimits: MEDIA_LIMITS,
};

const STAGED_MANIFEST = {
  firstFrame: {
    source: "storage" as const,
    mimeType: "image/png" as const,
    storageKey: "user-1/video-inputs/video-1/reservation-1/first-frame.png",
    storageBucket: "uploads",
    byteLength: DATA_REFERENCE.byteLength,
  },
};

describe("video task input preparation", () => {
  it("容量预检前应用系统媒体大小策略", async () => {
    const preflight = vi.fn(async () => ({
      status: "reserved" as const,
      reservationToken: "reservation-1",
    }));
    const stage = vi.fn(async () => ({ manifest: {}, objects: [] }));

    await expect(
      prepareVideoTaskInputReferences(
        {
          ...INPUT,
          manifest: {
            firstFrame: {
              source: "storage",
              mimeType: "image/png",
              storageKey: "user-1/video-inputs/oversized.png",
              storageBucket: "uploads",
              byteLength: 2 * 1024 * 1024,
            },
          },
          mediaLimits: {
            maxFileSizeMb: 1,
            maxUploadSizeMb: 20,
            maxEditReferenceImages: 16,
            maxFileSizeBytes: 1024 * 1024,
            maxUploadSizeBytes: 20 * 1024 * 1024,
          },
        },
        {
          preflight,
          stage,
          release: vi.fn(async () => true),
        }
      )
    ).rejects.toMatchObject({ name: "MediaInputPolicyValidationError" });
    expect(preflight).not.toHaveBeenCalled();
    expect(stage).not.toHaveBeenCalled();
  });

  it("用户容量已满时不调用对象存储 putObject", async () => {
    const putObject = vi.fn();
    const release = vi.fn(async () => true);

    await expect(
      prepareVideoTaskInputReferences(INPUT, {
        preflight: async () => {
          throw new VideoActiveTaskLimitError("user", 10);
        },
        stage: async () => {
          await putObject();
          return { manifest: {}, objects: [] };
        },
        release,
      })
    ).rejects.toBeInstanceOf(VideoActiveTaskLimitError);
    expect(putObject).not.toHaveBeenCalled();
  });

  it("并发幂等任务已存在时也不重复转存", async () => {
    const stage = vi.fn();
    const release = vi.fn(async () => true);

    await expect(
      prepareVideoTaskInputReferences(INPUT, {
        preflight: async () => ({ status: "existing" }),
        stage,
        release,
      })
    ).resolves.toEqual({ admission: "existing", stagedInput: null });
    expect(stage).not.toHaveBeenCalled();
  });

  it("预检通过后才执行一次转存", async () => {
    const stage = vi.fn(async () => ({
      manifest: STAGED_MANIFEST,
      objects: [],
    }));
    const release = vi.fn(async () => true);

    await expect(
      prepareVideoTaskInputReferences(INPUT, {
        preflight: async () => ({
          status: "reserved",
          reservationToken: "reservation-1",
        }),
        stage,
        release,
      })
    ).resolves.toMatchObject({
      admission: "admitted",
      reservationToken: "reservation-1",
    });
    expect(stage).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
  });

  it("允许 HTTP 参考视频通过容量预检", async () => {
    const stage = vi.fn(async () => ({
      manifest: {},
      objects: [],
    }));

    await expect(
      prepareVideoTaskInputReferences(
        {
          ...INPUT,
          manifest: {
            referenceVideos: [
              {
                source: "remote",
                mimeType: "video/mp4",
                url: "http://cdn.example.com/reference.mp4",
              },
            ],
          },
        },
        {
          preflight: async () => ({
            status: "reserved" as const,
            reservationToken: "reservation-1",
          }),
          stage,
          release: vi.fn(async () => true),
        }
      )
    ).resolves.toMatchObject({ admission: "admitted" });
    expect(stage).toHaveBeenCalledTimes(1);
  });

  it("转存失败时按 token 释放 staging reservation", async () => {
    const release = vi.fn(async () => true);

    await expect(
      prepareVideoTaskInputReferences(INPUT, {
        preflight: async () => ({
          status: "reserved",
          reservationToken: "reservation-1",
        }),
        stage: async () => {
          throw new Error("storage offline");
        },
        release,
      })
    ).rejects.toThrow("storage offline");
    expect(release).toHaveBeenCalledWith({
      taskId: "video-1",
      userId: "user-1",
      reservationToken: "reservation-1",
    });
  });
});
