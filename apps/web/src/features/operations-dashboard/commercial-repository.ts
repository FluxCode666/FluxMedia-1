/**
 * 运营总览商业化 PostgreSQL 仓储。
 *
 * 使用方：商业化领域服务与后续统一 overview service。仓储在只读
 * repeatable-read 快照内读取支付生命周期、已履约收入和转化分母，绝不从订单
 * 当前状态回造历史漏斗，也不把生成失败积分退回解释为退款。
 */
import {
  operationsAnalyticsEpoch,
  paymentLifecycleEvent,
  paymentOrder,
} from "@repo/database/schema";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";

import { extractExecuteRows } from "@/server/database-result";

import {
  buildOperationsActivityUserCountSql,
  type OperationsGrowthRangeQuery,
  type OperationsGrowthSnapshotHeader,
} from "./growth-repository";

/** 漏斗内各个可核对阶段的去重订单数量。 */
export type OperationsCommercialLifecycleCounts = {
  createdOrders: number;
  pendingOrders: number;
  paymentConfirmedOrders: number;
  paidNotFulfilledOrders: number;
  fulfilledOrders: number;
  failedOrders: number;
};

/** 已履约充值收入的单币种最小单位金额。 */
export type OperationsCommercialRevenueRow = {
  currency: string;
  amountMinor: number;
};

/** 单个商业化快照可执行的全部读取。 */
export interface OperationsCommercialSnapshotReader {
  readHeader(): Promise<OperationsGrowthSnapshotHeader>;
  readLifecycleCounts(
    input: OperationsGrowthRangeQuery
  ): Promise<OperationsCommercialLifecycleCounts>;
  readRevenue(
    input: OperationsGrowthRangeQuery
  ): Promise<OperationsCommercialRevenueRow[]>;
  readPayingUserCount(input: OperationsGrowthRangeQuery): Promise<number>;
  readActivityUserCount(
    kind: "login" | "creation",
    input: OperationsGrowthRangeQuery
  ): Promise<number>;
}

/** 为商业化模块建立唯一只读事务的仓储端口。 */
export interface OperationsCommercialRepository {
  withReadOnlySnapshot<T>(
    work: (reader: OperationsCommercialSnapshotReader) => Promise<T>
  ): Promise<T>;
}

type ExecuteSql = (query: SQL) => Promise<unknown>;

/** 生产与数据库集成测试共用的最小事务数据库端口。 */
export interface OperationsCommercialTransactionDatabase {
  transaction<T>(
    work: (transaction: { execute: ExecuteSql }) => Promise<T>,
    config: {
      isolationLevel: "repeatable read";
      accessMode: "read only";
    }
  ): Promise<T>;
}

const databaseDateSchema = z
  .union([z.date(), z.string().min(1)])
  .transform((value) => (value instanceof Date ? value : new Date(value)))
  .refine((value) => !Number.isNaN(value.getTime()), "数据库时间无效");
const databaseCountSchema = z.coerce.number().int().safe().nonnegative();
const snapshotHeaderRowSchema = z.object({
  as_of: databaseDateSchema,
  app_date: z.string().nullable(),
  starts_at: databaseDateSchema.nullable(),
});
const lifecycleRowSchema = z.object({
  created_orders: databaseCountSchema,
  pending_orders: databaseCountSchema,
  payment_confirmed_orders: databaseCountSchema,
  paid_not_fulfilled_orders: databaseCountSchema,
  fulfilled_orders: databaseCountSchema,
  failed_orders: databaseCountSchema,
});
const revenueRowSchema = z.object({
  currency: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/),
  amount_minor: databaseCountSchema,
});
const countRowSchema = z.object({ user_count: databaseCountSchema });

/** 构造商业化快照捕获数据库时钟和不可变 epoch 的首条 SQL。 */
export function buildOperationsCommercialHeaderSql(): SQL {
  return sql`
    select
      transaction_timestamp() as as_of,
      max(${operationsAnalyticsEpoch.appDate}) as app_date,
      max(${operationsAnalyticsEpoch.startsAt}) as starts_at
    from ${operationsAnalyticsEpoch}
    where ${operationsAnalyticsEpoch.id} = 1
  `;
}

/**
 * 构造订单生命周期阶段 SQL。
 *
 * WHY：阶段条不是严格同批订单的逐层漏斗，所以每种事件按其业务发生时间落入
 * 范围；同一订单的重复来源事件先折叠为布尔标志。待支付和已支付未履约只表示
 * 区间内观察到的阶段，不读取可变的 payment_order.status 回算历史。
 */
export function buildOperationsCommercialLifecycleSql(
  input: OperationsGrowthRangeQuery
): SQL {
  return sql`
    with scoped_events as (
      select
        ${paymentLifecycleEvent.paymentOrderId} as payment_order_id,
        ${paymentLifecycleEvent.eventType} as event_type
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
        and ${paymentLifecycleEvent.occurredAt} >= ${sql.param(
          input.start,
          paymentLifecycleEvent.occurredAt
        )}
        and ${paymentLifecycleEvent.occurredAt} < ${sql.param(
          input.end,
          paymentLifecycleEvent.occurredAt
        )}
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
        ) as has_failure
      from scoped_events
      group by scoped_events.payment_order_id
    )
    select
      count(*) filter (where has_created) as created_orders,
      count(*) filter (
        where has_created
          and not has_payment
          and not has_fulfillment
          and not has_failure
      ) as pending_orders,
      count(*) filter (where has_payment) as payment_confirmed_orders,
      count(*) filter (
        where has_payment and not has_fulfillment and not has_failure
      ) as paid_not_fulfilled_orders,
      count(*) filter (where has_fulfillment) as fulfilled_orders,
      count(*) filter (where has_failure) as failed_orders
    from order_flags
  `;
}

