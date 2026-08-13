/**
 * 运营总览完整 series 与稀疏填充测试。
 *
 * 使用方：Vitest。验证日周月完整桶、epoch 前状态、真实零值、计数和小数积分的
 * 精确保留，以及重复、范围外和非法数值不会被静默吞掉。
 */
import { describe, expect, it } from "vitest";

import { resolveOperationsDashboardRange } from "./range";
import {
  downsampleOperationsSeries,
  fillOperationsCountSeries,
  fillOperationsCreditSeries,
} from "./series";

/**
 * 构造跨 epoch 的四个日桶。
 *
 * @returns 两个 epoch 前桶与两个可用桶；无 I/O 副作用。
 */
function createBuckets() {
  return resolveOperationsDashboardRange(
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
  ).buckets;
}

describe("operations series", () => {
  it("计数 series 保留完整桶、pre_epoch 和缺失可用桶的真实零值", () => {
    const buckets = createBuckets();
    const result = fillOperationsCountSeries(buckets, [
      { bucketKey: buckets[2]?.key ?? "", value: 7 },
    ]);

    expect(result.map((point) => point.status)).toEqual([
      "pre_epoch",
      "pre_epoch",
      "value",
      "value",
    ]);
    expect(result[2]).toMatchObject({ status: "value", value: 7 });
    expect(result[3]).toMatchObject({ status: "value", value: 0 });
    expect("value" in (result[0] ?? {})).toBe(false);
  });

  it("积分 series 精确保留有限小数且不修改输入", () => {
    const buckets = createBuckets();
    const points = [{ bucketKey: buckets[3]?.key ?? "", value: 12.34 }];
    const original = structuredClone(points);
    const result = fillOperationsCreditSeries(buckets, points);

    expect(result[3]).toMatchObject({ status: "value", value: 12.34 });
    expect(points).toEqual(original);
  });

  it("周月粒度同样保留全部截断桶并以逻辑桶键填充", () => {
    for (const granularity of ["week", "month"] as const) {
      const buckets = resolveOperationsDashboardRange(
        {
          granularity,
          range: {
            kind: "custom",
            from: "2026-07-30",
            to: "2026-08-18",
          },
        },
        {
          asOf: new Date("2026-08-20T12:00:00.000Z"),
          epochDate: "2026-01-01",
          timeZone: "UTC",
        }
      ).buckets;
      const result = fillOperationsCountSeries(buckets, [
        { bucketKey: buckets[0]?.key ?? "", value: 3 },
      ]);

      expect(result).toHaveLength(buckets.length);
      expect(result[0]).toMatchObject({ status: "value", value: 3 });
      expect(result.at(-1)).toMatchObject({ status: "value", value: 0 });
    }
  });

  it("跨 epoch 桶保留 partial_epoch 可用性但作为真实值桶填充", () => {
    const buckets = resolveOperationsDashboardRange(
      {
        granularity: "month",
        range: {
          kind: "custom",
          from: "2026-07-01",
          to: "2026-07-31",
        },
      },
      {
        asOf: new Date("2026-08-20T12:00:00.000Z"),
        epochDate: "2026-07-15",
        timeZone: "UTC",
      }
    ).buckets;

    expect(fillOperationsCountSeries(buckets, [])).toEqual([
      expect.objectContaining({
        status: "value",
        availability: "partial_epoch",
        value: 0,
      }),
    ]);
  });

  it("拒绝重复、范围外、pre_epoch 点和非法计数", () => {
    const buckets = createBuckets();
    const availableKey = buckets[2]?.key ?? "";
    const preEpochKey = buckets[0]?.key ?? "";

    expect(() =>
      fillOperationsCountSeries(buckets, [
        { bucketKey: availableKey, value: 1 },
        { bucketKey: availableKey, value: 2 },
      ])
    ).toThrow(RangeError);
    expect(() =>
      fillOperationsCountSeries(buckets, [
        { bucketKey: "day:outside", value: 1 },
      ])
    ).toThrow(RangeError);
    expect(() =>
      fillOperationsCountSeries(buckets, [{ bucketKey: preEpochKey, value: 1 }])
    ).toThrow(RangeError);
    expect(() =>
      fillOperationsCountSeries(buckets, [
        { bucketKey: availableKey, value: 1.5 },
      ])
    ).toThrow(RangeError);
  });

  it("拒绝非有限积分但允许负向有限净值", () => {
    const buckets = createBuckets();
    const availableKey = buckets[2]?.key ?? "";

    expect(() =>
      fillOperationsCreditSeries(buckets, [
        { bucketKey: availableKey, value: Number.POSITIVE_INFINITY },
      ])
    ).toThrow(RangeError);
    expect(
      fillOperationsCreditSeries(buckets, [
        { bucketKey: availableKey, value: -0.25 },
      ])[2]
    ).toMatchObject({ status: "value", value: -0.25 });
  });

  it("确定性降采样保留首末、最小值和最大值且不修改原数组", () => {
    const buckets = resolveOperationsDashboardRange(
      {
        range: {
          kind: "custom",
          from: "2026-08-01",
          to: "2026-08-10",
        },
      },
      {
        asOf: new Date("2026-08-20T12:00:00.000Z"),
        epochDate: "2026-08-01",
        timeZone: "UTC",
      }
    ).buckets;
    const series = fillOperationsCreditSeries(
      buckets,
      [2, 4, -9, 3, 8, 1, 20, 6, 5, 7].map((value, index) => ({
        bucketKey: buckets[index]?.key ?? "",
        value,
      }))
    );
    const original = structuredClone(series);

    const first = downsampleOperationsSeries(series, 6);
    const second = downsampleOperationsSeries(series, 6);

    expect(first).toEqual(second);
    expect(first).toHaveLength(6);
    expect(first.map(({ index }) => index)).toEqual(
      expect.arrayContaining([0, 2, 6, 9])
    );
    expect(first.map(({ index }) => index)).toEqual(
      [...first.map(({ index }) => index)].sort((left, right) => left - right)
    );
    expect(series).toEqual(original);
  });

  it("短序列原样返回并拒绝不足以保留极值的点数上限", () => {
    const series = fillOperationsCountSeries(createBuckets(), []);

    expect(downsampleOperationsSeries(series, 4)).toHaveLength(4);
    expect(() => downsampleOperationsSeries(series, 3)).toThrow(RangeError);
  });
});
