/**
 * 视频恢复状态机纯策略单测。
 *
 * 使用方：Vitest；验证稳定存储键与 accepted 后错误分类，不连接数据库、Adobe 或存储。
 */

import { AdobeAcceptedVideoError } from "@repo/shared/adobe/firefly-direct";
import { describe, expect, it } from "vitest";
import { ApiAcceptedVideoError } from "./api-video-error";
import {
  createVideoCapabilitySnapshot,
  resolveVideoExecutionContract,
} from "./video-execution-contract";
import {
  buildVideoCallbackInput,
  shouldRetainVideoInputsAfterStage,
} from "./video-input-lifecycle";
import {
  createVideoStorageKey,
  isAcceptedVideoError,
  requireAcceptedVideoCredential,
  resolveApiAdapterQueryFailure,
  resolveVideoBackendExhaustionError,
  shouldRetryAcceptedVideoError,
  usesBoundedVideoRefundRetryPolicy,
} from "./video-recovery-policy";

describe("video recovery policies", () => {
  it("仅 API 退款使用三次有界恢复策略", () => {
    expect(usesBoundedVideoRefundRetryPolicy("api")).toBe(true);
    expect(usesBoundedVideoRefundRetryPolicy("adobe_direct")).toBe(false);
  });

  it("API 查询适配连续失败恰好三次后终止重试", () => {
    expect(resolveApiAdapterQueryFailure(0)).toEqual({
      nextFailureCount: 1,
      shouldRetry: true,
    });
    expect(resolveApiAdapterQueryFailure(1)).toEqual({
      nextFailureCount: 2,
      shouldRetry: true,
    });
    expect(resolveApiAdapterQueryFailure(2)).toEqual({
      nextFailureCount: 3,
      shouldRetry: false,
    });
    expect(() => resolveApiAdapterQueryFailure(-1)).toThrow(
      "API 查询适配连续失败次数无效"
    );
  });

  it("任务进入完成或失败终态后仍保留具名输入清单", () => {
    expect(shouldRetainVideoInputsAfterStage("completed")).toBe(true);
    expect(shouldRetainVideoInputsAfterStage("failed")).toBe(true);
  });

  it("callback 输入 DTO 只返回模式和数量", () => {
    const input = buildVideoCallbackInput({
      referenceImages: [
        {
          source: "storage",
          mimeType: "image/png",
          storageKey: "user-1/video-inputs/video-1/reservation-1/reference.png",
          storageBucket: "uploads",
          byteLength: 12,
        },
      ],
    });

    expect(input).toEqual({ mode: "references", count: 1 });
    expect(JSON.stringify(input)).not.toContain("storageKey");
    expect(JSON.stringify(input)).not.toContain("url");
  });

  it("为同一任务始终生成同一个对象存储键", () => {
    expect(createVideoStorageKey("user-1", "video-1")).toBe(
      "user-1/videos/video-1.mp4"
    );
    expect(createVideoStorageKey("user-1", "video-1")).toBe(
      createVideoStorageKey("user-1", "video-1")
    );
  });

  it("已接受任务的网络和 5xx 错误只恢复原任务", () => {
    expect(
      shouldRetryAcceptedVideoError(
        new ApiAcceptedVideoError("API network", true)
      )
    ).toBe(true);
    expect(
      shouldRetryAcceptedVideoError(
        new AdobeAcceptedVideoError("network", { errorType: "network" })
      )
    ).toBe(true);
    expect(
      shouldRetryAcceptedVideoError(
        new AdobeAcceptedVideoError("temporary", { statusCode: 503 })
      )
    ).toBe(true);
    expect(
      shouldRetryAcceptedVideoError(
        new AdobeAcceptedVideoError("expired token", { statusCode: 401 })
      )
    ).toBe(true);
  });

  it("已接受任务只接受原成员刷新出的有效凭据", () => {
    expect(requireAcceptedVideoCredential({ value: "fresh-token" })).toBe(
      "fresh-token"
    );
    expect(() => requireAcceptedVideoCredential(null)).toThrow(
      "原成员凭据刷新失败"
    );
  });

  it("已接受任务的明确 4xx 和普通错误不进入轮询重试", () => {
    const apiRejected = new ApiAcceptedVideoError("API rejected", false, 400);
    expect(isAcceptedVideoError(apiRejected)).toBe(true);
    expect(shouldRetryAcceptedVideoError(apiRejected)).toBe(false);
    expect(
      shouldRetryAcceptedVideoError(
        new AdobeAcceptedVideoError("rejected", { statusCode: 400 })
      )
    ).toBe(false);
    expect(shouldRetryAcceptedVideoError(new Error("unclassified"))).toBe(
      false
    );
    expect(isAcceptedVideoError(new Error("unclassified"))).toBe(false);
  });

  it("切换耗尽时保留安全的鉴权根因并隐藏未知上游正文", () => {
    expect(resolveVideoBackendExhaustionError("Token invalid or expired")).toBe(
      "Adobe 视频凭据无效或已过期，且当前分组没有其他可切换的媒体后端"
    );
    expect(
      resolveVideoBackendExhaustionError(
        "video submit failed: 500 https://internal.example/token=secret"
      )
    ).toBe("当前分组没有可用于该模型的媒体后端");
  });
});

