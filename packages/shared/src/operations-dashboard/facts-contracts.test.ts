/**
 * 运营总览基础事实契约的 DB-free 测试。
 *
 * 使用方：Vitest；锁定 Gregorian 日期、严格空输入和自动 epoch 输入边界，避免调用方
 * 伪造访问身份、时间、日期或页面信息。
 */
import { describe, expect, it } from "vitest";

import {
  ensureCurrentOperationsEpochInputSchema,
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

  it("自动初始化只接受发布身份，不接受调用方日期", () => {
    expect(
      ensureCurrentOperationsEpochInputSchema.safeParse({
        initializedBy: "release-v0.25.1",
      }).success
    ).toBe(true);
    expect(
      ensureCurrentOperationsEpochInputSchema.safeParse({
        initializedBy: "release-v0.25.1",
        appDate: "2026-08-16",
      }).success
    ).toBe(false);
  });
});
