/**
 * 运营总览系统健康只读适配器。
 *
 * 使用方：后续统一 overview service。适配器从同一数据库快照读取范围型
 * 任务质量与支付履约失败，并读取标记为 current 的队列和后端状态。
 */
import {
  generation,
  imageAsyncTask,
  imageBackendMember,
  paymentLifecycleEvent,
  paymentOrder,
  userOutputUsageEvent,
  videoGeneration,
} from "@repo/database/schema";
import {
  type CountComparison,
  compareCountValues,
  compareRateValues,
  type RateComparison,
} from "@repo/shared/operations-dashboard/comparison";
import type { OperationsRangeAvailability } from "@repo/shared/operations-dashboard/contracts";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";

import { extractExecuteRows } from "@/server/database-result";

import type { OperationsGrowthRangeQuery } from "./growth-repository";

/** 任务成功率和处理耗时的单期原始结果。 */
export type OperationsTaskHealthRow = {
  succeededTasks: number;
  failedTasks: number;
  durationSampleCount: number;
  averageDurationSeconds: number | null;
  p95DurationSeconds: number | null;
  successOverlapCount: number;
  invalidSuccessCount: number;
  invalidDurationCount: number;
};

/** 支付履约失败事件的单期结果。 */
export type OperationsFulfillmentFailureRow = {
  attemptFailures: number;
  terminalFailures: number;
};

/** 数据库当前的异步媒体队列积压。 */
export type OperationsQueueBacklogRow = {
  imageQueued: number;
  imageRunning: number;
  videoPending: number;
};

/** 当前后端成员健康分组。 */
export type OperationsBackendHealthRow = {
  total: number;
  enabled: number;
  healthy: number;
  degraded: number;
  unhealthy: number;
  cooling: number;
  disabled: number;
};

/** 统一数据库事务内的系统健康读取端口。 */
export interface OperationsHealthSnapshotReader {
  readTaskHealth(
    input: OperationsGrowthRangeQuery
  ): Promise<OperationsTaskHealthRow>;
  readFulfillmentFailures(
    input: OperationsGrowthRangeQuery
  ): Promise<OperationsFulfillmentFailureRow>;
  readQueueBacklog(): Promise<OperationsQueueBacklogRow>;
  readBackendHealth(): Promise<OperationsBackendHealthRow>;
}

type ExecuteSql = (query: SQL) => Promise<unknown>;

const databaseCountSchema = z.coerce.number().int().safe().nonnegative();
const nullableDurationSchema = z
  .union([z.coerce.number().finite().nonnegative(), z.null()])
  .transform((value) => value ?? null);
const taskHealthRowSchema = z.object({
  succeeded_tasks: databaseCountSchema,
  failed_tasks: databaseCountSchema,
  duration_sample_count: databaseCountSchema,
  average_duration_seconds: nullableDurationSchema,
  p95_duration_seconds: nullableDurationSchema,
  success_overlap_count: databaseCountSchema,
  invalid_success_count: databaseCountSchema,
  invalid_duration_count: databaseCountSchema,
});
const fulfillmentFailureRowSchema = z.object({
  attempt_failures: databaseCountSchema,
  terminal_failures: databaseCountSchema,
});
const queueBacklogRowSchema = z.object({
  image_queued: databaseCountSchema,
  image_running: databaseCountSchema,
  video_pending: databaseCountSchema,
});
const backendHealthRowSchema = z.object({
  total: databaseCountSchema,
  enabled: databaseCountSchema,
  healthy: databaseCountSchema,
  degraded: databaseCountSchema,
  unhealthy: databaseCountSchema,
  cooling: databaseCountSchema,
  disabled: databaseCountSchema,
});

/** 系统健康适配器的稳定错误。 */
export class OperationsHealthAdapterError extends Error {
  /** 创建不泄露 SQL 或数据库行的错误。 */
  constructor(
    readonly code: "invalid_data",
    message: string
  ) {
    super(message);
    this.name = "OperationsHealthAdapterError";
  }
}

