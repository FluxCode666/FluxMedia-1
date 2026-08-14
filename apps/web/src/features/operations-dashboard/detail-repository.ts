/**
 * 运营总览增长、商业化与内容生产明细 PostgreSQL 仓储。
 *
 * 使用方：后续 operations detail UOL 与 CSV worker。新增用户、三类活跃和
 * Cohort 明细与汇总仓储复用同一活跃事实构造器，并使用 business_time + user_id
 * 降序 keyset；完整邮箱仅能由后续 human-only 管理员 operation 暴露。
 */
import {
  creditUsageOperation,
  creditUsageProjectionEntry,
  generation,
  paymentLifecycleEvent,
  paymentOrder,
  user,
  userOutputUsageEvent,
  videoGeneration,
} from "@repo/database/schema";
import { type SQL, sql } from "drizzle-orm";

import { toOperationsDatabaseTimestamp } from "./database-timestamp";
import type {
  OperationsActivityDetailQuery,
  OperationsCohortDetailQuery,
  OperationsCohortExportDetailQuery,
  OperationsCommercialDetailQuery,
  OperationsContentDetailQuery,
  OperationsDetailCursor,
  OperationsDetailExecuteSql,
  OperationsDetailQuery,
  OperationsDetailRow,
  OperationsGrowthDetailPage,
  OperationsGrowthDetailQuery,
  OperationsGrowthDetailRepository,
  OperationsGrowthDetailRow,
  OperationsGrowthDetailSnapshotReader,
  OperationsGrowthDetailTransactionDatabase,
  OperationsNewUserDetailQuery,
} from "./detail-contracts";
export type {
  OperationsActivityDetailQuery,
  OperationsCohortDetailQuery,
  OperationsCohortExportDetailQuery,
  OperationsCommercialDetailQuery,
  OperationsCommercialDetailRow,
  OperationsContentDetailQuery,
  OperationsContentDetailRow,
  OperationsDetailCursor,
  OperationsDetailHighWatermarks,
  OperationsDetailQuery,
  OperationsDetailRepository,
  OperationsDetailRow,
  OperationsGrowthDetailCursor,
  OperationsGrowthDetailPage,
  OperationsGrowthDetailQuery,
  OperationsGrowthDetailRepository,
  OperationsGrowthDetailRow,
  OperationsGrowthDetailSnapshotReader,
  OperationsGrowthDetailTransactionDatabase,
  OperationsNewUserDetailQuery,
  OperationsOrderDetailQuery,
  OperationsPaymentLifecycleDetailQuery,
} from "./detail-contracts";
import {
  parseOperationsCommercialDetailRows,
  parseOperationsContentDetailRows,
  parseOperationsGrowthDetailRows,
} from "./detail-row-parsers";
import {
  buildOperationsActivitySourceSql,
  createOperationsGrowthSnapshotReader,
} from "./growth-repository";

/** 对内部明细查询进行资源与边界防御，避免导出 worker 误用无界读取。 */
function assertValidDetailQuery(input: OperationsDetailQuery): void {
  const validDates = [
    input.start,
    input.end,
    input.epochStart,
    input.asOf,
  ].every((value) => !Number.isNaN(value.getTime()));
  if (
    !validDates ||
    input.start >= input.end ||
    input.start < input.epochStart ||
    input.end > input.asOf ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 10_001
  ) {
    throw new RangeError("运营增长明细查询无效");
  }
  if (
    input.cursor &&
    (Number.isNaN(input.cursor.businessTime.getTime()) ||
      input.cursor.stableId.length === 0 ||
      input.cursor.stableId.length > 512)
  ) {
    throw new RangeError("运营增长明细游标无效");
  }
  if (
    input.kind === "cohort" &&
    (Number.isNaN(input.targetStart.getTime()) ||
      Number.isNaN(input.targetEnd.getTime()) ||
      input.targetStart >= input.targetEnd ||
      input.targetEnd > input.asOf)
  ) {
    throw new RangeError("Cohort 目标日范围无效");
  }
  if (
    input.kind === "cohort_export" &&
    (![1, 7, 30].includes(input.retentionDay) || !input.timeZone.trim())
  ) {
    throw new RangeError("Cohort 导出参数无效");
  }
}

