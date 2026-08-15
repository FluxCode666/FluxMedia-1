/**
 * 运营总览成功生图、生视频与净积分明细 SQL 构造器。
 *
 * 使用方：运营明细仓储入口与 SQL 契约测试。查询保持成功产物三列 tuple 排序，
 * 并使用四字段身份关联积分投影，模块本身只构造 SQL 而不访问数据库。
 */
import {
  creditUsageOperation,
  creditUsageProjectionEntry,
  generation,
  userOutputUsageEvent,
  videoGeneration,
} from "@repo/database/schema";
import { type SQL, sql } from "drizzle-orm";

import {
  toOperationsDatabaseTimestamp,
  toOperationsDatabaseTimestampText,
} from "./database-timestamp";
import type { OperationsContentDetailQuery } from "./detail-contracts";
import {
  assertValidDetailQuery,
  buildContentDetailKeysetPredicate,
  nextMillisecond,
} from "./detail-query-helpers";

/**
 * 构造成功内容明细 SQL，并在同一行投影模型与净积分。
 *
 * WHY：积分严格匹配四个稳定身份字段；无 operation 是免费任务，净值为零；
 * 同主体、类型、任务 ID 但创建时间不同则标记漂移，服务层拒绝整页。
 *
 * @param input 内容明细查询，包含产物类型、范围、快照高水位与可选游标。
 * @returns 参数化 Drizzle SQL，不执行数据库访问。
 * @throws RangeError 查询边界或内容游标不满足统一明细契约时抛出。
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
  const sortTime = sql`scoped_outputs.business_time`;
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
        ${userOutputUsageEvent.outputKind} as sort_output_kind,
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
        and ${buildContentDetailKeysetPredicate(input.cursor)}
      order by ${sortTime} desc,
        scoped_outputs.sort_output_kind desc,
        scoped_outputs.task_id desc
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
      ${toOperationsDatabaseTimestampText(
        sql`paged_outputs.business_time`
      )} as business_time_key,
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
    order by paged_outputs.business_time desc,
      paged_outputs.sort_output_kind desc,
      paged_outputs.task_id desc
  `;
}
