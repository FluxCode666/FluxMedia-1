/**
 * 运营总览充值订单、履约收入与支付生命周期明细 SQL 构造器。
 *
 * 使用方：运营明细仓储入口与 SQL 契约测试。该模块只构造参数化 SQL，不执行查询；
 * 支付阶段事实、快照高水位与双列 keyset 语义必须和商业化汇总保持一致。
 */
import { paymentLifecycleEvent, paymentOrder } from "@repo/database/schema";
import { type SQL, sql } from "drizzle-orm";

import {
  toOperationsDatabaseTimestamp,
  toOperationsDatabaseTimestampText,
} from "./database-timestamp";
import type { OperationsCommercialDetailQuery } from "./detail-contracts";
import {
  assertValidDetailQuery,
  buildDetailKeysetPredicate,
  nextMillisecond,
} from "./detail-query-helpers";

/**
 * 返回支付阶段与商业化汇总完全一致的订单集合谓词。
 *
 * @param stage 需要展开为明细的支付漏斗阶段。
 * @returns 对应 order_flags 聚合列的布尔 SQL，不产生副作用。
 */
function buildPaymentStagePredicate(
  stage: Extract<
    OperationsCommercialDetailQuery,
    { kind: "payment_stage" }
  >["stage"]
): SQL {
  switch (stage) {
    case "created_orders":
      return sql`order_flags.has_created`;
    case "pending_orders":
      return sql`order_flags.has_created
        and not order_flags.has_payment
        and not order_flags.has_fulfillment
        and not order_flags.has_failure`;
    case "payment_confirmed_orders":
      return sql`order_flags.has_payment`;
    case "paid_not_fulfilled_orders":
      return sql`order_flags.has_payment
        and not order_flags.has_fulfillment
        and not order_flags.has_failure`;
    case "fulfilled_orders":
      return sql`order_flags.has_fulfillment`;
    case "failed_orders":
      return sql`order_flags.has_failure`;
  }
}

/**
 * 返回每个支付阶段用于排序和核对的同源事件业务时间。
 *
 * @param stage 需要展开为明细的支付漏斗阶段。
 * @returns 与阶段定义一致的 order_flags 时间 SQL，不产生副作用。
 */
function buildPaymentStageBusinessTime(
  stage: Extract<
    OperationsCommercialDetailQuery,
    { kind: "payment_stage" }
  >["stage"]
): SQL {
  switch (stage) {
    case "created_orders":
    case "pending_orders":
      return sql`order_flags.created_time`;
    case "payment_confirmed_orders":
    case "paid_not_fulfilled_orders":
      return sql`order_flags.payment_time`;
    case "fulfilled_orders":
      return sql`order_flags.fulfillment_time`;
    case "failed_orders":
      return sql`order_flags.failure_time`;
  }
}

/**
 * 构造支付阶段订单明细，每个订单只返回一行。
 *
 * @param input 已收窄为 payment_stage 的商业化明细查询。
 * @returns 参数化 Drizzle SQL，不执行数据库访问。
 */
