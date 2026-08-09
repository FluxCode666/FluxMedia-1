/**
 * 用户数据看板自然日范围解析测试。
 *
 * 使用方：Vitest；固定显式时区与同一 asOf，验证默认范围、历史半开边界、DST、
 * 闰日、30 天上限以及所有非法输入均在 DB-free 纯逻辑层被拒绝。
 */
import { describe, expect, it } from "vitest";

import { resolveDataDashboardRange } from "./data-dashboard-range";

const LOS_ANGELES = "America/Los_Angeles";
const SHANGHAI = "Asia/Shanghai";

/**
 * 计算一个已解析自然日桶的实际小时数。
 *
 * @param bucket 含 UTC 起止瞬间的自然日桶。
 * @returns 桶覆盖的实际小时数；无副作用。
 */
function getBucketHours(bucket: { start: Date; end: Date }): number {
  return (bucket.end.getTime() - bucket.start.getTime()) / 3_600_000;
}

describe("resolveDataDashboardRange", () => {
  it("默认解析账号时区中的今天和前六个自然日并截止同一 asOf", () => {
    const asOf = new Date("2026-08-09T10:15:30.000Z");

    const result = resolveDataDashboardRange({}, { asOf, timeZone: SHANGHAI });

    expect(result).toMatchObject({
      timeZone: SHANGHAI,
      asOf,
      today: "2026-08-09",
      startDate: "2026-08-03",
      endDate: "2026-08-09",
      start: new Date("2026-08-02T16:00:00.000Z"),
      end: asOf,
      bucketCount: 7,
    });
    expect(result.buckets.map((bucket) => bucket.date)).toEqual([
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
      "2026-08-06",
      "2026-08-07",
      "2026-08-08",
      "2026-08-09",
    ]);
    expect(result.buckets.at(-1)?.end).toEqual(asOf);
  });

  it("历史范围使用结束日期次日零点作为 UTC 半开边界", () => {
    const result = resolveDataDashboardRange(
      { startDate: "2026-07-02", endDate: "2026-07-31" },
      {
        asOf: new Date("2026-08-09T10:15:30.000Z"),
        timeZone: SHANGHAI,
      }
    );

    expect(result.bucketCount).toBe(30);
    expect(result.start.toISOString()).toBe("2026-07-01T16:00:00.000Z");
    expect(result.end.toISOString()).toBe("2026-07-31T16:00:00.000Z");
    expect(result.buckets.at(-1)?.end.toISOString()).toBe(
      "2026-07-31T16:00:00.000Z"
    );
  });

  it("跨春季 DST 的七天范围保留七个自然日且包含 23 小时桶", () => {
    const result = resolveDataDashboardRange(
      { startDate: "2026-03-05", endDate: "2026-03-11" },
      {
        asOf: new Date("2026-04-01T12:00:00.000Z"),
        timeZone: LOS_ANGELES,
      }
    );

    expect(result.bucketCount).toBe(7);
    expect(result.buckets.map(getBucketHours)).toContain(23);
  });

  it("跨秋季 DST 的三十天范围保留三十个自然日且包含 25 小时桶", () => {
    const result = resolveDataDashboardRange(
      { startDate: "2026-10-10", endDate: "2026-11-08" },
      {
        asOf: new Date("2026-12-01T12:00:00.000Z"),
        timeZone: LOS_ANGELES,
      }
    );

    expect(result.bucketCount).toBe(30);
    expect(result.buckets.map(getBucketHours)).toContain(25);
  });

  it("按 Gregorian 日历接受闰日并保持连续桶", () => {
    const result = resolveDataDashboardRange(
      { startDate: "2024-02-28", endDate: "2024-03-01" },
      {
        asOf: new Date("2024-03-10T12:00:00.000Z"),
        timeZone: "UTC",
      }
    );

    expect(result.buckets.map((bucket) => bucket.date)).toEqual([
      "2024-02-28",
      "2024-02-29",
      "2024-03-01",
    ]);
  });

  it("接受三十天并拒绝三十一天、反向、未来和非法 Gregorian 日期", () => {
    const options = {
      asOf: new Date("2026-08-09T10:15:30.000Z"),
      timeZone: SHANGHAI,
    };

    expect(
      resolveDataDashboardRange(
        { startDate: "2026-07-11", endDate: "2026-08-09" },
        options
      ).bucketCount
    ).toBe(30);
    expect(() =>
      resolveDataDashboardRange(
        { startDate: "2026-07-10", endDate: "2026-08-09" },
        options
      )
    ).toThrowError(/30/);
    expect(() =>
      resolveDataDashboardRange(
        { startDate: "2026-08-09", endDate: "2026-08-08" },
        options
      )
    ).toThrowError(/早于|顺序/);
    expect(() =>
      resolveDataDashboardRange(
        { startDate: "2026-08-09", endDate: "2026-08-10" },
        options
      )
    ).toThrowError(/未来/);
    expect(() =>
      resolveDataDashboardRange(
        { startDate: "2026-02-29", endDate: "2026-03-01" },
        options
      )
    ).toThrowError(/日期范围无效/);
  });

  it("拒绝单边日期、未知字段、非法时区和非法 asOf", () => {
    const options = {
      asOf: new Date("2026-08-09T10:15:30.000Z"),
      timeZone: SHANGHAI,
    };

    expect(() =>
      resolveDataDashboardRange({ startDate: "2026-08-01" }, options)
    ).toThrowError(/日期范围无效/);
    expect(() =>
      resolveDataDashboardRange(
        { startDate: "2026-08-01", endDate: "2026-08-09", userId: "x" },
        options
      )
    ).toThrowError(/日期范围无效/);
    expect(() =>
      resolveDataDashboardRange({}, { ...options, timeZone: "UTC+8" })
    ).toThrowError(/时区/);
    expect(() =>
      resolveDataDashboardRange({}, { ...options, asOf: new Date(Number.NaN) })
    ).toThrowError(/查询时间/);
  });
});
