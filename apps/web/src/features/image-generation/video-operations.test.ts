/**
 * 视频恢复状态机纯策略单测。
 *
 * 使用方：Vitest；验证稳定存储键与 accepted 后错误分类，不连接数据库、Adobe 或存储。
 */

import { AdobeAcceptedVideoError } from "@repo/shared/adobe/firefly-direct";
import { describe, expect, it } from "vitest";
import {
  createVideoStorageKey,
  requireAcceptedVideoCredential,
  shouldRetryAcceptedVideoError,
} from "./video-recovery-policy";

describe("video recovery policies", () => {
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
    expect(
      requireAcceptedVideoCredential({ value: "fresh-token" })
    ).toBe("fresh-token");
    expect(() =>
      requireAcceptedVideoCredential(null)
    ).toThrow("原成员凭据刷新失败");
  });

  it("已接受任务的明确 4xx 和普通错误不进入轮询重试", () => {
    expect(
      shouldRetryAcceptedVideoError(
        new AdobeAcceptedVideoError("rejected", { statusCode: 400 })
      )
    ).toBe(false);
    expect(shouldRetryAcceptedVideoError(new Error("unclassified"))).toBe(
      false
    );
  });
});
