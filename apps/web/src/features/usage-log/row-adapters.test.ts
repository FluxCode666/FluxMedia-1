/**
 * 使用日志数据库行适配器测试。
 *
 * 覆盖稳定业务摘要、失败原因脱敏、Chat/Agent 财务兜底和退款字段互斥。
 */

import { describe, expect, it } from "vitest";

import { adaptRequestDetailRow, adaptUsageListRow } from "./row-adapters";

const TOKEN_SECRET = "usage-log-test-secret";

describe("usage log row adapters", () => {
  it("creates an opaque list row without forwarding database identifiers", () => {
    const event = adaptUsageListRow(
      {
        eventKind: "request",
        businessType: "image",
        operationType: "image_generation",
        factKind: "request",
        generationMode: "generate",
        sourceChannel: "api",
        eventAt: new Date("2026-07-22T01:00:00.000Z"),
        eventKindRank: 3,
        stableId: JSON.stringify(["generation", "private-id"]),
        status: "failed",
        rawStatus: "failed",
        grossConsumed: 10,
        refundAmount: 0,
      },
      { userId: "user-1", tokenSecret: TOKEN_SECRET }
    );

    expect(event).toMatchObject({
      kind: "request",
      businessType: "image",
      sourceChannel: "api",
      summary: "Image generation",
      status: "failed",
      creditsDelta: -10,
    });
    expect(event).not.toHaveProperty("stableId");
    expect(JSON.stringify(event)).not.toContain("private-id");
  });

  it("maps raw failures to an allowlisted code without returning the canary", () => {
    const detail = adaptRequestDetailRow({
      businessType: "video",
      requestId: "video-1",
      sourceChannel: "web",
      status: "failed",
      rawStatus: "failed",
      modelOrEndpoint: "firefly-video",
      actualUsageValue: 5,
      grossConsumed: 40,
      refunded: 40,
      createdAt: new Date("2026-07-22T01:00:00.000Z"),
      completedAt: new Date("2026-07-22T01:00:05.000Z"),
      rawError: "provider timeout CANARY_SECRET",
      hasResource: false,
    });

    expect(detail).toMatchObject({
      failureCode: "timeout",
      grossConsumed: 40,
      modelOrEndpoint: "video",
      refunded: 40,
      netConsumed: 0,
    });
    expect(JSON.stringify(detail)).not.toContain("CANARY_SECRET");
  });
});