/**
 * 构造按币种分组的已履约充值收入 SQL。
 *
 * WHY：收入的业务时间固定为 fulfilled_at，且只取订单最小单位金额；积分退款、
 * 线下退款和生成失败退回均不参与此查询。
 */
export function buildOperationsCommercialRevenueSql(
  input: OperationsGrowthRangeQuery
): SQL {
  return sql`
    select
      upper(${paymentOrder.currency}) as currency,
      coalesce(sum(${paymentOrder.amountMinor}), 0) as amount_minor
    from ${paymentOrder}
    where ${paymentOrder.status} = 'fulfilled'
      and ${paymentOrder.purpose} in ('credit_top_up', 'credit_package')
      and ${paymentOrder.fulfilledAt} is not null
      and ${paymentOrder.fulfilledAt} >= ${sql.param(
        input.start,
        paymentOrder.fulfilledAt
      )}
      and ${paymentOrder.fulfilledAt} < ${sql.param(
        input.end,
        paymentOrder.fulfilledAt
      )}
    group by upper(${paymentOrder.currency})
    order by upper(${paymentOrder.currency})
  `;
}

/** 构造周期内成功充值去重用户数 SQL，作为两个付费转化的共同分子。 */
export function buildOperationsCommercialPayingUsersSql(
  input: OperationsGrowthRangeQuery
): SQL {
  return sql`
    select count(distinct ${paymentOrder.userId}) as user_count
    from ${paymentOrder}
    where ${paymentOrder.status} = 'fulfilled'
      and ${paymentOrder.purpose} in ('credit_top_up', 'credit_package')
      and ${paymentOrder.fulfilledAt} is not null
      and ${paymentOrder.fulfilledAt} >= ${sql.param(
        input.start,
        paymentOrder.fulfilledAt
      )}
      and ${paymentOrder.fulfilledAt} < ${sql.param(
        input.end,
        paymentOrder.fulfilledAt
      )}
  `;
}

/** 从未信任的数据库结果读取唯一计数行。 */
function parseCount(result: unknown): number {
  return countRowSchema.parse(extractExecuteRows(result)[0]).user_count;
}

/** 把事务 execute 绑定成可供统一 overview 复用的商业化 reader。 */
export function createOperationsCommercialSnapshotReader(
  execute: ExecuteSql
): OperationsCommercialSnapshotReader {
  return {
    async readHeader() {
      const row = snapshotHeaderRowSchema.parse(
        extractExecuteRows(
          await execute(buildOperationsCommercialHeaderSql())
        )[0]
      );
      if ((row.app_date === null) !== (row.starts_at === null)) {
        throw new Error("运营统计起点数据不完整");
      }
      return {
        asOf: row.as_of,
        epoch:
          row.app_date === null || row.starts_at === null
            ? null
            : { appDate: row.app_date, startsAt: row.starts_at },
      };
    },
    async readLifecycleCounts(input) {
      const row = lifecycleRowSchema.parse(
        extractExecuteRows(
          await execute(buildOperationsCommercialLifecycleSql(input))
        )[0]
      );
      return {
        createdOrders: row.created_orders,
        pendingOrders: row.pending_orders,
        paymentConfirmedOrders: row.payment_confirmed_orders,
        paidNotFulfilledOrders: row.paid_not_fulfilled_orders,
        fulfilledOrders: row.fulfilled_orders,
        failedOrders: row.failed_orders,
      };
    },
    async readRevenue(input) {
      return z
        .array(revenueRowSchema)
        .parse(
          extractExecuteRows(
            await execute(buildOperationsCommercialRevenueSql(input))
          )
        )
        .map((row) => ({
          currency: row.currency,
          amountMinor: row.amount_minor,
        }));
    },
    async readPayingUserCount(input) {
      return parseCount(
        await execute(buildOperationsCommercialPayingUsersSql(input))
      );
    },
    async readActivityUserCount(kind, input) {
      return parseCount(
        await execute(buildOperationsActivityUserCountSql(kind, input))
      );
    },
  };
}

/** 从 Drizzle 类数据库端口创建商业化快照仓储。 */
export function createOperationsCommercialRepository(
  database: OperationsCommercialTransactionDatabase
): OperationsCommercialRepository {
  return {
    withReadOnlySnapshot<T>(
      work: (reader: OperationsCommercialSnapshotReader) => Promise<T>
    ): Promise<T> {
      return database.transaction(
        async (transaction) =>
          work(
            createOperationsCommercialSnapshotReader(
              transaction.execute.bind(transaction)
            )
          ),
        { isolationLevel: "repeatable read", accessMode: "read only" }
      );
    },
  };
}

/** 生产仓储延迟导入数据库，使 Web Vitest 可在无 DATABASE_URL 下注入 reader。 */
export const databaseOperationsCommercialRepository: OperationsCommercialRepository =
  {
    async withReadOnlySnapshot<T>(
      work: (reader: OperationsCommercialSnapshotReader) => Promise<T>
    ): Promise<T> {
      const { db } = await import("@repo/database");
      const repository = createOperationsCommercialRepository(
        db as unknown as OperationsCommercialTransactionDatabase
      );
      return repository.withReadOnlySnapshot(work);
    },
  };