/** 构造原始业务时间和主键上的降序 keyset 谓词。 */
function buildDetailKeysetPredicate(
  cursor: OperationsDetailCursor | null,
  businessTime: SQL,
  stableId: SQL
): SQL {
  if (!cursor) return sql`true`;
  return sql`(
    ${businessTime} < ${cursor.businessTime}
    or (
      ${businessTime} = ${cursor.businessTime}
      and ${stableId} < ${cursor.stableId}
    )
  )`;
}

/**
 * 将数据库微秒时间收敛到 API 游标可表达的毫秒排序键。
 *
 * WHY：JavaScript Date 无法保存 PostgreSQL 微秒。排序和 keyset 同时按毫秒截断后，
 * 同一毫秒内由 stable ID 完整打破平局，不会在下一页跳过剩余记录。
 */
function buildMillisecondDetailSortTime(value: SQL): SQL {
  return sql`date_trunc('milliseconds', ${value})`;
}

/** 返回可包含 Date 所代表整毫秒的排除式上界。 */
function nextMillisecond(value: Date): Date {
  return new Date(value.getTime() + 1);
}

/** 构造充值订单或不可变支付生命周期事件的商业化明细 SQL。 */
export function buildOperationsCommercialDetailSql(
  input: OperationsCommercialDetailQuery
): SQL {
  assertValidDetailQuery(input);
  const eventJoin =
    input.kind === "payment_lifecycle"
      ? sql`join ${paymentLifecycleEvent}
          on ${paymentLifecycleEvent.paymentOrderId} = ${paymentOrder.id}`
      : sql``;
  const businessTime =
    input.kind === "payment_lifecycle"
      ? sql`${paymentLifecycleEvent.occurredAt}`
      : sql`${paymentOrder.createdAt}`;
  const stableId =
    input.kind === "payment_lifecycle"
      ? sql`${paymentLifecycleEvent.id}`
      : sql`${paymentOrder.id}`;
  const sourceBound =
    input.kind === "payment_lifecycle"
      ? input.highWatermarks?.paymentLifecycle
        ? sql`and (${paymentLifecycleEvent.recordedAt}, ${paymentLifecycleEvent.id})
            <= (${toOperationsDatabaseTimestamp(
              input.highWatermarks.paymentLifecycle.recordedAt
            )}, ${input.highWatermarks.paymentLifecycle.id})`
        : input.highWatermarks
          ? sql`and false`
          : sql``
      : input.highWatermarks?.paymentOrders
        ? sql`and (${paymentOrder.createdAt}, ${paymentOrder.id})
            <= (${toOperationsDatabaseTimestamp(
              input.highWatermarks.paymentOrders.createdAt
            )}, ${input.highWatermarks.paymentOrders.id})`
        : input.highWatermarks
          ? sql`and false`
          : sql``;
  const sortTime = buildMillisecondDetailSortTime(
    sql`scoped_commercial.business_time`
  );
  const keyset = buildDetailKeysetPredicate(
    input.cursor,
    sortTime,
    sql`scoped_commercial.stable_id`
  );
  return sql`
    with scoped_commercial as (
      select
        ${input.kind}::text as kind,
        ${stableId} as stable_id,
        ${paymentOrder.id} as payment_order_id,
        ${paymentOrder.providerTradeNo} as provider_trade_no,
        ${paymentOrder.userId} as user_id,
        upper(${paymentOrder.currency}) as currency,
        ${paymentOrder.amountMinor} as amount_minor,
        ${paymentOrder.status} as order_status,
        ${paymentOrder.createdAt} as created_at,
        ${paymentOrder.fulfilledAt} as fulfilled_at,
        ${businessTime} as business_time,
        ${
          input.kind === "payment_lifecycle"
            ? sql`${paymentLifecycleEvent.eventType}`
            : sql`null::text`
        } as event_type
      from ${paymentOrder}
      ${eventJoin}
      where ${paymentOrder.purpose} in ('credit_top_up', 'credit_package')
        ${sourceBound}
        ${
          input.kind === "payment_lifecycle"
            ? sql`and ${paymentLifecycleEvent.eventType} in (
                'order_created',
                'checkout_ready',
                'payment_confirmed',
                'fulfillment_succeeded',
                'checkout_failed',
                'fulfillment_attempt_failed',
                'fulfillment_failed_terminal',
                'expired'
              )`
            : sql``
        }
    )
    select *
    from scoped_commercial
    where scoped_commercial.business_time >= ${input.start}
      and scoped_commercial.business_time < ${input.end}
      and scoped_commercial.business_time >= ${input.epochStart}
      and scoped_commercial.business_time < ${nextMillisecond(input.asOf)}
      and ${keyset}
    order by ${sortTime} desc,
      scoped_commercial.stable_id desc
    limit ${input.limit}
  `;
}

