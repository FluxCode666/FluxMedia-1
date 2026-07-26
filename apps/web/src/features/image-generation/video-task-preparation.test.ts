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

const INPUT = {
  taskId: "video-1",
  userId: "user-1",
  principalScope: "external:user-1:key-1",
  references: [DATA_REFERENCE],
};

describe("video task input preparation", () => {
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
          return { references: [], objects: [] };
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
      references: [DATA_REFERENCE],
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