function buildOperationsPaymentStageDetailSql(
  input: Extract<OperationsCommercialDetailQuery, { kind: "payment_stage" }>
): SQL {
  const lifecycleWatermark = input.highWatermarks?.paymentLifecycle;
  const sourceBound = lifecycleWatermark
    ? sql`and (
        ${paymentLifecycleEvent.recordedAt},
        ${paymentLifecycleEvent.id}
      ) <= (
        ${toOperationsDatabaseTimestamp(lifecycleWatermark.recordedAt)},
        ${lifecycleWatermark.id}
      )`
    : input.highWatermarks
      ? sql`and false`
      : sql``;
  const businessTime = buildPaymentStageBusinessTime(input.stage);
  const stagePredicate = buildPaymentStagePredicate(input.stage);
  const sortTime = sql`stage_orders.business_time`;
  const keyset = buildDetailKeysetPredicate(
    input.cursor,
    sortTime,
    sql`stage_orders.stable_id`
  );
  return sql`
    with scoped_events as (
      select
        ${paymentLifecycleEvent.paymentOrderId} as payment_order_id,
        ${paymentLifecycleEvent.eventType}::text as event_type,
        ${paymentLifecycleEvent.occurredAt} as occurred_at
      from ${paymentLifecycleEvent}
      join ${paymentOrder}
        on ${paymentOrder.id} = ${paymentLifecycleEvent.paymentOrderId}
      where ${paymentOrder.purpose} in ('credit_top_up', 'credit_package')
        and ${paymentLifecycleEvent.eventType} in (
          'order_created',
          'checkout_ready',
          'payment_confirmed',
          'fulfillment_succeeded',
          'checkout_failed',
          'fulfillment_attempt_failed',
          'fulfillment_failed_terminal',
          'expired'
        )
        and ${paymentLifecycleEvent.occurredAt} >= ${input.start}
        and ${paymentLifecycleEvent.occurredAt} < ${input.end}
        and ${paymentLifecycleEvent.occurredAt} >= ${input.epochStart}
        and ${paymentLifecycleEvent.occurredAt} < ${nextMillisecond(input.asOf)}
        ${sourceBound}
    ), order_flags as (
      select
        scoped_events.payment_order_id,
        bool_or(scoped_events.event_type = 'order_created') as has_created,
        bool_or(scoped_events.event_type = 'payment_confirmed') as has_payment,
        bool_or(
          scoped_events.event_type = 'fulfillment_succeeded'
        ) as has_fulfillment,
        bool_or(
          scoped_events.event_type in (
            'checkout_failed',
            'fulfillment_failed_terminal',
            'expired'
          )
        ) as has_failure,
        min(scoped_events.occurred_at) filter (
          where scoped_events.event_type = 'order_created'
        ) as created_time,
        min(scoped_events.occurred_at) filter (
          where scoped_events.event_type = 'payment_confirmed'
        ) as payment_time,
        min(scoped_events.occurred_at) filter (
          where scoped_events.event_type = 'fulfillment_succeeded'
        ) as fulfillment_time,
        min(scoped_events.occurred_at) filter (
          where scoped_events.event_type in (
            'checkout_failed',
            'fulfillment_failed_terminal',
            'expired'
          )
        ) as failure_time
      from scoped_events
      group by scoped_events.payment_order_id
    ), stage_orders as (
      select
        ${input.kind}::text as kind,
        ${paymentOrder.id} as stable_id,
        ${paymentOrder.id} as payment_order_id,
        ${paymentOrder.providerTradeNo} as provider_trade_no,
        ${paymentOrder.userId} as user_id,
        upper(${paymentOrder.currency}) as currency,
        ${paymentOrder.amountMinor} as amount_minor,
        ${paymentOrder.status} as order_status,
        ${paymentOrder.createdAt} as created_at,
        ${paymentOrder.fulfilledAt} as fulfilled_at,
        ${businessTime} as business_time,
        ${input.stage}::text as event_type
      from order_flags
      join ${paymentOrder} on ${paymentOrder.id} = order_flags.payment_order_id
      where ${stagePredicate}
        ${
          input.currency
            ? sql`and upper(${paymentOrder.currency}) = ${input.currency}`
            : sql``
        }
    )
    select
      stage_orders.*,
      ${toOperationsDatabaseTimestampText(
        sql`stage_orders.business_time`
      )} as business_time_key
    from stage_orders
    where stage_orders.business_time is not null
      and ${keyset}
    order by ${sortTime} desc, stage_orders.stable_id desc
    limit ${input.limit}
  `;
}

/**
 * 构造充值订单或不可变支付生命周期事件的商业化明细 SQL。
 *
 * @param input 商业化明细查询，包含范围、快照高水位和可选游标。
 * @returns 参数化 Drizzle SQL，不执行数据库访问。
 * @throws RangeError 查询边界或游标不满足统一明细契约时抛出。
 */
export function buildOperationsCommercialDetailSql(
  input: OperationsCommercialDetailQuery
): SQL {
  assertValidDetailQuery(input);
  if (input.kind === "payment_stage") {
    return buildOperationsPaymentStageDetailSql(input);
  }
  const eventJoin =
    input.kind === "payment_lifecycle"
      ? sql`join ${paymentLifecycleEvent}
          on ${paymentLifecycleEvent.paymentOrderId} = ${paymentOrder.id}`
      : sql``;
  const businessTime =
    input.kind === "payment_lifecycle"
      ? sql`${paymentLifecycleEvent.occurredAt}`
      : input.kind === "fulfilled_orders"
        ? sql`${paymentOrder.fulfilledAt}`
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
  const fulfilledPredicate =
    input.kind === "fulfilled_orders"
      ? sql`and ${paymentOrder.status} = 'fulfilled'
          and ${paymentOrder.fulfilledAt} is not null
          ${
            input.currency
              ? sql`and upper(${paymentOrder.currency}) = ${input.currency}`
              : sql``
          }`
      : sql``;
  const sortTime = sql`scoped_commercial.business_time`;
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
        ${fulfilledPredicate}
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
    select
      scoped_commercial.*,
      ${toOperationsDatabaseTimestampText(
        sql`scoped_commercial.business_time`
      )} as business_time_key
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
