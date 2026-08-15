/**
 * 运营总览比较和留存纯函数测试。
 *
 * 使用方：Vitest。锁定数量百分比、比率百分点、多币种金额、epoch 不可比较和
 * D1/D7/D30 成熟状态及加权汇总，不允许零分母变成零、无穷或误导性百分比。
 */
import { describe, expect, it } from "vitest";

import {
  compareCountValues,
  compareCurrencyAmounts,
  compareRateValues,
  resolveCohortRetention,
  summarizeWeightedRetention,
} from "./comparison";

describe("metric comparisons", () => {
  it("数量按上一周期计算百分比变化", () => {
    expect(compareCountValues({ current: 120, previous: 100 })).toEqual({
      status: "value",
      current: 120,
      previous: 100,
      changePercent: 20,
    });
    expect(compareCountValues({ current: 50, previous: 100 })).toEqual({
      status: "value",
      current: 50,
      previous: 100,
      changePercent: -50,
    });
  });

  it("上期为零或上期包含 epoch 前日期时不可比较", () => {
    expect(compareCountValues({ current: 10, previous: 0 })).toMatchObject({
      status: "not_comparable",
      reason: "zero_previous",
    });
    expect(
      compareCountValues({
        current: 10,
        previous: 5,
        previousAvailability: "pre_epoch",
      })
    ).toMatchObject({
      status: "not_comparable",
      reason: "pre_epoch",
    });
    expect(
      compareCountValues({
        current: 10,
        previous: 5,
        previousAvailability: "partial_epoch",
      })
    ).toMatchObject({
      status: "not_comparable",
      reason: "pre_epoch",
    });
  });

  it("比率使用百分点变化并显式处理当前或上期零分母", () => {
    expect(
      compareRateValues({
        current: { numerator: 3, denominator: 4 },
        previous: { numerator: 1, denominator: 2 },
      })
    ).toEqual({
      status: "value",
      currentRate: 0.75,
      previousRate: 0.5,
      changePercentagePoints: 25,
    });
    expect(
      compareRateValues({
        current: { numerator: 0, denominator: 0 },
        previous: { numerator: 1, denominator: 2 },
      })
    ).toMatchObject({
      status: "not_comparable",
      reason: "zero_current_denominator",
    });
    expect(
      compareRateValues({
        current: { numerator: 1, denominator: 2 },
        previous: { numerator: 0, denominator: 0 },
      })
    ).toMatchObject({
      status: "not_comparable",
      reason: "zero_previous_denominator",
    });
  });

  it("金额按币种稳定排序并独立比较", () => {
    expect(
      compareCurrencyAmounts({
        current: [
          { currency: "USD", amountMinor: 300 },
          { currency: "CNY", amountMinor: 200 },
        ],
        previous: [
          { currency: "CNY", amountMinor: 100 },
          { currency: "EUR", amountMinor: 500 },
        ],
      })
    ).toEqual([
      {
        status: "value",
        currency: "CNY",
        currentAmountMinor: 200,
        previousAmountMinor: 100,
        changePercent: 100,
      },
      {
        status: "value",
        currency: "EUR",
        currentAmountMinor: 0,
        previousAmountMinor: 500,
        changePercent: -100,
      },
      {
        status: "not_comparable",
        reason: "zero_previous",
        currency: "USD",
        currentAmountMinor: 300,
        previousAmountMinor: 0,
      },
    ]);
  });
});

describe("cohort retention", () => {
  it("精确判断 D1 成熟、D7 未成熟和 epoch 前 cohort", () => {
    expect(
      resolveCohortRetention({
        cohortDate: "2026-08-01",
        cohortSize: 10,
        epochDate: "2026-08-01",
        retainedCount: 4,
        retentionDay: 1,
        asOfDate: "2026-08-02",
      })
    ).toEqual({
      status: "value",
      cohortDate: "2026-08-01",
      cohortSize: 10,
      retainedCount: 4,
      retentionDay: 1,
      maturityDate: "2026-08-02",
      rate: 0.4,
    });
    expect(
      resolveCohortRetention({
        cohortDate: "2026-08-01",
        cohortSize: 10,
        epochDate: "2026-08-01",
        retainedCount: 0,
        retentionDay: 7,
        asOfDate: "2026-08-02",
      })
    ).toMatchObject({ status: "immature", maturityDate: "2026-08-08" });
    expect(
      resolveCohortRetention({
        cohortDate: "2026-07-31",
        cohortSize: 10,
        epochDate: "2026-08-01",
        retainedCount: 0,
        retentionDay: 1,
        asOfDate: "2026-08-02",
      })
    ).toMatchObject({ status: "pre_epoch" });
  });

  it("留存成熟由查询 asOf 决定，不受注册筛选范围结束日裁剪", () => {
    expect(
      resolveCohortRetention({
        cohortDate: "2026-08-01",
        cohortSize: 10,
        epochDate: "2026-08-01",
        retainedCount: 2,
        retentionDay: 7,
        asOfDate: "2026-08-20",
      })
    ).toMatchObject({
      status: "value",
      maturityDate: "2026-08-08",
      rate: 0.2,
    });
  });

  it("按成熟 cohort 的人数加权汇总并排除未成熟项", () => {
    const matureOne = resolveCohortRetention({
      cohortDate: "2026-08-01",
      cohortSize: 10,
      epochDate: "2026-08-01",
      retainedCount: 5,
      retentionDay: 1,
      asOfDate: "2026-08-10",
    });
    const matureTwo = resolveCohortRetention({
      cohortDate: "2026-08-02",
      cohortSize: 30,
      epochDate: "2026-08-01",
      retainedCount: 3,
      retentionDay: 1,
      asOfDate: "2026-08-10",
    });
    const immature = resolveCohortRetention({
      cohortDate: "2026-08-09",
      cohortSize: 100,
      epochDate: "2026-08-01",
      retainedCount: 0,
      retentionDay: 7,
      asOfDate: "2026-08-10",
    });

    expect(
      summarizeWeightedRetention([matureOne, matureTwo, immature])
    ).toEqual({
      status: "value",
      cohortCount: 2,
      cohortSize: 40,
      retainedCount: 8,
      rate: 0.2,
    });
  });

  it("没有成熟 cohort 时返回 immature，全为 epoch 前时返回 pre_epoch", () => {
    const immature = resolveCohortRetention({
      cohortDate: "2026-08-10",
      cohortSize: 10,
      epochDate: "2026-08-01",
      retainedCount: 0,
      retentionDay: 7,
      asOfDate: "2026-08-10",
    });
    const preEpoch = resolveCohortRetention({
      cohortDate: "2026-07-01",
      cohortSize: 10,
      epochDate: "2026-08-01",
      retainedCount: 0,
      retentionDay: 1,
      asOfDate: "2026-08-10",
    });

    expect(summarizeWeightedRetention([immature])).toEqual({
      status: "immature",
    });
    expect(summarizeWeightedRetention([])).toEqual({ status: "immature" });
    expect(summarizeWeightedRetention([preEpoch])).toEqual({
      status: "pre_epoch",
    });
  });

  it("拒绝 retainedCount 大于 cohortSize", () => {
    expect(() =>
      resolveCohortRetention({
        cohortDate: "2026-08-01",
        cohortSize: 10,
        epochDate: "2026-08-01",
        retainedCount: 11,
        retentionDay: 1,
        asOfDate: "2026-08-10",
      })
    ).toThrow(RangeError);
  });
});