/**
 * 构造成功内容明细 SQL，并在同一行投影模型与净积分。
 *
 * WHY：积分严格匹配四个稳定身份字段；无 operation 是免费任务，净值为零；
 * 同主体、类型、任务 ID 但创建时间不同则标记漂移，服务层拒绝整页。
 */
export function buildOperationsContentDetailSql(
  input: OperationsContentDetailQuery
): SQL {
  assertValidDetailQuery(input);
  const mediaPredicate =
    input.detail === "image_outputs"
      ? sql`scoped_outputs.media_type = 'image'`
      : input.detail === "video_outputs"
        ? sql`scoped_outputs.media_type = 'video'`
        : sql`true`;
  const outputWatermark = input.highWatermarks?.outputs;
  const outputBound = outputWatermark
    ? sql`and (
        ${userOutputUsageEvent.createdAt},
        ${userOutputUsageEvent.outputKind}::text,
        ${userOutputUsageEvent.sourceTaskId}
      ) <= (
        ${toOperationsDatabaseTimestamp(outputWatermark.createdAt)},
        ${outputWatermark.outputKind},
        ${outputWatermark.sourceTaskId}
      )`
    : input.highWatermarks
      ? sql`and false`
      : sql``;
  const contributionWatermark = input.highWatermarks?.creditContributions;
  const contributionBound = contributionWatermark
    ? sql`where (
        ${creditUsageProjectionEntry.projectedAt},
        ${creditUsageProjectionEntry.transactionId}
      ) <= (
        ${toOperationsDatabaseTimestamp(contributionWatermark.projectedAt)},
        ${contributionWatermark.transactionId}
      )`
    : input.highWatermarks
      ? sql`where false`
      : sql``;
  const sortTime = buildMillisecondDetailSortTime(
    sql`scoped_outputs.business_time`
  );
  return sql`
    with scoped_outputs as (
      select
        concat(
          ${userOutputUsageEvent.outputKind}::text,
          ':',
          ${userOutputUsageEvent.sourceTaskId}
        ) as stable_id,
        ${userOutputUsageEvent.sourceTaskId} as task_id,
        ${userOutputUsageEvent.userId} as user_id,
        ${userOutputUsageEvent.outputKind}::text as media_type,
        ${userOutputUsageEvent.operationCreatedAt} as business_time,
        case
          when ${userOutputUsageEvent.outputKind} = 'image'
            then ${userOutputUsageEvent.imageCount}
          else 1
        end as quantity,
        ${userOutputUsageEvent.videoSeconds} as video_seconds,
        case
          when ${userOutputUsageEvent.outputKind} = 'image'
            then 'image_generation'
          else 'video_generation'
        end as operation_type
      from ${userOutputUsageEvent}
      where ${userOutputUsageEvent.operationCreatedAt} >= ${input.start}
        and ${userOutputUsageEvent.operationCreatedAt} < ${input.end}
        and ${userOutputUsageEvent.operationCreatedAt} >= ${input.epochStart}
        and ${userOutputUsageEvent.operationCreatedAt} < ${nextMillisecond(
          input.asOf
        )}
        ${outputBound}
    ), paged_outputs as (
      select *
      from scoped_outputs
      where ${mediaPredicate}
        and ${buildDetailKeysetPredicate(
          input.cursor,
          sortTime,
          sql`scoped_outputs.stable_id`
        )}
      order by ${sortTime} desc, scoped_outputs.stable_id desc
      limit ${input.limit}
    ), frozen_credit_usage as (
      select
        ${creditUsageProjectionEntry.userId} as user_id,
        ${creditUsageProjectionEntry.operationType} as operation_type,
        ${creditUsageProjectionEntry.operationId} as operation_id,
        ${creditUsageProjectionEntry.operationCreatedAt} as operation_created_at,
        sum(case
          when ${creditUsageProjectionEntry.contributionKind} = 'consumption'
            then ${creditUsageProjectionEntry.amount}
          else -${creditUsageProjectionEntry.amount}
        end) as net_consumed
      from ${creditUsageProjectionEntry}
      join paged_outputs
        on paged_outputs.user_id = ${creditUsageProjectionEntry.userId}
        and paged_outputs.operation_type =
          ${creditUsageProjectionEntry.operationType}
        and paged_outputs.task_id = ${creditUsageProjectionEntry.operationId}
        and paged_outputs.business_time =
          ${creditUsageProjectionEntry.operationCreatedAt}
      ${contributionBound}
      group by
        ${creditUsageProjectionEntry.userId},
        ${creditUsageProjectionEntry.operationType},
        ${creditUsageProjectionEntry.operationId},
        ${creditUsageProjectionEntry.operationCreatedAt}
    )
    select
      paged_outputs.stable_id,
      paged_outputs.task_id,
      paged_outputs.user_id,
      coalesce(
        nullif(btrim(case
          when paged_outputs.media_type = 'image' then ${generation.model}
          else ${videoGeneration.model}
        end), ''),
        'unknown'
      ) as model,
      paged_outputs.media_type,
      paged_outputs.business_time,
      'completed'::text as status,
      paged_outputs.quantity,
      paged_outputs.video_seconds,
      coalesce(
        ${input.highWatermarks ? sql`frozen_credit_lookup.net_consumed` : sql`credit_lookup.net_consumed`},
        0
      ) as net_credits,
      ${input.highWatermarks ? sql`frozen_credit_lookup.operation_id` : sql`credit_lookup.operation_id`} is null
        and exists (
          select 1
          from ${creditUsageOperation} as mismatch_lookup
          where mismatch_lookup.user_id = paged_outputs.user_id
            and mismatch_lookup.operation_type = paged_outputs.operation_type
            and mismatch_lookup.operation_id = paged_outputs.task_id
            and mismatch_lookup.operation_created_at <>
              paged_outputs.business_time
        ) as operation_created_at_mismatch
    from paged_outputs
    left join ${creditUsageOperation} as credit_lookup
      on credit_lookup.user_id = paged_outputs.user_id
      and credit_lookup.operation_type = paged_outputs.operation_type
      and credit_lookup.operation_id = paged_outputs.task_id
      and credit_lookup.operation_created_at = paged_outputs.business_time
    left join frozen_credit_usage as frozen_credit_lookup
      on frozen_credit_lookup.user_id = paged_outputs.user_id
      and frozen_credit_lookup.operation_type = paged_outputs.operation_type
      and frozen_credit_lookup.operation_id = paged_outputs.task_id
      and frozen_credit_lookup.operation_created_at = paged_outputs.business_time
    left join ${generation}
      on paged_outputs.media_type = 'image'
      and ${generation.id} = paged_outputs.task_id
      and ${generation.userId} = paged_outputs.user_id
    left join ${videoGeneration}
      on paged_outputs.media_type = 'video'
      and ${videoGeneration.id} = paged_outputs.task_id
      and ${videoGeneration.userId} = paged_outputs.user_id
    order by date_trunc('milliseconds', paged_outputs.business_time) desc,
      paged_outputs.stable_id desc
  `;
}

