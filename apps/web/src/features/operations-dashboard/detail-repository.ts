/**
 * 运营总览增长、商业化与内容生产明细 PostgreSQL 仓储。
 *
 * 使用方：后续 operations detail UOL 与 CSV worker。新增用户、三类活跃和
 * Cohort 明细与汇总仓储复用同一活跃事实构造器，并使用 business_time + user_id
 * 降序 keyset；完整邮箱仅能由后续 human-only 管理员 operation 暴露。
 */
import {
  creditUsageOperation,
  generation,
  paymentLifecycleEvent,
  paymentOrder,
  user,
  userOutputUsageEvent,
  videoGeneration,
} from "@repo/database/schema";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";

import { extractExecuteRows } from "@/server/database-result";

import {
  buildOperationsActivitySourceSql,
  createOperationsGrowthSnapshotReader,
  type OperationsGrowthActivityKind,
  type OperationsGrowthSnapshotHeader,
} from "./growth-repository";

/** 明细排序键；同一业务时间以用户 ID 稳定打破平局。 */
export type OperationsDetailCursor = {
  businessTime: Date;
  stableId: string;
};

/** 兼容增长调用方的明细游标别名。 */
export type OperationsGrowthDetailCursor = OperationsDetailCursor;

type OperationsGrowthDetailBaseQuery = {
  start: Date;
  end: Date;
  epochStart: Date;
  asOf: Date;
  cursor: OperationsDetailCursor | null;
  limit: number;
};

/** 新增账户明细查询，范围必须已在服务层截断至 epoch。 */
export type OperationsNewUserDetailQuery = OperationsGrowthDetailBaseQuery & {
  kind: "users";
};

/** 周期活跃明细每用户只返回一行，因而行数可直接反算去重汇总。 */
export type OperationsActivityDetailQuery = OperationsGrowthDetailBaseQuery & {
  kind: "activity";
  activityKind: OperationsGrowthActivityKind;
};

/** 单个注册日与精确目标日的 Cohort 明细查询。 */
export type OperationsCohortDetailQuery = OperationsGrowthDetailBaseQuery & {
  kind: "cohort";
  targetStart: Date;
  targetEnd: Date;
};

/** 增长明细的封闭查询类型。 */
export type OperationsGrowthDetailQuery =
  | OperationsNewUserDetailQuery
  | OperationsActivityDetailQuery
  | OperationsCohortDetailQuery;

/** 充值订单明细按订单创建业务时间筛选，每个平台订单只返回一行。 */
export type OperationsOrderDetailQuery = OperationsGrowthDetailBaseQuery & {
  kind: "orders";
};

/** 支付生命周期明细按不可变事件业务时间筛选，每个事件返回一行。 */
export type OperationsPaymentLifecycleDetailQuery =
  OperationsGrowthDetailBaseQuery & {
    kind: "payment_lifecycle";
  };

/** 商业化明细的封闭查询类型。 */
export type OperationsCommercialDetailQuery =
  | OperationsOrderDetailQuery
  | OperationsPaymentLifecycleDetailQuery;

/** 内容明细由成功产物事实驱动，detail 只改变媒体范围。 */
export type OperationsContentDetailQuery = OperationsGrowthDetailBaseQuery & {
  kind: "content";
  detail: "image_outputs" | "video_outputs" | "credit_usage";
};

/** 运营明细所有模块共享的封闭查询类型。 */
export type OperationsDetailQuery =
  | OperationsGrowthDetailQuery
  | OperationsCommercialDetailQuery
  | OperationsContentDetailQuery;

/** 可用汇总反算的最小用户明细行。 */
export type OperationsGrowthDetailRow = {
  kind?: "growth";
  userId: string;
  name: string;
  email: string;
  role: string;
  banned: boolean;
  businessTime: Date;
  retained: boolean | null;
};

