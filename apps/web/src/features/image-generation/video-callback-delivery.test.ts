/**
 * 视频回调投递策略与公共负载的 DB-free 单元测试。
 *
 * 职责：锁定独立投递记录、有限重试，以及 snapshot/legacy 账单公共投影。
 */

import { createVideoBillingSnapshot } from "@repo/shared/video-generation/video-billing-snapshot";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({ db: {} }));

import { buildVideoCallbackPayload } from "./video-callback-delivery";
import {
  createVideoCallbackDeliveryValues,
  getVideoCallbackRetryAt,
} from "./video-callback-policy";

const NOW = new Date("2026-07-26T00:00:00.000Z");

/** 构造回调负载所需的最小终态任务。 */
function createCallbackVideo(metadata: Record<string, unknown>) {
  return {
    id: "video-1",
    model: "veo31",
    status: "completed",
    stage: "completed",
    capacityWaitDeadlineAt: null,
    durationSeconds: 5,
    aspectRatio: "16:9",
    resolution: "1080p",
    creditsConsumed: 3,
    error: null,
    storageBucket: "videos",
    storageKey: "video-1.mp4",
    inputManifest: {},
    metadata,
    createdAt: NOW,
    updatedAt: new Date("2026-07-26T00:01:00.000Z"),
  };
}

/** 构造含内部固定分组和摘要的合法按条任务 metadata。 */
function createSnapshotMetadata() {
  return {
    videoCapabilitySnapshot: { version: 2 },
    videoBillingSnapshot: createVideoBillingSnapshot({
      quote: {
        modelId: "veo31",
        resolution: "1080p",
        mode: "per_item",
        unit: "item",
        unitPrice: 3,
        durationSeconds: 5,
        quotedCredits: 3,
        priceSource: "global_resolution",
      },
      billingGroupId: "internal-group",
    }),
  };
}

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

  it("callback 投影固定按条账单且不泄漏内部快照字段", () => {
    const payload = buildVideoCallbackPayload({
      video: createCallbackVideo(createSnapshotMetadata()),
      videoUrl: "https://example.com/video-1.mp4",
    });

    expect(payload.billing).toEqual({
      kind: "snapshot",
      mode: "per_item",
      unit: "item",
      unitPrice: 3,
      durationSeconds: 5,
      quotedCredits: 3,
      actualCredits: 3,
    });
    expect(JSON.stringify(payload)).not.toMatch(
      /billingGroupId|digest|revision/
    );
  });

  it("callback 对升级前任务显式投影 legacy 账单", () => {
    const payload = buildVideoCallbackPayload({
      video: createCallbackVideo({
        videoCapabilitySnapshot: { version: 1 },
      }),
      videoUrl: "https://example.com/video-1.mp4",
    });

    expect(payload.billing).toEqual({
      kind: "legacy",
      mode: "per_second",
      unit: "second",
      unitPrice: null,
      creditsPerSecond: null,
      quotedCredits: null,
      actualCredits: 3,
    });
  });
});
