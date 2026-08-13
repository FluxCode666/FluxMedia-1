/**
 * 运营总览共享契约测试。
 *
 * 使用方：Vitest。锁定查询输入不接受用户身份、日期范围与粒度默认值、模块明细和
 * 导出种类的封闭集合，以及计数、积分、金额和游标的精确数值边界。
 */

import { operationsDashboardQueryInputSchema as publicQueryInputSchema } from "@repo/shared/operations-dashboard/contracts";
import { describe, expect, it } from "vitest";
import {
  OPERATIONS_DASHBOARD_DEFAULT_DAYS,
  operationsCountSchema,
  operationsCreditValueSchema,
  operationsCurrencyAmountSchema,
  operationsDashboardQueryInputSchema,
  operationsDetailSelectionSchema,
  operationsExportTypeSchema,
  operationsSpecialStatusSchema,
} from "./contracts";

describe("operations dashboard contracts", () => {
  it("默认使用近三十日与日粒度", () => {
    expect(OPERATIONS_DASHBOARD_DEFAULT_DAYS).toBe(30);
    expect(operationsDashboardQueryInputSchema.parse({})).toEqual({
      granularity: "day",
      range: { kind: "default" },
    });
    expect(publicQueryInputSchema).toBe(operationsDashboardQueryInputSchema);
  });

  it("接受四类范围和三种粒度且不限制自定义跨度", () => {
    for (const range of [
      { kind: "default" },
      { kind: "this_week" },
      { kind: "this_month" },
      { kind: "this_year" },
      { kind: "custom", from: "2020-01-01", to: "2026-08-13" },
    ]) {
      expect(
        operationsDashboardQueryInputSchema.safeParse({
          granularity: "month",
          range,
        }).success
      ).toBe(true);
    }

    expect(
      operationsDashboardQueryInputSchema.safeParse({
        granularity: "quarter",
      }).success
    ).toBe(false);
  });

  it("strict 拒绝 userId、单边日期、非法日期和未知字段", () => {
    for (const input of [
      { userId: "forged-user" },
      { range: { kind: "custom", from: "2026-08-01" } },
      {
        range: {
          kind: "custom",
          from: "2026-02-29",
          to: "2026-03-01",
        },
      },
      {
        range: {
          kind: "custom",
          from: "2026-08-10",
          to: "2026-08-01",
        },
      },
      { range: { kind: "default", from: "2026-08-01" } },
      { unknown: true },
    ]) {
      expect(operationsDashboardQueryInputSchema.safeParse(input).success).toBe(
        false
      );
    }
  });

  it("明细、导出和特殊状态只接受已定义组合", () => {
    expect(
      operationsDetailSelectionSchema.safeParse({
        module: "growth",
        detail: "retention_cohorts",
      }).success
    ).toBe(true);
    expect(
      operationsDetailSelectionSchema.safeParse({
        module: "content",
        detail: "orders",
      }).success
    ).toBe(false);
    expect(
      operationsDetailSelectionSchema.safeParse({
        module: "system_health",
        detail: "current_backend_health",
      }).success
    ).toBe(false);
    expect(operationsExportTypeSchema.options).toEqual([
      "user_growth",
      "commercialization",
      "content_production",
    ]);
    expect(operationsSpecialStatusSchema.options).toEqual([
      "value",
      "pre_epoch",
      "not_comparable",
      "immature",
      "current",
      "no_data",
    ]);
  });

  it("计数要求安全非负整数，积分允许有限小数，金额使用币种最小单位", () => {
    expect(
      operationsCountSchema.safeParse(Number.MAX_SAFE_INTEGER).success
    ).toBe(true);
    expect(operationsCountSchema.safeParse(-1).success).toBe(false);
    expect(operationsCountSchema.safeParse(1.5).success).toBe(false);
    expect(operationsCreditValueSchema.safeParse(12.34).success).toBe(true);
    expect(
      operationsCreditValueSchema.safeParse(Number.POSITIVE_INFINITY).success
    ).toBe(false);
    expect(
      operationsCurrencyAmountSchema.safeParse({
        currency: "CNY",
        amountMinor: 1234,
      }).success
    ).toBe(true);
    expect(
      operationsCurrencyAmountSchema.safeParse({
        currency: "cny",
        amountMinor: 1234,
      }).success
    ).toBe(false);
  });
});
