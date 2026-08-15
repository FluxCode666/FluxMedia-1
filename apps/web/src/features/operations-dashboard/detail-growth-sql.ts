/**
 * 运营总览累计用户、新增用户、活跃用户与 Cohort 明细 SQL 构造器。
 *
 * 使用方：运营明细仓储入口、CSV worker 与 SQL 契约测试。该模块复用增长汇总的
 * 活跃事实构造器，只生成参数化 SQL，不执行查询或开启事务。
 */
import { user, userOutputUsageEvent } from "@repo/database/schema";
import { type SQL, sql } from "drizzle-orm";

import {
  toOperationsDatabaseTimestamp,
  toOperationsDatabaseTimestampText,
} from "./database-timestamp";
import type {
  OperationsActivityDetailQuery,
  OperationsCohortDetailQuery,
  OperationsCohortExportDetailQuery,
  OperationsCumulativeUserDetailQuery,
  OperationsGrowthDetailQuery,
  OperationsNewUserDetailQuery,
} from "./detail-contracts";
import {
  assertValidDetailQuery,
  buildDetailKeysetPredicate,
  nextMillisecond,
} from "./detail-query-helpers";
import { buildOperationsActivitySourceSql } from "./growth-repository";

/**
 * 构造截止指定边界的累计账户明细。
 *
 * WHY：累计用户必须包含上线前基数、管理员和封禁账户，所以查询只使用截止上界、
 * asOf 与可选导出高水位，不应用 epoch 或角色下界。
 *
 * @param input 累计用户明细查询与可选快照高水位。
 * @returns 参数化 Drizzle SQL，不执行数据库访问。
 * @throws RangeError 查询边界或游标不满足统一明细契约时抛出。
 */
export function buildOperationsCumulativeUserDetailSql(
  input: OperationsCumulativeUserDetailQuery
): SQL {
  assertValidDetailQuery(input);
  const sortTime = sql`${user.createdAt}`;
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
      ${toOperationsDatabaseTimestampText(
        sql`${user.createdAt}`
      )} as business_time_key,
      null::boolean as retained
    from ${user}
    where ${user.createdAt} < ${sql.param(input.end, user.createdAt)}
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
 * 构造新增账户明细 SQL，不排除管理员、观察员或封禁账户。
 *
 * @param input 新增用户明细查询与可选快照高水位。
 * @returns 参数化 Drizzle SQL，不执行数据库访问。
 * @throws RangeError 查询边界或游标不满足统一明细契约时抛出。
 */
export function buildOperationsNewUserDetailSql(
  input: OperationsNewUserDetailQuery
): SQL {
  assertValidDetailQuery(input);
  const sortTime = sql`${user.createdAt}`;
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
      ${toOperationsDatabaseTimestampText(
        sql`${user.createdAt}`
      )} as business_time_key,
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
 *
 * @param input 登录、创作或付费活跃明细查询。
 * @returns 参数化 Drizzle SQL，不执行数据库访问。
 * @throws RangeError 查询边界或游标不满足统一明细契约时抛出。
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
  const sortTime = sql`activity_users.business_time`;
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
      ${toOperationsDatabaseTimestampText(
        sql`activity_users.business_time`
      )} as business_time_key,
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
 *
 * @param input 单个注册日与目标留存日的 Cohort 明细查询。
 * @returns 参数化 Drizzle SQL，不执行数据库访问。
 * @throws RangeError 查询边界、目标日或游标不满足统一明细契约时抛出。
 */
export function buildOperationsCohortDetailSql(
  input: OperationsCohortDetailQuery
): SQL {
  assertValidDetailQuery(input);
  const sortTime = sql`${user.createdAt}`;
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
      ${toOperationsDatabaseTimestampText(
        sql`${user.createdAt}`
      )} as business_time_key,
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
 *
 * @param input 完整注册范围、留存日与业务时区的导出查询。
 * @returns 参数化 Drizzle SQL，不执行数据库访问。
 * @throws RangeError 查询边界、留存日、时区或游标非法时抛出。
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
  const sortTime = businessTime;
  const targetDate = sql`cohort_users.cohort_date + ${input.retentionDay}`;
  const targetStart = sql`(
    (${targetDate})::timestamp at time zone ${input.timeZone}
  ) at time zone 'UTC'`;
  const targetEnd = sql`(
    (
      (cohort_users.cohort_date + ${input.retentionDay} + 1)::timestamp
        at time zone ${input.timeZone}
    ) at time zone 'UTC'
  )`;
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
      ${toOperationsDatabaseTimestampText(
        sql`cohort_users.business_time`
      )} as business_time_key,
      exists (
        select 1
        from ${userOutputUsageEvent}
        where ${userOutputUsageEvent.userId} = cohort_users.user_id
          and ${userOutputUsageEvent.operationCreatedAt} >= ${targetStart}
          and ${userOutputUsageEvent.operationCreatedAt} < ${targetEnd}
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

/**
 * 根据封闭增长查询类型选择对应 SQL。
 *
 * @param input 累计、新增、活跃或 Cohort 增长明细查询。
 * @returns 与查询类型对应的参数化 SQL，不产生副作用。
 */
export function buildOperationsGrowthDetailSql(
  input: OperationsGrowthDetailQuery
): SQL {
  if (input.kind === "cumulative_users") {
    return buildOperationsCumulativeUserDetailSql(input);
  }
  if (input.kind === "users") return buildOperationsNewUserDetailSql(input);
  if (input.kind === "activity") {
    return buildOperationsActivityDetailSql(input);
  }
  if (input.kind === "cohort_export") {
    return buildOperationsCohortExportDetailSql(input);
  }
  return buildOperationsCohortDetailSql(input);
}