/** 构造新增账户明细 SQL，不排除管理员、观察员或封禁账户。 */
export function buildOperationsNewUserDetailSql(
  input: OperationsNewUserDetailQuery
): SQL {
  assertValidDetailQuery(input);
  const sortTime = buildMillisecondDetailSortTime(sql`${user.createdAt}`);
  const keyset = buildDetailKeysetPredicate(
    input.cursor,
    sortTime,
    sql`${user.id}`
  );
  const sourceWatermark = input.highWatermarks?.users;
  const sourceBound = sourceWatermark
    ? sql`and (${user.createdAt}, ${user.id})
        <= (${toOperationsDatabaseTimestamp(sourceWatermark.createdAt)}, ${
          sourceWatermark.id
        })`
    : input.highWatermarks
      ? sql`and false`
      : sql``;
  return sql`
    select
      ${user.id} as user_id,
      ${user.name} as name,
      ${user.email} as email,
      ${user.role}::text as role,
      ${user.banned} as banned,
      ${user.createdAt} as business_time,
      null::boolean as retained
    from ${user}
    where ${user.createdAt} >= ${sql.param(input.start, user.createdAt)}
      and ${user.createdAt} < ${sql.param(input.end, user.createdAt)}
      and ${user.createdAt} >= ${sql.param(input.epochStart, user.createdAt)}
      and ${user.createdAt} < ${sql.param(
        nextMillisecond(input.asOf),
        user.createdAt
      )}
      ${sourceBound}
      and ${keyset}
    order by ${sortTime} desc, ${user.id} desc
    limit ${input.limit}
  `;
}

