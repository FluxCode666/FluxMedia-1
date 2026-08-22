/**
 * 参考媒体元数据校验测试。
 *
 * 使用方：Vitest；模拟 ffprobe 的 JSON 输出，覆盖视频尺寸、帧率、时长和音频时长
 * 边界，不依赖开发机是否安装媒体工具。
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

const childProcess = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: childProcess.spawn,
}));

import {
  assertReferenceVideoTotalDuration,
  validateReferenceAudioMetadata,
  validateReferenceVideoMetadata,
} from "./reference-media-metadata";

type EventCallback = (...args: unknown[]) => void;

/** 模拟一个在 stdin 写入后返回固定 JSON 的 ffprobe 子进程。 */
function mockProbeOutput(output: unknown, exitCode = 0): void {
  childProcess.spawn.mockImplementationOnce(() => {
    const listeners = new Map<string, EventCallback>();
    const child = {
      stdin: {
        on: vi.fn(),
        end: vi.fn(() => {
          listeners.get("data")?.(Buffer.from(JSON.stringify(output)));
          listeners.get("close")?.(exitCode);
        }),
      },
      stdout: {
        on: vi.fn((event: string, callback: EventCallback) => {
          if (event === "data") listeners.set("data", callback);
        }),
      },
      stderr: {
        on: vi.fn(),
      },
      on: vi.fn((event: string, callback: EventCallback) => {
        listeners.set(event, callback);
      }),
      kill: vi.fn(),
    };
    return child as unknown as ChildProcessWithoutNullStreams;
  });
}

describe("reference media metadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("接受规格内的视频元数据", async () => {
    mockProbeOutput({
      streams: [
        {
          width: 1280,
          height: 720,
          duration: "5.25",
          avg_frame_rate: "30/1",
        },
      ],
      format: { duration: "5.25" },
    });

    await expect(
      validateReferenceVideoMetadata(Buffer.from("video"))
    ).resolves.toMatchObject({
      durationSeconds: 5.25,
      width: 1280,
      height: 720,
      framesPerSecond: 30,
    });
  });

  it.each([
    {
      name: "时长不足",
      stream: {
        width: 1280,
        height: 720,
        duration: "3.99",
        avg_frame_rate: "30/1",
      },
      message: "4 至 10 秒",
    },
    {
      name: "尺寸不足",
      stream: {
        width: 640,
        height: 360,
        duration: "5",
        avg_frame_rate: "30/1",
      },
      message: "720 至 2160",
    },
    {
      name: "帧率超限",
      stream: {
        width: 1280,
        height: 720,
        duration: "5",
        avg_frame_rate: "120/1",
      },
      message: "24 至 60 FPS",
    },
  ])("拒绝 $name", async ({ stream, message }) => {
    mockProbeOutput({ streams: [stream] });
    await expect(
      validateReferenceVideoMetadata(Buffer.from("video"))
    ).rejects.toThrow(message);
  });

  it("拒绝超过 15 秒的音频", async () => {
    mockProbeOutput({ streams: [{ duration: "15.01" }] });
    await expect(
      validateReferenceAudioMetadata(Buffer.from("audio"))
    ).rejects.toThrow("15 秒");
  });

  it("拒绝参考视频合计时长超过 15 秒", () => {
    expect(() =>
      assertReferenceVideoTotalDuration([
        {
          durationSeconds: 8,
          width: 1280,
          height: 720,
          framesPerSecond: 30,
        },
        {
          durationSeconds: 8,
          width: 1280,
          height: 720,
          framesPerSecond: 30,
        },
      ])
    ).toThrow("15 秒");
  });
});
