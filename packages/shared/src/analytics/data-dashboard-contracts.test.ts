/**
 * 用户数据看板 strict 输入输出契约测试。
 *
 * 使用方：Vitest；验证身份字段隔离、六项指标、逐日桶、成功率和跨字段 invariant，
 * 确保损坏或口径漂移的聚合结果不能静默进入 Web 或 Agent 使用方。
 */
import { describe, expect, it } from "vitest";

import {
  DATA_DASHBOARD_DEFAULT_DAYS,
  DATA_DASHBOARD_MAX_DAYS,
  type DataDashboardOutput,
  dataDashboardInputSchema,
  dataDashboardOutputSchema,
} from "./data-dashboard-contracts";
import { resolveDataDashboardRange } from "./data-dashboard-range";

/**
 * 创建一个包含多图片任务、视频任务和失败任务的合法看板快照。
 *
 * @returns 通过输出 schema 的固定快照；无 I/O 或数据库副作用。
 */
function createValidDashboardOutput(): DataDashboardOutput {
  const range = resolveDataDashboardRange(
    { startDate: "2026-08-03", endDate: "2026-08-09" },
    {
      asOf: new Date("2026-08-09T10:15:30.000Z"),
      timeZone: "Asia/Shanghai",
    }
  );
  const buckets = range.buckets.map((bucket, index) => ({
    date: bucket.date,
    start: bucket.start.toISOString(),
    end: bucket.end.toISOString(),
    imageCount: index === 0 ? 4 : 0,
    imageTaskCount: index === 0 ? 1 : 0,
    videoCount: index === 0 ? 1 : 0,
    videoSeconds: index === 0 ? 5 : 0,
    creditsConsumed: index === 0 ? 60 : 0,
  }));

  return {
    asOf: range.asOf.toISOString(),
    timeZone: range.timeZone,
    today: range.today,
    range: {
      startDate: range.startDate,
      endDate: range.endDate,
      start: range.start.toISOString(),
      end: range.end.toISOString(),
    },
    metrics: {
      imageCount: 4,
      videoSeconds: 5,
      creditsConsumed: 60,
      successRate: {
        succeeded: 2,
        failed: 1,
        terminal: 3,
        rate: 2 / 3,
      },
      activeDays: 1,
      mostUsedModel: { model: "gpt-image-1", taskCount: 1 },
    },
    buckets,
    taskComposition: {
      imageTaskCount: 1,
      videoCount: 1,
      totalTasks: 2,
    },
  };
}

describe("dataDashboardInputSchema", () => {
  it("公开默认七天和最大三十天常量供 Web 选择器复用", () => {
    expect(DATA_DASHBOARD_DEFAULT_DAYS).toBe(7);
    expect(DATA_DASHBOARD_MAX_DAYS).toBe(30);
  });

  it("只接受空对象或成对日期并严格拒绝调用方身份与旧趋势字段", () => {
    expect(dataDashboardInputSchema.safeParse({}).success).toBe(true);
    expect(
      dataDashboardInputSchema.safeParse({
        startDate: "2026-08-03",
        endDate: "2026-08-09",
      }).success
    ).toBe(true);

    for (const input of [
      { startDate: "2026-08-03" },
      { endDate: "2026-08-09" },
      { userId: "another-user" },
      { accountId: "another-account" },
      { granularity: "day" },
      { metric: "imageCount" },
      { startDate: "2026-02-29", endDate: "2026-03-01" },
    ]) {
      expect(dataDashboardInputSchema.safeParse(input).success).toBe(false);
    }
  });
});