/**
 * 构造活跃用户明细 SQL。
 *
 * WHY：先使用汇总的同源事实谓词收窄，再每用户取范围内首次业务时间；
 * 因此明细行数精确等于 COUNT(DISTINCT user_id)。
 */
export function buildOperationsActivityDetailSql(
  input: OperationsActivityDetailQuery
): SQL {
  assertValidDetailQuery(input);
  const activitySource = buildOperationsActivitySourceSql(
    input.activityKind,
    sql`${input.start}`,
    sql`${input.end}`,
    input.highWatermarks
  );
  const sortTime = buildMillisecondDetailSortTime(
    sql`activity_users.business_time`
  );
  const keyset = buildDetailKeysetPredicate(
    input.cursor,
    sortTime,
    sql`activity_users.user_id`
  );
  return sql`
    with scoped_activity as (
      ${activitySource}
    ), activity_users as (
      select
        scoped_activity.user_id,
        min(scoped_activity.business_time) as business_time
      from scoped_activity
      group by scoped_activity.user_id
    )
    select
      activity_users.user_id,
      ${user.name} as name,
      ${user.email} as email,
      ${user.role}::text as role,
      ${user.banned} as banned,
      activity_users.business_time,
      null::boolean as retained
    from activity_users
    join ${user} on ${user.id} = activity_users.user_id
    where activity_users.business_time < ${nextMillisecond(input.asOf)}
      and ${keyset}
    order by ${sortTime} desc, activity_users.user_id desc
    limit ${input.limit}
  `;
}

