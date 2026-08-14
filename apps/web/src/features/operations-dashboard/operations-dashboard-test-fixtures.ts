/**
 * 运营总览严格输出契约的 DB-free 测试夹具。
 *
 * 使用方：Web UOL binding 与页面装配测试。夹具通过共享输出类型编译，并用真实范围
 * 解析器生成日期边界，避免测试用空对象绕过生产 contract。
 */
import type {
  OperationsDetailOutput,
  OperationsOverviewOutput,
} from "@repo/shared/operations-dashboard/output-contracts";
import { resolveOperationsDashboardRange } from "@repo/shared/operations-dashboard/range";

const generatedAt = "2026-08-14T12:00:00.000Z";
const range = resolveOperationsDashboardRange(
  {
    granularity: "day",
    range: { kind: "custom", from: "2026-08-01", to: "2026-08-02" },
  },
  {
    timeZone: "Asia/Shanghai",
    asOf: new Date(generatedAt),
    epochDate: "2026-08-01",
  }
);
const countComparison = {
  status: "value" as const,
  current: 1,
  previous: 1,
  changePercent: 0,
};
const countMetric = {
  status: "value" as const,
  current: 1,
  previous: 1,
  comparison: countComparison,
};
const retentionValue = {
  status: "value" as const,
  cohortCount: 1,
  cohortSize: 1,
  retainedCount: 1,
  rate: 1,
};
const retentionMetric = {
  current: retentionValue,
  previous: retentionValue,
  comparison: {
    status: "value" as const,
    currentRate: 1,
    previousRate: 1,
    changePercentagePoints: 0,
  },
};
const series = range.buckets.map((bucket) => ({
  ...bucket,
  status: "value" as const,
  value: 1,
}));

/** 构造覆盖所有必填模块的合法 overview。 */
export function createOperationsOverviewFixture(): OperationsOverviewOutput {
  return {
    generatedAt,
    timeZone: "Asia/Shanghai",
    epoch: {
      appDate: "2026-08-01",
      startsAt: "2026-07-31T16:00:00.000Z",
    },
    schemaVersion: 1,
    range,
    growth: {
      generatedAt,
      range,
      metrics: {
        cumulativeUsers: countMetric,
        newUsers: countMetric,
        loginActiveUsers: countMetric,
        creationActiveUsers: countMetric,
        paymentActiveUsers: countMetric,
        d1Retention: retentionMetric,
        d7Retention: retentionMetric,
        d30Retention: retentionMetric,
      },
      series: {
        newUsers: series,
        loginActiveUsers: series,
        creationActiveUsers: series,
        paymentActiveUsers: series,
      },
      cohorts: [],
    },
    commercial: {
      generatedAt,
      range,
      lifecycle: {
        createdOrders: countMetric,
        pendingOrders: countMetric,
        paymentConfirmedOrders: countMetric,
        paidNotFulfilledOrders: countMetric,
        fulfilledOrders: countMetric,
        failedOrders: countMetric,
      },
      revenue: {
        status: "value",
        current: [{ currency: "CNY", amountMinor: 100 }],
        previous: [{ currency: "CNY", amountMinor: 100 }],
        comparison: [
          {
            status: "value",
            currency: "CNY",
            currentAmountMinor: 100,
            previousAmountMinor: 100,
            changePercent: 0,
          },
        ],
        disclaimer: "不含线下退款",
      },
      conversion: {
        fromCreation: {
          status: "value",
          current: { paidUsers: 1, activeUsers: 1, rate: 1 },
          previous: { paidUsers: 1, activeUsers: 1, rate: 1 },
          comparison: {
            status: "value",
            currentRate: 1,
            previousRate: 1,
            changePercentagePoints: 0,
          },
        },
        fromLogin: {
          status: "value",
          current: { paidUsers: 1, activeUsers: 1, rate: 1 },
          previous: { paidUsers: 1, activeUsers: 1, rate: 1 },
          comparison: {
            status: "value",
            currentRate: 1,
            previousRate: 1,
            changePercentagePoints: 0,
          },
        },
      },
    },
    content: {
      generatedAt,
      range,
      metrics: {
        imageCount: countMetric,
        videoCount: countMetric,
        videoSeconds: countMetric,
        netCredits: {
          status: "value",
          current: 1,
          previous: 1,
          comparison: {
            status: "value",
            current: 1,
            previous: 1,
            changePercent: 0,
          },
        },
      },
      series: {
        imageCount: series,
        videoCount: series,
        videoSeconds: series,
        netCredits: series,
      },
    },
    systemHealth: {
      taskSuccessRate: {
        current: {
          status: "value",
          succeededTasks: 1,
          failedTasks: 0,
          rate: 1,
        },
        previous: {
          status: "value",
          succeededTasks: 1,
          failedTasks: 0,
          rate: 1,
        },
        comparison: {
          status: "value",
          currentRate: 1,
          previousRate: 1,
          changePercentagePoints: 0,
        },
      },
      processingDuration: {
        current: {
          status: "value",
          sampleCount: 1,
          averageSeconds: 1,
          p95Seconds: 1,
        },
        previous: {
          status: "value",
          sampleCount: 1,
          averageSeconds: 1,
          p95Seconds: 1,
        },
      },
      fulfillmentFailures: {
        status: "value",
        current: { attemptFailures: 0, terminalFailures: 0, total: 0 },
        previous: { attemptFailures: 0, terminalFailures: 0, total: 0 },
        comparison: {
          status: "not_comparable",
          reason: "zero_previous",
          current: 0,
          previous: 0,
        },
      },
      queueBacklog: {
        status: "current",
        imageQueued: 0,
        imageRunning: 0,
        videoPending: 0,
        total: 0,
      },
      backendHealth: {
        status: "current",
        total: 0,
        enabled: 0,
        healthy: 0,
        degraded: 0,
        unhealthy: 0,
        cooling: 0,
        disabled: 0,
      },
    },
  };
}

/** 构造合法的新增用户明细页。 */
export function createOperationsDetailFixture(): OperationsDetailOutput {
  return {
    selection: { module: "growth", detail: "users" },
    range,
    rows: [],
    nextCursor: null,
  };
}
