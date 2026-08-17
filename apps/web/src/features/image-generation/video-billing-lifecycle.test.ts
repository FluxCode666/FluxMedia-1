/**
 * 视频账单生命周期不变量的 DB-free 单测。
 *
 * 使用方：Web Vitest；覆盖创建期间能力漂移、固定金额和 metadata 不可变边界。
 */
import {
  DEFAULT_VIDEO_MODEL_CREDITS_PER_ITEM,
  DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND,
  resolveVideoBillingQuote,
} from "@repo/shared/adobe";
import { createDefaultModelMarketplaceConfig } from "@repo/shared/model-marketplace";
import { createDefaultVideoModelCapabilityOverrides } from "@repo/shared/video-generation";
import { createVideoBillingSnapshot } from "@repo/shared/video-generation/video-billing-snapshot";
import { describe, expect, it } from "vitest";

import {
  assertAuthoritativeVideoCapabilitySnapshot,
  assertVideoBillingMetadataPreserved,
  assertVideoSnapshotAmount,
  createVideoBillingLedgerMetadata,
  projectVideoTaskPublicBilling,
  resolvePersistedVideoTaskBilling,
} from "./video-billing-lifecycle";
import { createVideoCapabilitySnapshot } from "./video-execution-contract";

/** 构造合法 v2 按条任务 metadata，供不可变性测试复用。 */
function createSnapshotMetadata() {
  const quote = resolveVideoBillingQuote({
    modelId: "veo31",
    resolution: "1080p",
    durationSeconds: 5,
    mode: "per_item",
    globalCreditsPerSecond: DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND,
    globalCreditsPerItem: DEFAULT_VIDEO_MODEL_CREDITS_PER_ITEM,
  });
  return {
    videoCapabilitySnapshot: createVideoCapabilitySnapshot({
      modelConfigurationRevision: 0,
      maxReferenceImages: 0,
    }),
    videoBillingSnapshot: createVideoBillingSnapshot({
      quote,
      billingGroupId: "group-1",
    }),
  };
}

describe("video billing lifecycle", () => {
  it("权威配置与早期能力快照一致时允许创建", () => {
    expect(() =>
      assertAuthoritativeVideoCapabilitySnapshot({
        modelId: "veo31",
        capabilitySnapshot: createVideoCapabilitySnapshot({
          modelConfigurationRevision: 0,
          maxReferenceImages: 0,
        }),
        marketplaceConfig: createDefaultModelMarketplaceConfig(),
        videoCapabilityOverrides: createDefaultVideoModelCapabilityOverrides(),
      })
    ).not.toThrow();
  });

  it("动态能力在事务报价前漂移时拒绝使用旧快照", () => {
    expect(() =>
      assertAuthoritativeVideoCapabilitySnapshot({
        modelId: "seedance2",
        capabilitySnapshot: createVideoCapabilitySnapshot({
          modelConfigurationRevision: 0,
          maxReferenceImages: 10,
        }),
        marketplaceConfig: createDefaultModelMarketplaceConfig(),
        videoCapabilityOverrides: {
          version: 1,
          byModel: { seedance2: { maxReferenceImages: 20 } },
        },
      })
    ).toThrow("视频模型能力配置在任务创建期间已发生变化");
  });

  it("v2 只允许使用固定报价金额并投影账本摘要", () => {
    const resolved = resolvePersistedVideoTaskBilling(createSnapshotMetadata());
    expect(resolved).toHaveProperty("pinnedGroupId", "group-1");
    expect(() => assertVideoSnapshotAmount(resolved.billing, 3, "扣费")).not
      .toThrow;
    expect(() =>
      assertVideoSnapshotAmount(resolved.billing, 4, "扣费")
    ).toThrow("视频任务扣费金额与固定报价不一致");
    if (resolved.billing.kind !== "snapshot") {
      throw new Error("测试快照解析结果无效");
    }
    expect(createVideoBillingLedgerMetadata(resolved.billing.snapshot)).toEqual(
      expect.objectContaining({
        videoBillingMode: "per_item",
        videoBillingQuotedCredits: 3,
      })
    );
    expect(projectVideoTaskPublicBilling(createSnapshotMetadata(), 0)).toEqual({
      kind: "snapshot",
      mode: "per_item",
      unit: "item",
      unitPrice: 3,
      durationSeconds: 5,
      quotedCredits: 3,
      actualCredits: 0,
    });
  });

  it("legacy 公共账单不伪造未知单价与报价", () => {
    expect(
      projectVideoTaskPublicBilling(
        { videoCapabilitySnapshot: { version: 1 } },
        12
      )
    ).toEqual({
      kind: "legacy",
      mode: "per_second",
      unit: "second",
      unitPrice: null,
      creditsPerSecond: null,
      quotedCredits: null,
      actualCredits: 12,
    });
  });

  it("账单快照上线前的旧视频 metadata 兼容为 legacy 公共账单", () => {
    expect(projectVideoTaskPublicBilling(null, 12)).toEqual({
      kind: "legacy",
      mode: "per_second",
      unit: "second",
      unitPrice: null,
      creditsPerSecond: null,
      quotedCredits: null,
      actualCredits: 12,
    });
    expect(projectVideoTaskPublicBilling({ generateAudio: true }, 8)).toEqual({
      kind: "legacy",
      mode: "per_second",
      unit: "second",
      unitPrice: null,
      creditsPerSecond: null,
      quotedCredits: null,
      actualCredits: 8,
    });
  });

  it("带损坏快照的 metadata 仍然拒绝展示", () => {
    expect(() =>
      projectVideoTaskPublicBilling(
        { videoCapabilitySnapshot: { version: 2 } },
        8
      )
    ).toThrow("新视频任务缺少账单快照");
  });

  it("非财务 metadata 可更新但账单快照不能删除或替换", () => {
    const metadata = createSnapshotMetadata();
    expect(() =>
      assertVideoBillingMetadataPreserved(metadata, {
        ...metadata,
        videoBackendProtocol: "api",
      })
    ).not.toThrow();
    expect(() =>
      assertVideoBillingMetadataPreserved(metadata, {
        videoCapabilitySnapshot: metadata.videoCapabilitySnapshot,
      })
    ).toThrow("视频任务账单快照不能删除或替换");
  });
});