/**
 * 构造 Cohort 用户明细 SQL，每个注册用户一行并投影目标日是否成功创作。
 *
 * 行数反算 cohort_size，retained=true 行数反算指定 D1/D7/D30 分子。
 */
export function buildOperationsCohortDetailSql(
  input: OperationsCohortDetailQuery
): SQL {
  assertValidDetailQuery(input);
  const sortTime = buildMillisecondDetailSortTime(sql`${user.createdAt}`);
  const keyset = buildDetailKeysetPredicate(
    input.cursor,
    sortTime,
    sql`${user.id}`
  );
  const sourceWatermark = input.highWatermarks?.users;
  const sourceBound = sourceWatermark
    ? sql`and (${user.createdAt}, ${user.id})
        <= (${toOperationsDatabaseTimestamp(sourceWatermark.createdAt)}, ${
          sourceWatermark.id
        })`
    : input.highWatermarks
      ? sql`and false`
      : sql``;
  const outputWatermark = input.highWatermarks?.outputs;
  const outputBound = outputWatermark
    ? sql`and (
        ${userOutputUsageEvent.createdAt},
        ${userOutputUsageEvent.outputKind}::text,
        ${userOutputUsageEvent.sourceTaskId}
      ) <= (
        ${toOperationsDatabaseTimestamp(outputWatermark.createdAt)},
        ${outputWatermark.outputKind},
        ${outputWatermark.sourceTaskId}
      )`
    : input.highWatermarks
      ? sql`and false`
      : sql``;
  return sql`
    select
      ${user.id} as user_id,
      ${user.name} as name,
      ${user.email} as email,
      ${user.role}::text as role,
      ${user.banned} as banned,
      ${user.createdAt} as business_time,
      exists (
        select 1
        from ${userOutputUsageEvent}
        where ${userOutputUsageEvent.userId} = ${user.id}
          and ${userOutputUsageEvent.operationCreatedAt} >= ${sql.param(
            input.targetStart,
            userOutputUsageEvent.operationCreatedAt
          )}
          and ${userOutputUsageEvent.operationCreatedAt} < ${sql.param(
            input.targetEnd,
            userOutputUsageEvent.operationCreatedAt
          )}
          ${outputBound}
      ) as retained
    from ${user}
    where ${user.createdAt} >= ${sql.param(input.start, user.createdAt)}
      and ${user.createdAt} < ${sql.param(input.end, user.createdAt)}
      and ${user.createdAt} >= ${sql.param(input.epochStart, user.createdAt)}
      and ${user.createdAt} < ${sql.param(
        nextMillisecond(input.asOf),
        user.createdAt
      )}
      ${sourceBound}
      and ${keyset}
    order by ${sortTime} desc, ${user.id} desc
    limit ${input.limit}
  `;
}

/**
 * 构造覆盖完整注册范围的单个留存日导出 SQL。
 *
 * WHY：产品允许不限跨度导出。每个 D1/D7/D30 各执行一次范围查询，可把原先按注册
 * 日扇出的数千次查询收敛为三条 keyset 流，同时保持每位用户的精确目标自然日语义。
 */
