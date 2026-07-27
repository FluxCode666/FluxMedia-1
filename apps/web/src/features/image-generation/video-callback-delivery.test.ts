/**
 * 视频回调投递策略的 DB-free 单元测试。
 *
 * 职责：锁定独立投递记录字段、稳定幂等 ID 生命周期和有限指数退避边界。
 */

import { describe, expect, it } from "vitest";

import {
  createVideoCallbackDeliveryValues,
  getVideoCallbackRetryAt,
} from "./video-callback-policy";

const NOW = new Date("2026-07-26T00:00:00.000Z");

describe("video callback delivery", () => {
  it("为视频任务创建独立的待投递记录", () => {
    const values = createVideoCallbackDeliveryValues({
      videoGenerationId: "video-1",
      callbackUrl: "https://callback.example.com/video",
      now: NOW,
    });

    expect(values).toMatchObject({
      videoGenerationId: "video-1",
      callbackUrl: "https://callback.example.com/video",
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(values.id).toEqual(expect.any(String));
  });

  it("按 30 秒指数退避并在八次失败后进入人工处理", () => {
    expect(getVideoCallbackRetryAt(1, NOW)).toEqual(
      new Date("2026-07-26T00:00:30.000Z")
    );
    expect(getVideoCallbackRetryAt(7, NOW)).toEqual(
      new Date("2026-07-26T00:15:00.000Z")
    );
    expect(getVideoCallbackRetryAt(8, NOW)).toBeNull();
  });
});
