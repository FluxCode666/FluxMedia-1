/**
 * 视频账单快照纯契约测试。
 *
 * 覆盖不可变报价的创建、规范摘要、严格往返、篡改检测，以及旧能力任务与新能力任务
 * 的显式兼容边界；测试不读取数据库或运行时设置。
 */
import { describe, expect, it } from "vitest";

import { resolveVideoBillingQuote } from "../adobe/video-pricing";
import {
  createVideoBillingSnapshot,
  LEGACY_VIDEO_CAPABILITY_SNAPSHOT_VERSION,
  parseVideoBillingSnapshot,
  resolveVideoTaskBilling,
  VIDEO_BILLING_CAPABILITY_SNAPSHOT_VERSION,
} from "./video-billing-snapshot";

/** 创建稳定的按条报价，供快照边界测试复用。 */
function createPerItemQuote() {
  return resolveVideoBillingQuote({
    modelId: "seedance2",
    resolution: "1080p",
    durationSeconds: 5,
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
    groupCreditsPerItem: { "seedance2@1080p": 6 },
  });
}

describe("video billing snapshot", () => {
  it("从报价创建规范快照并严格往返，报价总额与预估一致", () => {
    const quote = createPerItemQuote();
    const snapshot = createVideoBillingSnapshot({
      quote,
      billingGroupId: "group-primary",
    });

    expect(snapshot).toMatchObject({
      version: 1,
      modelId: "seedance2",
      resolution: "1080p",
      mode: "per_item",
      unit: "item",
      unitPrice: 6,
      durationSeconds: 5,
      quotedCredits: quote.quotedCredits,
      billingGroupId: "group-primary",
    });
    expect(snapshot.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(parseVideoBillingSnapshot(structuredClone(snapshot))).toEqual(
      snapshot
    );
    expect(
      createVideoBillingSnapshot({
        quote,
        billingGroupId: "group-primary",
      }).digest
    ).toBe(snapshot.digest);
    expect(snapshot).not.toHaveProperty("creditsConsumed");
  });

  it.each([
    "unitPrice",
    "quotedCredits",
    "mode",
    "digest",
  ])("拒绝被篡改的 %s", (field) => {
    const snapshot = createVideoBillingSnapshot({
      quote: createPerItemQuote(),
      billingGroupId: "group-primary",
    });
    const tampered: Record<string, unknown> = structuredClone(snapshot);
    tampered[field] =
      field === "mode"
        ? "per_second"
        : field === "digest"
          ? "0".repeat(64)
          : 999;

    expect(() => parseVideoBillingSnapshot(tampered)).toThrow();
  });

  it("拒绝在不可变快照内混入实际消费或未知字段", () => {
    const snapshot = createVideoBillingSnapshot({
      quote: createPerItemQuote(),
      billingGroupId: "group-primary",
    });

    expect(() =>
      parseVideoBillingSnapshot({ ...snapshot, creditsConsumed: 6 })
    ).toThrow();
  });

  it("旧能力版本无账单快照进入 legacy 按秒分支", () => {
    expect(
      resolveVideoTaskBilling({
        videoCapabilitySnapshot: {
          version: LEGACY_VIDEO_CAPABILITY_SNAPSHOT_VERSION,
        },
      })
    ).toEqual({ kind: "legacy", mode: "per_second", unit: "second" });
  });

  it("新能力版本必须携带合法账单快照", () => {
    expect(() =>
      resolveVideoTaskBilling({
        videoCapabilitySnapshot: {
          version: VIDEO_BILLING_CAPABILITY_SNAPSHOT_VERSION,
        },
      })
    ).toThrow();

    const snapshot = createVideoBillingSnapshot({
      quote: createPerItemQuote(),
      billingGroupId: "group-primary",
    });
    expect(
      resolveVideoTaskBilling({
        videoCapabilitySnapshot: {
          version: VIDEO_BILLING_CAPABILITY_SNAPSHOT_VERSION,
        },
        videoBillingSnapshot: snapshot,
      })
    ).toEqual({ kind: "snapshot", snapshot });
  });

  it("拒绝旧能力版本混入新账单快照或未知能力版本", () => {
    const snapshot = createVideoBillingSnapshot({
      quote: createPerItemQuote(),
      billingGroupId: "group-primary",
    });

    expect(() =>
      resolveVideoTaskBilling({
        videoCapabilitySnapshot: {
          version: LEGACY_VIDEO_CAPABILITY_SNAPSHOT_VERSION,
        },
        videoBillingSnapshot: snapshot,
      })
    ).toThrow();
    expect(() =>
      resolveVideoTaskBilling({
        videoCapabilitySnapshot: { version: 99 },
      })
    ).toThrow();
  });
});