export function buildOperationsCohortExportDetailSql(
  input: OperationsCohortExportDetailQuery
): SQL {
  assertValidDetailQuery(input);
  const sourceWatermark = input.highWatermarks?.users;
  const sourceBound = sourceWatermark
    ? sql`and (${user.createdAt}, ${user.id})
        <= (${toOperationsDatabaseTimestamp(sourceWatermark.createdAt)}, ${
          sourceWatermark.id
        })`
    : input.highWatermarks
      ? sql`and false`
      : sql``;
  const outputWatermark = input.highWatermarks?.outputs;
  const outputBound = outputWatermark
    ? sql`and (
        ${userOutputUsageEvent.createdAt},
        ${userOutputUsageEvent.outputKind}::text,
        ${userOutputUsageEvent.sourceTaskId}
      ) <= (
        ${toOperationsDatabaseTimestamp(outputWatermark.createdAt)},
        ${outputWatermark.outputKind},
        ${outputWatermark.sourceTaskId}
      )`
    : input.highWatermarks
      ? sql`and false`
      : sql``;
  const businessTime = sql`cohort_users.business_time`;
  const sortTime = buildMillisecondDetailSortTime(businessTime);
  const targetDate = sql`cohort_users.cohort_date + ${input.retentionDay}`;
  const targetStart = sql`(
    (${targetDate})::timestamp at time zone ${input.timeZone}
  ) at time zone 'UTC'`;
  const keyset = buildDetailKeysetPredicate(
    input.cursor,
    sortTime,
    sql`cohort_users.user_id`
  );
  return sql`
    with cohort_users as (
      select
        ${user.id} as user_id,
        ${user.name} as name,
        ${user.email} as email,
        ${user.role}::text as role,
        ${user.banned} as banned,
        ${user.createdAt} as business_time,
        (
          (${user.createdAt} at time zone 'UTC') at time zone ${input.timeZone}
        )::date as cohort_date
      from ${user}
      where ${user.createdAt} >= ${sql.param(input.start, user.createdAt)}
        and ${user.createdAt} < ${sql.param(input.end, user.createdAt)}
        and ${user.createdAt} >= ${sql.param(input.epochStart, user.createdAt)}
        and ${user.createdAt} < ${sql.param(
          nextMillisecond(input.asOf),
          user.createdAt
        )}
        ${sourceBound}
    )
    select
      cohort_users.user_id,
      cohort_users.name,
      cohort_users.email,
      cohort_users.role,
      cohort_users.banned,
      cohort_users.business_time,
      exists (
        select 1
        from ${userOutputUsageEvent}
        where ${userOutputUsageEvent.userId} = cohort_users.user_id
          and (
            (${userOutputUsageEvent.operationCreatedAt} at time zone 'UTC')
              at time zone ${input.timeZone}
          )::date = ${targetDate}
          and ${userOutputUsageEvent.operationCreatedAt} < ${nextMillisecond(
            input.asOf
          )}
          ${outputBound}
      ) as retained
    from cohort_users
    where ${targetStart} < ${nextMillisecond(input.asOf)}
      and ${keyset}
    order by ${sortTime} desc, cohort_users.user_id desc
    limit ${input.limit}
  `;
}

/** 根据封闭查询类型选择对应 SQL，未知类型无法在 TypeScript strict 下编译。 */
export function buildOperationsGrowthDetailSql(
  input: OperationsGrowthDetailQuery
): SQL {
  if (input.kind === "users") return buildOperationsNewUserDetailSql(input);
  if (input.kind === "activity") {
    return buildOperationsActivityDetailSql(input);
  }
  if (input.kind === "cohort_export") {
    return buildOperationsCohortExportDetailSql(input);
  }
  return buildOperationsCohortDetailSql(input);
}

/** 根据模块选择与汇总同源的运营明细 SQL。 */
export function buildOperationsDetailSql(input: OperationsDetailQuery): SQL {
  return createOperationsDetailExecution(input).query;
}

/**
 * 将 limit+1 仓储行切分为当页与下一页 keyset。
 *
 * @param rows 仓储按 business_time、user_id 降序返回的原始行。
 * @param pageSize 对外页大小，仓储查询 limit 应等于 pageSize + 1。
 * @returns 最多 pageSize 行；仅存在额外行时签发原始结构游标。
 */
export function paginateOperationsGrowthDetailRows(
  rows: readonly OperationsGrowthDetailRow[],
  pageSize: number
): OperationsGrowthDetailPage {
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 10_000 ||
    rows.length > pageSize + 1
  ) {
    throw new RangeError("运营增长明细分页无效");
  }
  const pageRows = rows.slice(0, pageSize);
  const lastRow = pageRows.at(-1);
  return {
    rows: pageRows,
    nextCursor:
      rows.length > pageSize && lastRow
        ? {
            businessTime: lastRow.businessTime,
            stableId: lastRow.userId,
          }
        : null,
  };
}

