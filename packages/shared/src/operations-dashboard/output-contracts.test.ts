/**
 * 运营总览 UOL 输出契约回归测试。
 *
 * 使用方：共享包 Vitest。锁定 overview 必填模块、字段类型和 detail selection 与
 * 行类型一致性，避免宽泛 record 让损坏数据穿过统一接口层。
 */
import {
  operationsDetailOutputSchema,
  operationsOpenLocalExportDownloadOutputSchema,
  operationsOverviewOutputSchema,
} from "@repo/shared/operations-dashboard/output-contracts";
import { describe, expect, it } from "vitest";

import { resolveOperationsDashboardRange } from "./range";

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

/** 构造覆盖四个模块的最小合法 overview。 */
function createOverview() {
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

describe("operations dashboard output contracts", () => {
  it("拒绝 overview 缺失模块字段或包含错误类型", () => {
    const valid = createOverview();
    expect(operationsOverviewOutputSchema.safeParse(valid).success).toBe(true);

    const missingMetric = structuredClone(valid);
    Reflect.deleteProperty(missingMetric.growth.metrics, "newUsers");
    expect(
      operationsOverviewOutputSchema.safeParse(missingMetric).success
    ).toBe(false);

    const wrongType = structuredClone(valid);
    wrongType.content.metrics.imageCount.current = "1" as never;
    expect(operationsOverviewOutputSchema.safeParse(wrongType).success).toBe(
      false
    );
  });

  it("拒绝 detail selection 与行类型不匹配", () => {
    const growthPage = {
      selection: { module: "growth", detail: "users" },
      range,
      rows: [
        {
          userId: "user-1",
          name: "User",
          email: "user@example.com",
          role: "user",
          banned: false,
          businessTime: generatedAt,
          retained: null,
        },
      ],
      nextCursor: null,
    };
    expect(operationsDetailOutputSchema.safeParse(growthPage).success).toBe(
      true
    );
    expect(
      operationsDetailOutputSchema.safeParse({
        ...growthPage,
        selection: { module: "content", detail: "image_outputs" },
      }).success
    ).toBe(false);
  });

  it("允许已履约订单以无生命周期事件的订单行通过输出契约", () => {
    expect(
      operationsDetailOutputSchema.safeParse({
        selection: {
          module: "commercialization",
          detail: "fulfilled_orders",
        },
        range,
        rows: [
          {
            paymentOrderId: "order-1",
            providerTradeNo: "trade-1",
            userId: "user-1",
            currency: "CNY",
            amountMinor: 100,
            orderStatus: "fulfilled",
            createdAt: generatedAt,
            fulfilledAt: generatedAt,
            businessTime: generatedAt,
            eventType: null,
          },
        ],
        nextCursor: null,
      }).success
    ).toBe(true);
  });

  it("本地下载输出只接受安全文件名和异步字节流", () => {
    const stream = (async function* () {
      yield new Uint8Array([1]);
    })();
    expect(
      operationsOpenLocalExportDownloadOutputSchema.safeParse({
        taskId: "task-1",
        filename: "operations-user_growth-task-1.csv",
        contentType: "text/csv; charset=utf-8",
        stream,
      }).success
    ).toBe(true);
    expect(
      operationsOpenLocalExportDownloadOutputSchema.safeParse({
        taskId: "task-1",
        filename: "../secret.csv",
        contentType: "text/csv; charset=utf-8",
        stream: {},
      }).success
    ).toBe(false);
  });
});
