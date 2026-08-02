/**
 * 视频执行契约快照的 DB-free 单元测试。
 *
 * 使用方：Vitest；锁定任务保存真实模型配置 revision，并拒绝 U5 临时使用的能力设置
 * 格式版本字段，避免管理员改限后历史任务重新读取当前能力。
 */

import { describe, expect, it } from "vitest";

import {
  createVideoCapabilitySnapshot,
  resolveVideoExecutionContract,
} from "./video-execution-contract";

describe("video execution contract", () => {
  it("创建并恢复真实模型配置 revision", () => {
    const snapshot = createVideoCapabilitySnapshot({
      modelConfigurationRevision: 7,
      maxReferenceImages: 20,
    });

    expect(snapshot).toEqual({
      version: 1,
      modelConfigurationRevision: 7,
      maxReferenceImages: 20,
    });
    expect(
      resolveVideoExecutionContract({
        model: "seedance2",
        durationSeconds: 10,
        aspectRatio: "16:9",
        resolution: "1080p",
        metadata: {
          generateAudio: false,
          videoCapabilitySnapshot: snapshot,
        },
      })
    ).toMatchObject({
      model: "seedance2",
      modelConfigurationRevision: 7,
      maxReferenceImages: 20,
    });
  });

  it("拒绝只含临时 capabilityOverridesVersion 的旧快照形状", () => {
    expect(() =>
      resolveVideoExecutionContract({
        model: "seedance2",
        durationSeconds: 10,
        aspectRatio: "16:9",
        resolution: "1080p",
        metadata: {
          generateAudio: false,
          videoCapabilitySnapshot: {
            version: 1,
            capabilityOverridesVersion: 1,
            maxReferenceImages: 20,
          },
        },
      })
    ).toThrow("视频任务的能力快照版本无效");
  });
});