describe("dataDashboardOutputSchema", () => {
  it("接受六项指标、连续逐日桶和任务构成一致的合法快照", () => {
    const output = createValidDashboardOutput();

    expect(dataDashboardOutputSchema.parse(output)).toEqual(output);
    expect(
      dataDashboardOutputSchema.safeParse({
        ...output,
        userId: "another-user",
      }).success
    ).toBe(false);
    expect(
      dataDashboardOutputSchema.safeParse({
        ...output,
        metrics: { ...output.metrics, rawRows: ["internal"] },
      }).success
    ).toBe(false);
  });

  it("拒绝与同一 asOf 和账号时区不一致的 today", () => {
    const output = createValidDashboardOutput();

    expect(
      dataDashboardOutputSchema.safeParse({
        ...output,
        today: "2026-08-10",
      }).success
    ).toBe(false);
  });

  it("拒绝非有限或负积分以及图片任务数大于图片产物数", () => {
    const output = createValidDashboardOutput();

    expect(
      dataDashboardOutputSchema.safeParse({
        ...output,
        metrics: {
          ...output.metrics,
          creditsConsumed: Number.POSITIVE_INFINITY,
        },
      }).success
    ).toBe(false);
    expect(
      dataDashboardOutputSchema.safeParse({
        ...output,
        buckets: output.buckets.map((bucket, index) =>
          index === 0 ? { ...bucket, creditsConsumed: -1 } : bucket
        ),
      }).success
    ).toBe(false);
    expect(
      dataDashboardOutputSchema.safeParse({
        ...output,
        buckets: output.buckets.map((bucket, index) =>
          index === 0 ? { ...bucket, imageTaskCount: 5 } : bucket
        ),
      }).success
    ).toBe(false);
  });

  it("拒绝断裂日期、重叠边界和超过三十个桶", () => {
    const output = createValidDashboardOutput();
    const brokenDates = output.buckets.map((bucket, index) =>
      index === 1 ? { ...bucket, date: "2026-08-05" } : bucket
    );
    const overlapping = output.buckets.map((bucket, index) =>
      index === 1 ? { ...bucket, start: output.buckets[0]?.start } : bucket
    );
    const overLimit = Array.from({ length: 31 }, (_, index) => ({
      ...output.buckets[0],
      date: `2026-08-${String(index + 1).padStart(2, "0")}`,
    }));

    expect(
      dataDashboardOutputSchema.safeParse({ ...output, buckets: brokenDates })
        .success
    ).toBe(false);
    expect(
      dataDashboardOutputSchema.safeParse({ ...output, buckets: overlapping })
        .success
    ).toBe(false);
    expect(
      dataDashboardOutputSchema.safeParse({ ...output, buckets: overLimit })
        .success
    ).toBe(false);
  });

  it("拒绝总计、活跃天数或图片任务构成读取了错误桶字段", () => {
    const output = createValidDashboardOutput();

    expect(
      dataDashboardOutputSchema.safeParse({
        ...output,
        metrics: { ...output.metrics, imageCount: 1 },
      }).success
    ).toBe(false);
    expect(
      dataDashboardOutputSchema.safeParse({
        ...output,
        metrics: { ...output.metrics, activeDays: 2 },
      }).success
    ).toBe(false);
    expect(
      dataDashboardOutputSchema.safeParse({
        ...output,
        taskComposition: {
          imageTaskCount: 4,
          videoCount: 1,
          totalTasks: 5,
        },
      }).success
    ).toBe(false);
  });

  it("只允许成功率终态计数与 rate 保持一致", () => {
    const output = createValidDashboardOutput();

    expect(
      dataDashboardOutputSchema.safeParse({
        ...output,
        metrics: {
          ...output.metrics,
          successRate: {
            succeeded: 2,
            failed: 1,
            terminal: 4,
            rate: 0.5,
          },
        },
      }).success
    ).toBe(false);
    expect(
      dataDashboardOutputSchema.safeParse({
        ...output,
        metrics: {
          ...output.metrics,
          successRate: {
            succeeded: 2,
            failed: 1,
            terminal: 3,
            rate: null,
          },
        },
      }).success
    ).toBe(false);
  });

  it("分母为零时仅允许 null，只有失败任务时允许 rate 为零", () => {
    const output = createValidDashboardOutput();
    const emptyBuckets = output.buckets.map((bucket) => ({
      ...bucket,
      imageCount: 0,
      imageTaskCount: 0,
      videoCount: 0,
      videoSeconds: 0,
      creditsConsumed: 0,
    }));
    const emptyOutput = {
      ...output,
      metrics: {
        imageCount: 0,
        videoSeconds: 0,
        creditsConsumed: 0,
        successRate: { succeeded: 0, failed: 0, terminal: 0, rate: null },
        activeDays: 0,
        mostUsedModel: null,
      },
      buckets: emptyBuckets,
      taskComposition: { imageTaskCount: 0, videoCount: 0, totalTasks: 0 },
    };

    expect(dataDashboardOutputSchema.safeParse(emptyOutput).success).toBe(true);
    expect(
      dataDashboardOutputSchema.safeParse({
        ...emptyOutput,
        metrics: {
          ...emptyOutput.metrics,
          successRate: { succeeded: 0, failed: 0, terminal: 0, rate: 0 },
        },
      }).success
    ).toBe(false);
    expect(
      dataDashboardOutputSchema.safeParse({
        ...emptyOutput,
        metrics: {
          ...emptyOutput.metrics,
          successRate: { succeeded: 0, failed: 2, terminal: 2, rate: 0 },
        },
      }).success
    ).toBe(true);
  });
});
