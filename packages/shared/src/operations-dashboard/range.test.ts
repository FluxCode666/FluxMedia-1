/**
 * 运营总览应用时区范围与完整桶测试。
 *
 * 使用方：Vitest。固定 asOf、应用时区和 epoch，覆盖默认范围、快捷范围、DST、
 * 闰年、月末、跨多年、上一等长周期以及周一制日周月桶的截断和特殊状态。
 */

import { resolveOperationsDashboardRange as publicRangeResolver } from "@repo/shared/operations-dashboard/range";
import { describe, expect, it } from "vitest";
import {
  getCohortMaturityDates,
  resolveOperationsDashboardRange,
} from "./range";

const SHANGHAI = "Asia/Shanghai";
const LOS_ANGELES = "America/Los_Angeles";

/**
 * 计算桶真实覆盖的小时数。
 *
 * @param bucket 包含 UTC 起止边界的范围桶。
 * @returns 起止瞬间之间的小时数；无副作用。
 */
function getBucketHours(bucket: { start: Date; end: Date }): number {
  return (bucket.end.getTime() - bucket.start.getTime()) / 3_600_000;
}

describe("resolveOperationsDashboardRange", () => {
  it("可从 package exports 的稳定公开路径导入", () => {
    expect(publicRangeResolver).toBe(resolveOperationsDashboardRange);
  });

  it("默认返回今天和前二十九个自然日并让今天截止同一 asOf", () => {
    const asOf = new Date("2026-08-13T10:15:30.000Z");
    const result = resolveOperationsDashboardRange(
      {},
      { asOf, epochDate: "2026-07-01", timeZone: SHANGHAI }
    );

    expect(result).toMatchObject({
      today: "2026-08-13",
      from: "2026-07-15",
      to: "2026-08-13",
      dayCount: 30,
      granularity: "day",
      end: asOf,
    });
    expect(result.buckets).toHaveLength(30);
    expect(result.buckets.at(-1)?.end).toEqual(asOf);
  });

  it("本周以周一开始，本月和本年都只包含截至今天的日期", () => {
    const options = {
      asOf: new Date("2026-08-13T10:15:30.000Z"),
      epochDate: "2026-01-01",
      timeZone: SHANGHAI,
    };

    expect(
      resolveOperationsDashboardRange({ range: { kind: "this_week" } }, options)
    ).toMatchObject({ from: "2026-08-10", to: "2026-08-13" });
    expect(
      resolveOperationsDashboardRange(
        { range: { kind: "this_month" } },
        options
      )
    ).toMatchObject({ from: "2026-08-01", to: "2026-08-13" });
    expect(
      resolveOperationsDashboardRange({ range: { kind: "this_year" } }, options)
    ).toMatchObject({ from: "2026-01-01", to: "2026-08-13" });
  });

  it("上一等长周期紧邻当前范围之前并保持相同自然日数量", () => {
    const result = resolveOperationsDashboardRange(
      {
        range: {
          kind: "custom",
          from: "2024-02-28",
          to: "2024-03-02",
        },
      },
      {
        asOf: new Date("2024-03-10T12:00:00.000Z"),
        epochDate: "2024-01-01",
        timeZone: "UTC",
      }
    );

    expect(result.dayCount).toBe(4);
    expect(result.previous).toMatchObject({
      from: "2024-02-24",
      to: "2024-02-27",
      dayCount: 4,
      availability: "available",
    });
  });

  it("跨春秋 DST 的日桶保持自然日数量并产生二十三和二十五小时桶", () => {
    const spring = resolveOperationsDashboardRange(
      {
        range: {
          kind: "custom",
          from: "2026-03-05",
          to: "2026-03-11",
        },
      },
      {
        asOf: new Date("2026-04-01T12:00:00.000Z"),
        epochDate: "2026-01-01",
        timeZone: LOS_ANGELES,
      }
    );
    const autumn = resolveOperationsDashboardRange(
      {
        range: {
          kind: "custom",
          from: "2026-10-29",
          to: "2026-11-04",
        },
      },
      {
        asOf: new Date("2026-12-01T12:00:00.000Z"),
        epochDate: "2026-01-01",
        timeZone: LOS_ANGELES,
      }
    );

    expect(spring.buckets.map(getBucketHours)).toContain(23);
    expect(autumn.buckets.map(getBucketHours)).toContain(25);
  });

  it("按周生成完整桶并在查询首尾截断", () => {
    const result = resolveOperationsDashboardRange(
      {
        granularity: "week",
        range: {
          kind: "custom",
          from: "2026-08-05",
          to: "2026-08-18",
        },
      },
      {
        asOf: new Date("2026-08-20T12:00:00.000Z"),
        epochDate: "2026-01-01",
        timeZone: "UTC",
      }
    );

    expect(result.buckets.map(({ from, to }) => ({ from, to }))).toEqual([
      { from: "2026-08-05", to: "2026-08-09" },
      { from: "2026-08-10", to: "2026-08-16" },
      { from: "2026-08-17", to: "2026-08-18" },
    ]);
  });

  it("按月生成完整桶并覆盖月末、闰日和跨年边界", () => {
    const result = resolveOperationsDashboardRange(
      {
        granularity: "month",
        range: {
          kind: "custom",
          from: "2023-12-31",
          to: "2024-03-02",
        },
      },
      {
        asOf: new Date("2024-03-10T12:00:00.000Z"),
        epochDate: "2023-01-01",
        timeZone: "UTC",
      }
    );

    expect(result.buckets.map(({ from, to }) => ({ from, to }))).toEqual([
      { from: "2023-12-31", to: "2023-12-31" },
      { from: "2024-01-01", to: "2024-01-31" },
      { from: "2024-02-01", to: "2024-02-29" },
      { from: "2024-03-01", to: "2024-03-02" },
    ]);
  });

  it("接受跨多年范围且不施加最大跨度", () => {
    const result = resolveOperationsDashboardRange(
      {
        granularity: "month",
        range: {
          kind: "custom",
          from: "2020-01-01",
          to: "2026-08-13",
        },
      },
      {
        asOf: new Date("2026-08-13T12:00:00.000Z"),
        epochDate: "2020-01-01",
        timeZone: "UTC",
      }
    );

    expect(result.dayCount).toBeGreaterThan(2_400);
    expect(result.buckets.at(0)?.from).toBe("2020-01-01");
    expect(result.buckets.at(-1)?.to).toBe("2026-08-13");
  });

  it("epoch 前桶显式标记，epoch 当天正常，跨 epoch 桶标记部分可用", () => {
    const daily = resolveOperationsDashboardRange(
      {
        range: {
          kind: "custom",
          from: "2026-07-30",
          to: "2026-08-02",
        },
      },
      {
        asOf: new Date("2026-08-10T12:00:00.000Z"),
        epochDate: "2026-08-01",
        timeZone: "UTC",
      }
    );

    expect(daily.buckets.map((bucket) => bucket.availability)).toEqual([
      "pre_epoch",
      "pre_epoch",
      "available",
      "available",
    ]);
    expect(daily.dataStart).toEqual(new Date("2026-08-01T00:00:00.000Z"));

    const monthly = resolveOperationsDashboardRange(
      {
        granularity: "month",
        range: {
          kind: "custom",
          from: "2026-07-01",
          to: "2026-08-31",
        },
      },
      {
        asOf: new Date("2026-09-10T12:00:00.000Z"),
        epochDate: "2026-07-15",
        timeZone: "UTC",
      }
    );

    expect(monthly.buckets.map((bucket) => bucket.availability)).toEqual([
      "partial_epoch",
      "available",
    ]);
    expect(monthly.buckets[0]?.dataFrom).toEqual(
      new Date("2026-07-15T00:00:00.000Z")
    );
  });

  it("完全位于 epoch 前的当前和上一周期都不暴露行为事实读取起点", () => {
    const result = resolveOperationsDashboardRange(
      {
        range: {
          kind: "custom",
          from: "2026-07-01",
          to: "2026-07-03",
        },
      },
      {
        asOf: new Date("2026-08-10T12:00:00.000Z"),
        epochDate: "2026-08-01",
        timeZone: "UTC",
      }
    );

    expect(result.availability).toBe("pre_epoch");
    expect(result.dataStart).toBeNull();
    expect(result.previous.availability).toBe("pre_epoch");
    expect(result.previous.dataStart).toBeNull();
  });

  it("拒绝未来结束日、反向范围、非法日期、非法字段与非法运行参数", () => {
    const options = {
      asOf: new Date("2026-08-13T12:00:00.000Z"),
      epochDate: "2026-01-01",
      timeZone: "UTC",
    };

    for (const input of [
      {
        range: {
          kind: "custom",
          from: "2026-08-01",
          to: "2026-08-14",
        },
      },
      {
        range: {
          kind: "custom",
          from: "2026-08-10",
          to: "2026-08-01",
        },
      },
      {
        range: {
          kind: "custom",
          from: "2026-02-29",
          to: "2026-03-01",
        },
      },
      { userId: "forged-user" },
    ]) {
      expect(() => resolveOperationsDashboardRange(input, options)).toThrow(
        RangeError
      );
    }

    expect(() =>
      resolveOperationsDashboardRange({}, { ...options, timeZone: "invalid" })
    ).toThrow(RangeError);
    expect(() =>
      resolveOperationsDashboardRange(
        {},
        { ...options, asOf: new Date(Number.NaN) }
      )
    ).toThrow(RangeError);
  });
});

describe("getCohortMaturityDates", () => {
  it("D1、D7、D30 始终按自然日差计算并跨越闰日与月末", () => {
    expect(getCohortMaturityDates("2024-02-28")).toEqual({
      d1: "2024-02-29",
      d7: "2024-03-06",
      d30: "2024-03-29",
    });
  });
});