/** 可同时服务页面核对和 CSV 的安全商业化明细行。 */
export type OperationsCommercialDetailRow = {
  kind: "orders" | "payment_lifecycle";
  stableId: string;
  paymentOrderId: string;
  providerTradeNo: string | null;
  userId: string;
  currency: string;
  amountMinor: number;
  orderStatus: string;
  createdAt: Date;
  fulfilledAt: Date | null;
  businessTime: Date;
  eventType: string | null;
};

/** 成功产物及其精确净积分关联组成的安全内容明细行。 */
export type OperationsContentDetailRow = {
  kind: "content";
  stableId: string;
  taskId: string;
  userId: string;
  model: string;
  mediaType: "image" | "video";
  businessTime: Date;
  status: "completed";
  quantity: number;
  videoSeconds: number;
  netCredits: number;
  operationCreatedAtMismatch: boolean;
};

/** 运营明细数据库行的封闭联合类型。 */
export type OperationsDetailRow =
  | OperationsGrowthDetailRow
  | OperationsCommercialDetailRow
  | OperationsContentDetailRow;

/** 带 keyset 继续信息的增长明细页。 */
export type OperationsGrowthDetailPage = {
  rows: OperationsGrowthDetailRow[];
  nextCursor: OperationsGrowthDetailCursor | null;
};

/** 单个只读快照中的增长明细读取端口。 */
export interface OperationsGrowthDetailSnapshotReader {
  readHeader(): Promise<OperationsGrowthSnapshotHeader>;
  readRows(input: OperationsDetailQuery): Promise<OperationsDetailRow[]>;
}

/** 增长明细仓储端口；limit 应包含服务层用于判断下一页的额外一行。 */
export interface OperationsGrowthDetailRepository {
  withReadOnlySnapshot<T>(
    work: (reader: OperationsGrowthDetailSnapshotReader) => Promise<T>
  ): Promise<T>;
}

/** 统一明细仓储别名，供商业化、内容页面与 CSV worker 使用。 */
export type OperationsDetailRepository = OperationsGrowthDetailRepository;

type ExecuteSql = (query: SQL) => Promise<unknown>;

/** 生产与集成测试共用的最小只读事务数据库端口。 */
export interface OperationsGrowthDetailTransactionDatabase {
  transaction<T>(
    work: (transaction: { execute: ExecuteSql }) => Promise<T>,
    config: {
      isolationLevel: "repeatable read";
      accessMode: "read only";
    }
  ): Promise<T>;
}

const detailDatabaseRowSchema = z.object({
  user_id: z.string().min(1),
  name: z.string(),
  email: z.string().email(),
  role: z.string().min(1),
  banned: z.boolean(),
  business_time: z
    .union([z.date(), z.string().min(1)])
    .transform((value) => (value instanceof Date ? value : new Date(value)))
    .refine((value) => !Number.isNaN(value.getTime()), "明细业务时间无效"),
  retained: z.boolean().nullable(),
});

const commercialDetailDatabaseRowSchema = z.object({
  kind: z.enum(["orders", "payment_lifecycle"]),
  stable_id: z.string().min(1),
  payment_order_id: z.string().min(1),
  provider_trade_no: z.string().nullable(),
  user_id: z.string().min(1),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/),
  amount_minor: z.coerce.number().int().safe().nonnegative(),
  order_status: z.string().min(1),
  created_at: z
    .union([z.date(), z.string().min(1)])
    .transform((value) => (value instanceof Date ? value : new Date(value)))
    .refine((value) => !Number.isNaN(value.getTime()), "订单创建时间无效"),
  fulfilled_at: z
    .union([z.date(), z.string().min(1)])
    .transform((value) => (value instanceof Date ? value : new Date(value)))
    .refine((value) => !Number.isNaN(value.getTime()), "订单履约时间无效")
    .nullable(),
  business_time: z
    .union([z.date(), z.string().min(1)])
    .transform((value) => (value instanceof Date ? value : new Date(value)))
    .refine((value) => !Number.isNaN(value.getTime()), "商业化业务时间无效"),
  event_type: z.string().nullable(),
});

