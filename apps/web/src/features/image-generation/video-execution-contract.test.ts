/**
 * 视频执行契约快照的 DB-free 单元测试。
 *
 * 使用方：Vitest；锁定新任务使用 v2、历史 v1 仍可恢复，并与共享账单快照解析器使用
 * 同一版本边界，避免新任务缺少账单时错误降级到动态按秒计费。
 */

import { resolveVideoBillingQuote } from "@repo/shared/video-generation";
import {
  createVideoBillingSnapshot,
  resolveVideoTaskBilling,
} from "@repo/shared/video-generation/video-billing-snapshot";
import { describe, expect, it } from "vitest";

import {
  createVideoCapabilitySnapshot,
  resolveVideoExecutionContract,
} from "./video-execution-contract";

describe("video execution contract", () => {
  it("新建 v2 能力快照并要求同任务携带合法账单快照", () => {
    const snapshot = createVideoCapabilitySnapshot({
      modelConfigurationRevision: 7,
      maxReferenceImages: 20,
    });

    expect(snapshot).toEqual({
      version: 2,
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

    expect(() =>
      resolveVideoTaskBilling({ videoCapabilitySnapshot: snapshot })
    ).toThrow("新视频任务缺少账单快照");

    const billingSnapshot = createVideoBillingSnapshot({
      quote: resolveVideoBillingQuote({
        modelId: "seedance2",
        resolution: "1080p",
        durationSeconds: 10,
        mode: "per_item",
        globalCreditsPerSecond: {
          "seedance2@1080p": 2,
          "seedance2@720p": 1.5,
          "seedance2@480p": 1,
        },
        globalCreditsPerItem: {
          "seedance2@1080p": 5,
          "seedance2@720p": 4,
          "seedance2@480p": 3,
        },
      }),
      billingGroupId: "group-primary",
    });
    expect(
      resolveVideoTaskBilling({
        videoCapabilitySnapshot: snapshot,
        videoBillingSnapshot: billingSnapshot,
      })
    ).toEqual({ kind: "snapshot", snapshot: billingSnapshot });
  });

  it("继续恢复 v1 历史能力快照并固定进入 legacy 按秒分支", () => {
    const capabilitySnapshot = {
      version: 1,
      modelConfigurationRevision: 6,
      maxReferenceImages: 20,
    };

    expect(
      resolveVideoExecutionContract({
        model: "seedance2",
        durationSeconds: 10,
        aspectRatio: "16:9",
        resolution: "1080p",
        metadata: {
          generateAudio: false,
          videoCapabilitySnapshot: capabilitySnapshot,
        },
      })
    ).toMatchObject({
      model: "seedance2",
      modelConfigurationRevision: 6,
      maxReferenceImages: 20,
    });
    expect(
      resolveVideoTaskBilling({
        videoCapabilitySnapshot: capabilitySnapshot,
      })
    ).toEqual({ kind: "legacy", mode: "per_second", unit: "second" });
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

  it("拒绝未知能力快照版本", () => {
    expect(() =>
      resolveVideoExecutionContract({
        model: "seedance2",
        durationSeconds: 10,
        aspectRatio: "16:9",
        resolution: "1080p",
        metadata: {
          generateAudio: false,
          videoCapabilitySnapshot: {
            version: 3,
            modelConfigurationRevision: 7,
            maxReferenceImages: 20,
          },
        },
      })
    ).toThrow("视频任务的能力快照版本无效");
  });
});