/**
 * 构造范围内任务成功率与处理耗时 SQL。
 *
 * WHY：成功任务只由不可变产物事件证明；失败任务从权威任务行读取。
 * 额外不变量列用于拒绝成功/失败重叠、缺少任务或非法完成时间。
 */
export function buildOperationsTaskHealthSql(
  input: OperationsGrowthRangeQuery
): SQL {
  return sql`
    with successful_tasks as (
      select
        ${userOutputUsageEvent.outputKind}::text as output_kind,
        ${userOutputUsageEvent.sourceTaskId} as source_task_id,
        ${userOutputUsageEvent.userId} as user_id,
        case
          when ${userOutputUsageEvent.outputKind} = 'image'
            then ${generation.status}::text
          else ${videoGeneration.status}
        end as authority_status,
        case
          when ${userOutputUsageEvent.outputKind} = 'image'
            then ${generation.createdAt}
          else ${videoGeneration.createdAt}
        end as task_created_at,
        case
          when ${userOutputUsageEvent.outputKind} = 'image'
            then ${generation.completedAt}
          else ${videoGeneration.completedAt}
        end as task_completed_at
      from ${userOutputUsageEvent}
      left join ${generation}
        on ${userOutputUsageEvent.outputKind} = 'image'
        and ${generation.id} = ${userOutputUsageEvent.sourceTaskId}
        and ${generation.userId} = ${userOutputUsageEvent.userId}
      left join ${videoGeneration}
        on ${userOutputUsageEvent.outputKind} = 'video'
        and ${videoGeneration.id} = ${userOutputUsageEvent.sourceTaskId}
        and ${videoGeneration.userId} = ${userOutputUsageEvent.userId}
      where ${userOutputUsageEvent.operationCreatedAt} >= ${sql.param(
        input.start,
        userOutputUsageEvent.operationCreatedAt
      )}
        and ${userOutputUsageEvent.operationCreatedAt} < ${sql.param(
          input.end,
          userOutputUsageEvent.operationCreatedAt
        )}
    ), failed_tasks as (
      select 'image'::text as output_kind, ${generation.id} as source_task_id
      from ${generation}
      where ${generation.createdAt} >= ${sql.param(
        input.start,
        generation.createdAt
      )}
        and ${generation.createdAt} < ${sql.param(
          input.end,
          generation.createdAt
        )}
        and ${generation.status} = 'failed'
        and coalesce(
          nullif(lower(btrim(${generation.metadata}->>'mode')), ''),
          'generate'
        ) in ('generate', 'edit')
      union all
      select 'video'::text, ${videoGeneration.id}
      from ${videoGeneration}
      where ${videoGeneration.createdAt} >= ${sql.param(
        input.start,
        videoGeneration.createdAt
      )}
        and ${videoGeneration.createdAt} < ${sql.param(
          input.end,
          videoGeneration.createdAt
        )}
        and ${videoGeneration.status} = 'failed'
    ), duration_samples as (
      select extract(epoch from (task_completed_at - task_created_at)) as seconds
      from successful_tasks
      where authority_status = 'completed'
        and task_completed_at is not null
        and task_created_at is not null
        and task_completed_at >= task_created_at
    )
    select
      (select count(*) from successful_tasks) as succeeded_tasks,
      (select count(*) from failed_tasks) as failed_tasks,
      (select count(*) from duration_samples) as duration_sample_count,
      (select avg(seconds) from duration_samples) as average_duration_seconds,
      (select percentile_cont(0.95) within group (order by seconds)
        from duration_samples) as p95_duration_seconds,
      (
        select count(*)
        from successful_tasks
        join failed_tasks using (output_kind, source_task_id)
      ) as success_overlap_count,
      (
        select count(*)
        from successful_tasks
        where authority_status is null or authority_status <> 'completed'
      ) as invalid_success_count,
      (
        select count(*)
        from successful_tasks
        where task_created_at is null
          or task_completed_at is null
          or task_completed_at < task_created_at
      ) as invalid_duration_count
  `;
}