const contentDetailDatabaseRowSchema = z.object({
  stable_id: z.string().min(1),
  task_id: z.string().min(1),
  user_id: z.string().min(1),
  model: z.string().min(1),
  media_type: z.enum(["image", "video"]),
  business_time: z
    .union([z.date(), z.string().min(1)])
    .transform((value) => (value instanceof Date ? value : new Date(value)))
    .refine((value) => !Number.isNaN(value.getTime()), "内容业务时间无效"),
  status: z.literal("completed"),
  quantity: z.coerce.number().int().safe().positive(),
  video_seconds: z.coerce.number().int().safe().nonnegative(),
  net_credits: z.coerce.number().finite().nonnegative(),
  operation_created_at_mismatch: z.boolean(),
});

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
  const keyset = buildDetailKeysetPredicate(
    input.cursor,
    sql`scoped_commercial.business_time`,
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
      and scoped_commercial.business_time <= ${input.asOf}
      and ${keyset}
    order by scoped_commercial.business_time desc,
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
  const keyset = buildDetailKeysetPredicate(
    input.cursor,
    sql`scoped_outputs.business_time`,
    sql`scoped_outputs.stable_id`
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
        and ${userOutputUsageEvent.operationCreatedAt} <= ${input.asOf}
    )
    select
      scoped_outputs.stable_id,
      scoped_outputs.task_id,
      scoped_outputs.user_id,
      coalesce(
        nullif(btrim(case
          when scoped_outputs.media_type = 'image' then ${generation.model}
          else ${videoGeneration.model}
        end), ''),
        'unknown'
      ) as model,
      scoped_outputs.media_type,
      scoped_outputs.business_time,
      'completed'::text as status,
      scoped_outputs.quantity,
      scoped_outputs.video_seconds,
      coalesce(credit_lookup.net_consumed, 0) as net_credits,
      credit_lookup.operation_id is null
        and exists (
          select 1
          from ${creditUsageOperation} as mismatch_lookup
          where mismatch_lookup.user_id = scoped_outputs.user_id
            and mismatch_lookup.operation_type = scoped_outputs.operation_type
            and mismatch_lookup.operation_id = scoped_outputs.task_id
            and mismatch_lookup.operation_created_at <>
              scoped_outputs.business_time
        ) as operation_created_at_mismatch
    from scoped_outputs
    left join ${creditUsageOperation} as credit_lookup
      on credit_lookup.user_id = scoped_outputs.user_id
      and credit_lookup.operation_type = scoped_outputs.operation_type
      and credit_lookup.operation_id = scoped_outputs.task_id
      and credit_lookup.operation_created_at = scoped_outputs.business_time
    left join ${generation}
      on scoped_outputs.media_type = 'image'
      and ${generation.id} = scoped_outputs.task_id
      and ${generation.userId} = scoped_outputs.user_id
    left join ${videoGeneration}
      on scoped_outputs.media_type = 'video'
      and ${videoGeneration.id} = scoped_outputs.task_id
      and ${videoGeneration.userId} = scoped_outputs.user_id
    where ${mediaPredicate}
      and ${keyset}
    order by scoped_outputs.business_time desc, scoped_outputs.stable_id desc
    limit ${input.limit}
  `;
}

/** 构造新增账户明细 SQL，不排除管理员、观察员或封禁账户。 */
export function buildOperationsNewUserDetailSql(
  input: OperationsNewUserDetailQuery
): SQL {
  assertValidDetailQuery(input);
  const keyset = buildDetailKeysetPredicate(
    input.cursor,
    sql`${user.createdAt}`,
    sql`${user.id}`
  );
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
      and ${user.createdAt} <= ${sql.param(input.asOf, user.createdAt)}
      and ${keyset}
    order by ${user.createdAt} desc, ${user.id} desc
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
    sql`${input.end}`
  );
  const keyset = buildDetailKeysetPredicate(
    input.cursor,
    sql`activity_users.business_time`,
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
    where activity_users.business_time <= ${input.asOf}
      and ${keyset}
    order by activity_users.business_time desc, activity_users.user_id desc
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
  const keyset = buildDetailKeysetPredicate(
    input.cursor,
    sql`${user.createdAt}`,
    sql`${user.id}`
  );
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
      ) as retained
    from ${user}
    where ${user.createdAt} >= ${sql.param(input.start, user.createdAt)}
      and ${user.createdAt} < ${sql.param(input.end, user.createdAt)}
      and ${user.createdAt} >= ${sql.param(input.epochStart, user.createdAt)}
      and ${user.createdAt} <= ${sql.param(input.asOf, user.createdAt)}
      and ${keyset}
    order by ${user.createdAt} desc, ${user.id} desc
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
  return buildOperationsCohortDetailSql(input);
}

/** 根据模块选择与汇总同源的运营明细 SQL。 */
export function buildOperationsDetailSql(input: OperationsDetailQuery): SQL {
  if (
    input.kind === "users" ||
    input.kind === "activity" ||
    input.kind === "cohort"
  ) {
    return buildOperationsGrowthDetailSql(input);
  }
  if (input.kind === "orders" || input.kind === "payment_lifecycle") {
    return buildOperationsCommercialDetailSql(input);
  }
  return buildOperationsContentDetailSql(input);
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

/** 将不可信数据库行严格收窄为增长明细 DTO。 */
function parseDetailRows(result: unknown): OperationsGrowthDetailRow[] {
  return z
    .array(detailDatabaseRowSchema)
    .parse(extractExecuteRows(result))
    .map((row) => ({
      kind: "growth" as const,
      userId: row.user_id,
      name: row.name,
      email: row.email,
      role: row.role,
      banned: row.banned,
      businessTime: row.business_time,
      retained: row.retained,
    }));
}

/** 将不可信数据库行严格收窄为商业化安全 DTO。 */
function parseCommercialDetailRows(
  result: unknown
): OperationsCommercialDetailRow[] {
  return z
    .array(commercialDetailDatabaseRowSchema)
    .parse(extractExecuteRows(result))
    .map((row) => ({
      kind: row.kind,
      stableId: row.stable_id,
      paymentOrderId: row.payment_order_id,
      providerTradeNo: row.provider_trade_no,
      userId: row.user_id,
      currency: row.currency,
      amountMinor: row.amount_minor,
      orderStatus: row.order_status,
      createdAt: row.created_at,
      fulfilledAt: row.fulfilled_at,
      businessTime: row.business_time,
      eventType: row.event_type,
    }));
}

/** 将不可信数据库行严格收窄为内容生产安全 DTO。 */
function parseContentDetailRows(result: unknown): OperationsContentDetailRow[] {
  return z
    .array(contentDetailDatabaseRowSchema)
    .parse(extractExecuteRows(result))
    .map((row) => ({
      kind: "content",
      stableId: row.stable_id,
      taskId: row.task_id,
      userId: row.user_id,
      model: row.model,
      mediaType: row.media_type,
      businessTime: row.business_time,
      status: row.status,
      quantity: row.quantity,
      videoSeconds: row.video_seconds,
      netCredits: row.net_credits,
      operationCreatedAtMismatch: row.operation_created_at_mismatch,
    }));
}

/** 将唯一事务 execute 绑定为明细与快照头的组合 reader。 */
function createOperationsGrowthDetailSnapshotReader(
  execute: ExecuteSql
): OperationsGrowthDetailSnapshotReader {
  const growthReader = createOperationsGrowthSnapshotReader(execute);
  return {
    readHeader: growthReader.readHeader,
    async readRows(input) {
      const result = await execute(buildOperationsDetailSql(input));
      if (
        input.kind === "users" ||
        input.kind === "activity" ||
        input.kind === "cohort"
      ) {
        return parseDetailRows(result);
      }
      if (input.kind === "orders" || input.kind === "payment_lifecycle") {
        return parseCommercialDetailRows(result);
      }
      return parseContentDetailRows(result);
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
          work(createOperationsGrowthDetailSnapshotReader(transaction.execute)),
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