describe("video execution contract", () => {
  it("从任务快照恢复自定义 API 视频模型与注册分辨率", () => {
    const contract = resolveVideoExecutionContract({
      model: "vendor-video-x",
      durationSeconds: 12,
      aspectRatio: "16:9",
      resolution: "1080p",
      metadata: {
        generateAudio: false,
        videoCapabilitySnapshot: {
          version: 1,
          modelConfigurationRevision: 3,
          maxReferenceImages: 0,
          customModel: {
            modelId: "vendor-video-x",
            supportedResolutions: ["720p", "1080p"],
          },
        },
      },
    });

    expect(contract).toMatchObject({
      model: "vendor-video-x",
      billingFamily: "vendor-video-x",
      duration: 12,
      resolution: "1080p",
      frameCapability: "none",
      effectiveAudio: false,
    });
  });

  it("用真实 Seedance ID、独立参数和创建时二十张上限恢复提交事实", () => {
    const contract = resolveVideoExecutionContract({
      model: "seedance2",
      durationSeconds: 15,
      aspectRatio: "9:16",
      resolution: "480p",
      metadata: {
        generateAudio: true,
        videoCapabilitySnapshot: {
          version: 1,
          modelConfigurationRevision: 1,
          maxReferenceImages: 20,
        },
      },
    });

    expect(contract).toEqual({
      model: "seedance2",
      duration: 15,
      aspectRatio: "9:16",
      resolution: "480p",
      billingFamily: "seedance2",
      effectiveAudio: true,
      frameCapability: "first-and-optional-last",
      maxReferenceImages: 20,
      modelConfigurationRevision: 1,
    });
  });

  it("恢复只读取任务快照，不接受调用方注入当前动态上限", () => {
    const persisted = resolveVideoExecutionContract({
      model: "seedance2",
      durationSeconds: 4,
      aspectRatio: "16:9",
      resolution: "480p",
      metadata: {
        generateAudio: false,
        videoCapabilitySnapshot: {
          version: 1,
          modelConfigurationRevision: 1,
          maxReferenceImages: 20,
        },
      },
    });

    expect(persisted.maxReferenceImages).toBe(20);
    expect(Object.keys(persisted)).not.toContain("currentMaxReferenceImages");
  });

  it("从有效能力生成版本化任务快照", () => {
    expect(
      createVideoCapabilitySnapshot({
        modelConfigurationRevision: 1,
        maxReferenceImages: 20,
      })
    ).toEqual({
      version: 1,
      modelConfigurationRevision: 1,
      maxReferenceImages: 20,
    });
  });

  it.each([
    {
      model: "seedance2-15s-9x16-480p",
      durationSeconds: 15,
      aspectRatio: "9:16",
      resolution: "480p",
      metadata: {
        generateAudio: false,
        videoCapabilitySnapshot: {
          version: 1,
          modelConfigurationRevision: 1,
          maxReferenceImages: 20,
        },
      },
    },
    {
      model: "seedance2",
      durationSeconds: 15,
      aspectRatio: "9:16",
      resolution: "480p",
      metadata: { generateAudio: false },
    },
    {
      model: "runway-gen45",
      durationSeconds: 5,
      aspectRatio: "16:9",
      resolution: "720p",
      metadata: {
        generateAudio: true,
        videoCapabilitySnapshot: {
          version: 1,
          modelConfigurationRevision: 1,
          maxReferenceImages: 0,
        },
      },
    },
  ])("拒绝复合身份、缺失快照或不支持的有效声音", (input) => {
    expect(() => resolveVideoExecutionContract(input)).toThrow();
  });
});