/** 构造范围内支付履约失败事件 SQL。 */
export function buildOperationsFulfillmentFailuresSql(
  input: OperationsGrowthRangeQuery
): SQL {
  return sql`
    select
      count(*) filter (
        where ${paymentLifecycleEvent.eventType}
          = 'fulfillment_attempt_failed'
      ) as attempt_failures,
      count(*) filter (
        where ${paymentLifecycleEvent.eventType}
          = 'fulfillment_failed_terminal'
      ) as terminal_failures
    from ${paymentLifecycleEvent}
    join ${paymentOrder}
      on ${paymentOrder.id} = ${paymentLifecycleEvent.paymentOrderId}
    where ${paymentOrder.purpose} in ('credit_top_up', 'credit_package')
      and ${paymentLifecycleEvent.eventType} in (
        'fulfillment_attempt_failed',
        'fulfillment_failed_terminal'
      )
      and ${paymentLifecycleEvent.occurredAt} >= ${sql.param(
        input.start,
        paymentLifecycleEvent.occurredAt
      )}
      and ${paymentLifecycleEvent.occurredAt} < ${sql.param(
        input.end,
        paymentLifecycleEvent.occurredAt
      )}
  `;
}

/** 构造当前图片和视频持久队列积压 SQL。 */
export function buildOperationsQueueBacklogSql(): SQL {
  return sql`
    select
      (select count(*) from ${imageAsyncTask}
        where ${imageAsyncTask.status} = 'queued') as image_queued,
      (select count(*) from ${imageAsyncTask}
        where ${imageAsyncTask.status} = 'running') as image_running,
      (select count(*) from ${videoGeneration}
        where ${videoGeneration.stage} not in ('completed', 'failed'))
        as video_pending
    where exists (
      select 1 from ${imageAsyncTask}
      where ${imageAsyncTask.status} in ('queued', 'running')
    ) or true
  `;
}

/** 构造当前媒体后端成员健康分组 SQL。 */
export function buildOperationsBackendHealthSql(): SQL {
  return sql`
    select
      count(*) as total,
      count(*) filter (where ${imageBackendMember.isEnabled}) as enabled,
      count(*) filter (
        where ${imageBackendMember.isEnabled}
          and ${imageBackendMember.healthStatus} = 'healthy'
          and ${imageBackendMember.status} = 'active'
          and (
            ${imageBackendMember.cooldownUntil} is null
            or ${imageBackendMember.cooldownUntil} <= transaction_timestamp()
          )
      ) as healthy,
      count(*) filter (
        where ${imageBackendMember.isEnabled}
          and ${imageBackendMember.healthStatus} = 'degraded'
      ) as degraded,
      count(*) filter (
        where ${imageBackendMember.isEnabled}
          and ${imageBackendMember.healthStatus} = 'unhealthy'
      ) as unhealthy,
      count(*) filter (
        where ${imageBackendMember.isEnabled}
          and ${imageBackendMember.cooldownUntil} > transaction_timestamp()
      ) as cooling,
      count(*) filter (where not ${imageBackendMember.isEnabled}) as disabled
    from ${imageBackendMember}
  `;
}

/** 从 execute 绑定一个系统健康 reader。 */
export function createOperationsHealthSnapshotReader(
  execute: ExecuteSql
): OperationsHealthSnapshotReader {
  return {
    async readTaskHealth(input) {
      const row = taskHealthRowSchema.parse(
        extractExecuteRows(
          await execute(buildOperationsTaskHealthSql(input))
        )[0]
      );
      return {
        succeededTasks: row.succeeded_tasks,
        failedTasks: row.failed_tasks,
        durationSampleCount: row.duration_sample_count,
        averageDurationSeconds: row.average_duration_seconds,
        p95DurationSeconds: row.p95_duration_seconds,
        successOverlapCount: row.success_overlap_count,
        invalidSuccessCount: row.invalid_success_count,
        invalidDurationCount: row.invalid_duration_count,
      };
    },
    async readFulfillmentFailures(input) {
      const row = fulfillmentFailureRowSchema.parse(
        extractExecuteRows(
          await execute(buildOperationsFulfillmentFailuresSql(input))
        )[0]
      );
      return {
        attemptFailures: row.attempt_failures,
        terminalFailures: row.terminal_failures,
      };
    },
    async readQueueBacklog() {
      const row = queueBacklogRowSchema.parse(
        extractExecuteRows(await execute(buildOperationsQueueBacklogSql()))[0]
      );
      return {
        imageQueued: row.image_queued,
        imageRunning: row.image_running,
        videoPending: row.video_pending,
      };
    },
    async readBackendHealth() {
      const row = backendHealthRowSchema.parse(
        extractExecuteRows(await execute(buildOperationsBackendHealthSql()))[0]
      );
      return {
        total: row.total,
        enabled: row.enabled,
        healthy: row.healthy,
        degraded: row.degraded,
        unhealthy: row.unhealthy,
        cooling: row.cooling,
        disabled: row.disabled,
      };
    },
  };
}

