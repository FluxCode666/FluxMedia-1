/**
 * 运营总览系统健康适配器 SQL 与结果组装测试。
 *
 * 不连接数据库；验证范围型指标的权威事实、当前队列及后端健康
 * 的 current 语义，并覆盖无样本和不可比较状态。
 */
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import {
  buildOperationsBackendHealthSql,
  buildOperationsFulfillmentFailuresSql,
  buildOperationsQueueBacklogSql,
  buildOperationsSystemHealthSnapshot,
  buildOperationsTaskHealthSql,
  type OperationsHealthSnapshotReader,
} from "./health-adapter";

const dialect = new PgDialect();
const range = {
  start: new Date("2026-08-01T00:00:00.000Z"),
  end: new Date("2026-08-08T00:00:00.000Z"),
};

/** 将 Drizzle SQL 编译为可检查文本。 */
function compile(query: Parameters<PgDialect["sqlToQuery"]>[0]) {
  return dialect.sqlToQuery(query).sql;
}

describe("operations health adapter SQL", () => {
  it("成功率与耗时由成功事件和失败权威任务构成", () => {
    const query = compile(buildOperationsTaskHealthSql(range));

    expect(query).toContain('from "user_output_usage_event"');
    expect(query).toContain('left join "generation"');
    expect(query).toContain('left join "video_generation"');
    expect(query).toContain('"generation"."status" = \'failed\'');
    expect(query).toContain("percentile_cont(0.95)");
    expect(query).toContain("success_overlap_count");
    expect(query).toContain("invalid_success_count");
    expect(query).toContain("invalid_duration_count");
  });

  it("支付履约失败按事件发生时间统计可恢复尝试和终态", () => {
    const query = compile(buildOperationsFulfillmentFailuresSql(range));

    expect(query).toContain('from "payment_lifecycle_event"');
    expect(query).toContain("= 'fulfillment_attempt_failed'");
    expect(query).toContain("= 'fulfillment_failed_terminal'");
    expect(query).toContain('"payment_lifecycle_event"."occurred_at" >=');
  });

  it("队列与后端只读当前持久状态", () => {
    const queueQuery = compile(buildOperationsQueueBacklogSql());
    const backendQuery = compile(buildOperationsBackendHealthSql());

    expect(queueQuery).toContain('from "image_async_task"');
    expect(queueQuery).toContain('from "video_generation"');
    expect(queueQuery).toContain("in ('queued', 'running')");
    expect(queueQuery).toContain("not in ('completed', 'failed')");
    expect(backendQuery).toContain('from "image_backend_member"');
    expect(backendQuery).toContain("\"health_status\" = 'healthy'");
  });
});

describe("operations system health snapshot", () => {
  it("返回范围型成功率、平均与 p95 耗时及 current 摘要", async () => {
    const reader: OperationsHealthSnapshotReader = {
      readTaskHealth: vi.fn().mockResolvedValue({
        succeededTasks: 8,
        failedTasks: 2,
        durationSampleCount: 8,
        averageDurationSeconds: 12.5,
        p95DurationSeconds: 20,
        successOverlapCount: 0,
        invalidSuccessCount: 0,
        invalidDurationCount: 0,
      }),
      readFulfillmentFailures: vi.fn().mockResolvedValue({
        attemptFailures: 3,
        terminalFailures: 1,
      }),
      readQueueBacklog: vi.fn().mockResolvedValue({
        imageQueued: 2,
        imageRunning: 1,
        videoPending: 4,
      }),
      readBackendHealth: vi.fn().mockResolvedValue({
        total: 5,
        enabled: 4,
        healthy: 3,
        degraded: 1,
        unhealthy: 0,
        cooling: 1,
        disabled: 1,
      }),
    };

    const snapshot = await buildOperationsSystemHealthSnapshot({
      reader,
      currentRange: range,
      previousRange: {
        start: new Date("2026-07-25T00:00:00.000Z"),
        end: new Date("2026-08-01T00:00:00.000Z"),
      },
      currentAvailable: true,
      previousAvailability: "available",
    });

    expect(snapshot.taskSuccessRate.current).toMatchObject({
      succeededTasks: 8,
      failedTasks: 2,
      rate: 0.8,
    });
    expect(snapshot.processingDuration.current).toEqual({
      status: "value",
      sampleCount: 8,
      averageSeconds: 12.5,
      p95Seconds: 20,
    });
    expect(snapshot.fulfillmentFailures.current.total).toBe(4);
    expect(snapshot.queueBacklog).toMatchObject({
      status: "current",
      total: 7,
    });
    expect(snapshot.backendHealth.status).toBe("current");
    expect(reader.readTaskHealth).toHaveBeenCalledTimes(2);
  });

  it("无终态任务样本时不将成功率伪装为零", async () => {
    const reader: OperationsHealthSnapshotReader = {
      readTaskHealth: vi.fn().mockResolvedValue({
        succeededTasks: 0,
        failedTasks: 0,
        durationSampleCount: 0,
        averageDurationSeconds: null,
        p95DurationSeconds: null,
        successOverlapCount: 0,
        invalidSuccessCount: 0,
        invalidDurationCount: 0,
      }),
      readFulfillmentFailures: vi.fn().mockResolvedValue({
        attemptFailures: 0,
        terminalFailures: 0,
      }),
      readQueueBacklog: vi.fn().mockResolvedValue({
        imageQueued: 0,
        imageRunning: 0,
        videoPending: 0,
      }),
      readBackendHealth: vi.fn().mockResolvedValue({
        total: 0,
        enabled: 0,
        healthy: 0,
        degraded: 0,
        unhealthy: 0,
        cooling: 0,
        disabled: 0,
      }),
    };

    const snapshot = await buildOperationsSystemHealthSnapshot({
      reader,
      currentRange: range,
      previousRange: range,
      currentAvailable: true,
      previousAvailability: "available",
    });

    expect(snapshot.taskSuccessRate.current.status).toBe("no_data");
    expect(snapshot.processingDuration.current.status).toBe("no_data");
  });

  it("对事实重叠或非法耗时显式失败", async () => {
    const reader: OperationsHealthSnapshotReader = {
      readTaskHealth: vi.fn().mockResolvedValue({
        succeededTasks: 1,
        failedTasks: 1,
        durationSampleCount: 1,
        averageDurationSeconds: 1,
        p95DurationSeconds: 1,
        successOverlapCount: 1,
        invalidSuccessCount: 0,
        invalidDurationCount: 0,
      }),
      readFulfillmentFailures: vi.fn().mockResolvedValue({
        attemptFailures: 0,
        terminalFailures: 0,
      }),
      readQueueBacklog: vi.fn().mockResolvedValue({
        imageQueued: 0,
        imageRunning: 0,
        videoPending: 0,
      }),
      readBackendHealth: vi.fn().mockResolvedValue({
        total: 0,
        enabled: 0,
        healthy: 0,
        degraded: 0,
        unhealthy: 0,
        cooling: 0,
        disabled: 0,
      }),
    };

    await expect(
      buildOperationsSystemHealthSnapshot({
        reader,
        currentRange: range,
        previousRange: range,
        currentAvailable: true,
        previousAvailability: "available",
      })
    ).rejects.toMatchObject({ code: "invalid_data" });
  });
});
