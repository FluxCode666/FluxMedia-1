/**
 * 运营总览基础事实契约的 DB-free 测试。
 *
 * 使用方：Vitest；锁定 Gregorian 日期、严格空输入和 epoch 初始化字段边界，避免调用方
 * 伪造访问身份、时间或页面信息。
 */
import { describe, expect, it } from "vitest";

import {
  initializeOperationsEpochInputSchema,
  operationsAppDateSchema,
  recordWebVisitInputSchema,
} from "./facts-contracts";

describe("operations dashboard fact contracts", () => {
  it("接受真实 Gregorian 日期并拒绝格式正确但不存在的日期", () => {
    expect(operationsAppDateSchema.safeParse("2028-02-29").success).toBe(true);
    expect(operationsAppDateSchema.safeParse("2026-02-29").success).toBe(false);
    expect(operationsAppDateSchema.safeParse("2026-13-01").success).toBe(false);
  });

  it("访问输入只接受严格空对象", () => {
    expect(recordWebVisitInputSchema.safeParse({}).success).toBe(true);
    for (const input of [
      { userId: "another-user" },
      { appDate: "2026-08-13" },
      { visitedAt: "2026-08-13T00:00:00.000Z" },
      { path: "/dashboard" },
      { userAgent: "browser" },
    ]) {
      expect(recordWebVisitInputSchema.safeParse(input).success).toBe(false);
    }
  });

  it("epoch 初始化要求完整、strict 且带时区偏移的输入", () => {
    const valid = {
      appDate: "2026-08-13",
      startsAt: "2026-08-12T16:00:00.000Z",
      initializedBy: "deployment-runbook",
      requestId: "operations-epoch-2026-08-13",
    };
    expect(initializeOperationsEpochInputSchema.safeParse(valid).success).toBe(
      true
    );
    expect(
      initializeOperationsEpochInputSchema.safeParse({
        ...valid,
        startsAt: "2026-08-13T00:00:00",
      }).success
    ).toBe(false);
    expect(
      initializeOperationsEpochInputSchema.safeParse({
        ...valid,
        userId: "admin-1",
      }).success
    ).toBe(false);
  });
});