/** 单期成功率值；无终态样本时显式返回 no_data。 */
export type OperationsTaskSuccessRateValue =
  | {
      status: "value";
      succeededTasks: number;
      failedTasks: number;
      rate: number;
    }
  | {
      status: "no_data" | "pre_epoch";
      succeededTasks: 0;
      failedTasks: 0;
      rate: null;
    };

/** 单期处理耗时；无成功样本时显式返回 no_data。 */
export type OperationsProcessingDurationValue =
  | {
      status: "value";
      sampleCount: number;
      averageSeconds: number;
      p95Seconds: number;
    }
  | {
      status: "no_data" | "pre_epoch";
      sampleCount: 0;
      averageSeconds: null;
      p95Seconds: null;
    };

/** 运营总览的完整系统健康快照。 */
export type OperationsSystemHealthSnapshot = {
  taskSuccessRate: {
    current: OperationsTaskSuccessRateValue;
    previous: OperationsTaskSuccessRateValue;
    comparison:
      | RateComparison
      | { status: "not_comparable"; reason: "no_data" | "pre_epoch" };
  };
  processingDuration: {
    current: OperationsProcessingDurationValue;
    previous: OperationsProcessingDurationValue;
  };
  fulfillmentFailures: {
    status: "value" | "pre_epoch";
    current: OperationsFulfillmentFailureRow & { total: number };
    previous: OperationsFulfillmentFailureRow & { total: number };
    comparison: CountComparison;
  };
  queueBacklog: OperationsQueueBacklogRow & {
    status: "current";
    total: number;
  };
  backendHealth: OperationsBackendHealthRow & { status: "current" };
};

/** 检验任务健康原始行的不变量。 */
function validateTaskHealth(row: OperationsTaskHealthRow): void {
  if (
    row.successOverlapCount !== 0 ||
    row.invalidSuccessCount !== 0 ||
    row.invalidDurationCount !== 0 ||
    row.durationSampleCount !== row.succeededTasks
  ) {
    throw new OperationsHealthAdapterError(
      "invalid_data",
      "系统健康任务事实不一致"
    );
  }
}

/** 将单期原始行转成成功率特殊状态。 */
function toSuccessRateValue(
  row: OperationsTaskHealthRow,
  available: boolean
): OperationsTaskSuccessRateValue {
  if (!available) {
    return {
      status: "pre_epoch",
      succeededTasks: 0,
      failedTasks: 0,
      rate: null,
    };
  }
  const total = row.succeededTasks + row.failedTasks;
  if (total === 0) {
    return {
      status: "no_data",
      succeededTasks: 0,
      failedTasks: 0,
      rate: null,
    };
  }
  return {
    status: "value",
    succeededTasks: row.succeededTasks,
    failedTasks: row.failedTasks,
    rate: row.succeededTasks / total,
  };
}

/** 将单期原始行转成耗时特殊状态。 */
function toDurationValue(
  row: OperationsTaskHealthRow,
  available: boolean
): OperationsProcessingDurationValue {
  if (
    !available ||
    row.durationSampleCount === 0 ||
    row.averageDurationSeconds === null ||
    row.p95DurationSeconds === null
  ) {
    return {
      status: available ? "no_data" : "pre_epoch",
      sampleCount: 0,
      averageSeconds: null,
      p95Seconds: null,
    };
  }
  return {
    status: "value",
    sampleCount: row.durationSampleCount,
    averageSeconds: row.averageDurationSeconds,
    p95Seconds: row.p95DurationSeconds,
  };
}