/** 将任意模块的 limit+1 行切分为稳定 keyset 页。 */
export function paginateOperationsDetailRows(
  rows: readonly OperationsDetailRow[],
  pageSize: number
): { rows: OperationsDetailRow[]; nextCursor: OperationsDetailCursor | null } {
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 10_000 ||
    rows.length > pageSize + 1
  ) {
    throw new RangeError("运营明细分页无效");
  }
  const pageRows = rows.slice(0, pageSize);
  const lastRow = pageRows.at(-1);
  return {
    rows: pageRows,
    nextCursor:
      rows.length > pageSize && lastRow
        ? {
            businessTime: lastRow.businessTime,
            stableId: "stableId" in lastRow ? lastRow.stableId : lastRow.userId,
          }
        : null,
  };
}

type OperationsDetailExecution = {
  query: SQL;
  parseResult(result: unknown): OperationsDetailRow[];
};

/**
 * 在一次穷尽分派中绑定查询与对应结果 parser。
 *
 * WHY：新增 query kind 时，SQL 与 parser 必须同时更新；never 分支让漏同步在
 * TypeScript 编译阶段失败，而不是在真实导出中才触发 Zod 错误。
 */
function createOperationsDetailExecution(
  input: OperationsDetailQuery
): OperationsDetailExecution {
  switch (input.kind) {
    case "users":
    case "activity":
    case "cohort":
    case "cohort_export":
      return {
        query: buildOperationsGrowthDetailSql(input),
        parseResult: parseOperationsGrowthDetailRows,
      };
    case "orders":
    case "payment_lifecycle":
      return {
        query: buildOperationsCommercialDetailSql(input),
        parseResult: parseOperationsCommercialDetailRows,
      };
    case "content":
      return {
        query: buildOperationsContentDetailSql(input),
        parseResult: parseOperationsContentDetailRows,
      };
    default: {
      const exhaustiveInput: never = input;
      return exhaustiveInput;
    }
  }
}

/** 将唯一事务 execute 绑定为明细与快照头的组合 reader。 */
function createOperationsGrowthDetailSnapshotReader(
  execute: OperationsDetailExecuteSql
): OperationsGrowthDetailSnapshotReader {
  const growthReader = createOperationsGrowthSnapshotReader(execute);
  return {
    readHeader: growthReader.readHeader,
    async readRows(input) {
      const execution = createOperationsDetailExecution(input);
      return execution.parseResult(await execute(execution.query));
    },
  };
}

/** 从 Drizzle 类数据库端口创建单一 repeatable-read 明细仓储。 */
export function createOperationsGrowthDetailRepository(
  database: OperationsGrowthDetailTransactionDatabase
): OperationsGrowthDetailRepository {
  return {
    withReadOnlySnapshot<T>(
      work: (reader: OperationsGrowthDetailSnapshotReader) => Promise<T>
    ): Promise<T> {
      return database.transaction(
        async (transaction) =>
          work(
            createOperationsGrowthDetailSnapshotReader(
              transaction.execute.bind(transaction)
            )
          ),
        { isolationLevel: "repeatable read", accessMode: "read only" }
      );
    },
  };
}

/** 生产增长明细仓储；动态导入数据库以保持 DB-free Vitest。 */
export const databaseOperationsGrowthDetailRepository: OperationsGrowthDetailRepository =
  {
    async withReadOnlySnapshot<T>(
      work: (reader: OperationsGrowthDetailSnapshotReader) => Promise<T>
    ): Promise<T> {
      const { db } = await import("@repo/database");
      return createOperationsGrowthDetailRepository(
        db as unknown as OperationsGrowthDetailTransactionDatabase
      ).withReadOnlySnapshot(work);
    },
  };