/**
 * 从已绑定的 reader 组装系统健康快照。
 *
 * @sideEffects 只读 reader，不开启新事务也不执行处置。
 * @failure 事实不变量损坏时拒绝返回误导性健康数据。
 */
export async function buildOperationsSystemHealthSnapshot(input: {
  reader: OperationsHealthSnapshotReader;
  currentRange: OperationsGrowthRangeQuery;
  previousRange: OperationsGrowthRangeQuery;
  currentAvailable: boolean;
  previousAvailability: OperationsRangeAvailability;
}): Promise<OperationsSystemHealthSnapshot> {
  const emptyTaskHealth: OperationsTaskHealthRow = {
    succeededTasks: 0,
    failedTasks: 0,
    durationSampleCount: 0,
    averageDurationSeconds: null,
    p95DurationSeconds: null,
    successOverlapCount: 0,
    invalidSuccessCount: 0,
    invalidDurationCount: 0,
  };
  const readTaskHealth = (range: OperationsGrowthRangeQuery) =>
    range.start < range.end
      ? input.reader.readTaskHealth(range)
      : Promise.resolve(emptyTaskHealth);
  const emptyFailures = { attemptFailures: 0, terminalFailures: 0 };
  const readFailures = (range: OperationsGrowthRangeQuery) =>
    range.start < range.end
      ? input.reader.readFulfillmentFailures(range)
      : Promise.resolve(emptyFailures);
  const [
    currentTask,
    previousTask,
    currentFailures,
    previousFailures,
    queue,
    backend,
  ] = await Promise.all([
    readTaskHealth(input.currentRange),
    readTaskHealth(input.previousRange),
    readFailures(input.currentRange),
    readFailures(input.previousRange),
    input.reader.readQueueBacklog(),
    input.reader.readBackendHealth(),
  ]);
  validateTaskHealth(currentTask);
  validateTaskHealth(previousTask);
  const currentRate = toSuccessRateValue(currentTask, input.currentAvailable);
  const previousAvailable = input.previousAvailability === "available";
  const previousRate = toSuccessRateValue(previousTask, previousAvailable);
  const rateComparison =
    currentRate.status === "value" && previousRate.status === "value"
      ? compareRateValues({
          current: {
            numerator: currentRate.succeededTasks,
            denominator: currentRate.succeededTasks + currentRate.failedTasks,
          },
          previous: {
            numerator: previousRate.succeededTasks,
            denominator: previousRate.succeededTasks + previousRate.failedTasks,
          },
          previousAvailability: input.previousAvailability,
        })
      : {
          status: "not_comparable" as const,
          reason:
            currentRate.status === "pre_epoch" ||
            previousRate.status === "pre_epoch"
              ? ("pre_epoch" as const)
              : ("no_data" as const),
        };
  const currentFailureTotal =
    currentFailures.attemptFailures + currentFailures.terminalFailures;
  const previousFailureTotal =
    previousFailures.attemptFailures + previousFailures.terminalFailures;

  return {
    taskSuccessRate: {
      current: currentRate,
      previous: previousRate,
      comparison: rateComparison,
    },
    processingDuration: {
      current: toDurationValue(currentTask, input.currentAvailable),
      previous: toDurationValue(previousTask, previousAvailable),
    },
    fulfillmentFailures: {
      status: input.currentAvailable ? "value" : "pre_epoch",
      current: { ...currentFailures, total: currentFailureTotal },
      previous: { ...previousFailures, total: previousFailureTotal },
      comparison: compareCountValues({
        current: currentFailureTotal,
        previous: previousFailureTotal,
        previousAvailability: input.previousAvailability,
      }),
    },
    queueBacklog: {
      status: "current",
      ...queue,
      total: queue.imageQueued + queue.imageRunning + queue.videoPending,
    },
    backendHealth: { status: "current", ...backend },
  };
}
