/**
 * 管理端充值支付 PostgreSQL 仓储。
 *
 * 使用方：admin-payment-service 的 UOL binding。所有查询固定限制为两种充值用途，
 * 收入只读取已履约订单；列表只选择管理页面需要的安全窄列，不返回支付快照或载荷。
 */
import { db } from "@repo/database";
import { paymentOrder, user } from "@repo/database/schema";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import type {
  AdminPaymentOrderCountQuery,
  AdminPaymentOrderQuery,
  AdminPaymentOrderRow,
  AdminPaymentOrderSnapshotReader,
  AdminPaymentOverviewOrderCountRow,
  AdminPaymentOverviewRevenueRow,
  AdminPaymentRepository,
} from "./admin-payment-service";

const overviewRevenueRowSchema = z
  .object({
    date: z.string().date(),
    currency: z.string().trim().length(3),
    amountMinor: z.coerce.number().int().nonnegative().safe(),
  })
  .strict();

const overviewOrderCountRowSchema = z
  .object({
    date: z.string().date(),
    currency: z.string().trim().length(3),
    orderCount: z.coerce.number().int().nonnegative().safe(),
  })
  .strict();

const orderRowSchema = z
  .object({
    id: z.string().min(1).max(128),
    userId: z.string().min(1).max(512),
    userEmail: z.string().trim().email().max(320),
    provider: z.enum(["alipay_f2f", "creem", "epay"]),
    purpose: z.enum(["credit_top_up", "credit_package"]),
    status: z.enum([
      "creating",
      "pending",
      "fulfilling",
      "fulfilled",
      "failed",
    ]),
    currency: z.string().trim().length(3),
    amountMinor: z.coerce.number().int().nonnegative().safe(),
    creditsAmount: z.coerce.number().finite().nonnegative(),
    providerTradeNo: z.string().max(512).nullable(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
    expiresAt: z.coerce.date().nullable(),
    fulfilledAt: z.coerce.date().nullable(),
  })
  .strict();

const userOptionSchema = z
  .object({
    id: z.string().min(1).max(512),
    email: z.string().trim().email().max(320),
  })
  .strict();

const countSchema = z.coerce.number().int().nonnegative().safe();

/** 单快照订单读取依赖的最小 Drizzle 查询事务形状。 */
type AdminPaymentTransaction = Pick<typeof db, "select">;

/** 生产与仓储测试共用的最小 PostgreSQL 事务端口。 */
export interface AdminPaymentTransactionDatabase {
  transaction<T>(
    work: (transaction: AdminPaymentTransaction) => Promise<T>,
    config: {
      isolationLevel: "repeatable read";
      accessMode: "read only";
    }
  ): Promise<T>;
}

/** 返回支付订单固定用途谓词，防止未来其他订单类型混入充值报表。 */
function buildRechargePurposePredicate() {
  return inArray(paymentOrder.purpose, ["credit_top_up", "credit_package"]);
}

/** 构造与 `(created_at desc, id desc)` 排序严格对应的 cursor 谓词。 */
function buildOrderCursorPredicate(input: AdminPaymentOrderQuery) {
  if (!input.cursor) return undefined;
  const { createdAt, id, direction } = input.cursor;
  return direction === "previous"
    ? or(
        gt(paymentOrder.createdAt, createdAt),
        and(eq(paymentOrder.createdAt, createdAt), gt(paymentOrder.id, id))
      )
    : or(
        lt(paymentOrder.createdAt, createdAt),
        and(eq(paymentOrder.createdAt, createdAt), lt(paymentOrder.id, id))
      );
}

/** 对 ILIKE 搜索字符做字面量转义，避免用户输入 `%` 或 `_` 扩大匹配。 */
function escapeLikePattern(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

/** 构造列表与精确总数共用的充值用途、日期和管理筛选谓词。 */
function buildOrderWhere(input: AdminPaymentOrderCountQuery) {
  return and(
    buildRechargePurposePredicate(),
    gte(paymentOrder.createdAt, input.start),
    lt(paymentOrder.createdAt, input.endExclusive),
    lte(paymentOrder.createdAt, input.asOf),
    input.orderId ? eq(paymentOrder.id, input.orderId) : undefined,
    input.status ? eq(paymentOrder.status, input.status) : undefined,
    input.userEmail ? eq(user.email, input.userEmail) : undefined
  );
}

/** 读取当前管理员筛选和浏览上界内的精确订单总数。 */
async function countOrders(
  input: AdminPaymentOrderCountQuery,
  database: AdminPaymentTransaction = db
): Promise<number> {
  const [row] = await database
    .select({ totalCount: sql<number>`count(*)`.mapWith(Number) })
    .from(paymentOrder)
    .innerJoin(user, eq(user.id, paymentOrder.userId))
    .where(buildOrderWhere(input));
  return countSchema.parse(row?.totalCount ?? 0);
}

/** 按报告时区自然日与币种聚合已履约订单最小单位金额。 */
async function readOverviewRevenue(input: {
  start: Date;
  end: Date;
  timeZone: string;
}): Promise<AdminPaymentOverviewRevenueRow[]> {
  // fulfilled_at 是 UTC 瞬间的 timestamp without time zone；先按 UTC 解释，再转换为
  // 报告时区，避免数据库 session timezone 改变收入自然日归属。
  const date = sql<string>`to_char((${paymentOrder.fulfilledAt} at time zone 'UTC') at time zone ${input.timeZone}, 'YYYY-MM-DD')`;
  const rows = await db
    .select({
      date,
      currency: paymentOrder.currency,
      amountMinor:
        sql<number>`coalesce(sum(${paymentOrder.amountMinor}), 0)`.mapWith(
          Number
        ),
    })
    .from(paymentOrder)
    .where(
      and(
        buildRechargePurposePredicate(),
        eq(paymentOrder.status, "fulfilled"),
        isNotNull(paymentOrder.fulfilledAt),
        gte(paymentOrder.fulfilledAt, input.start),
        lt(paymentOrder.fulfilledAt, input.end)
      )
    )
    // 按投影序号分组可避免同一时区参数在 SELECT/GROUP BY 被 Drizzle 编成不同编号。
    .groupBy(sql.raw("1"), paymentOrder.currency)
    .orderBy(sql.raw("1"), paymentOrder.currency);
  return rows.map((row) => overviewRevenueRowSchema.parse(row));
}

/** 按部署报表时区的自然日与币种聚合全部状态订单，服务层再合并每日数量。 */
async function readOverviewOrderCounts(input: {
  start: Date;
  end: Date;
  timeZone: string;
}): Promise<AdminPaymentOverviewOrderCountRow[]> {
  // created_at 与 fulfilled_at 相同，都是承载 UTC 墙上值的 timestamp without time
  // zone；显式按 UTC 解释，确保数据库 session timezone 不改变订单自然日归属。
  const date = sql<string>`to_char((${paymentOrder.createdAt} at time zone 'UTC') at time zone ${input.timeZone}, 'YYYY-MM-DD')`;
  const rows = await db
    .select({
      date,
      currency: paymentOrder.currency,
      orderCount: sql<number>`count(*)`.mapWith(Number),
    })
    .from(paymentOrder)
    .where(
      and(
        buildRechargePurposePredicate(),
        gte(paymentOrder.createdAt, input.start),
        lt(paymentOrder.createdAt, input.end)
      )
    )
    .groupBy(sql.raw("1"), paymentOrder.currency)
    .orderBy(sql.raw("1"), paymentOrder.currency);
  return rows.map((row) => overviewOrderCountRowSchema.parse(row));
}

/** 读取一页全局充值订单；previous 查询升序取最近一页，服务层再反转为展示降序。 */
async function readOrders(
  input: AdminPaymentOrderQuery,
  database: AdminPaymentTransaction = db
): Promise<AdminPaymentOrderRow[]> {
  const rows = await database
    .select({
      id: paymentOrder.id,
      userId: paymentOrder.userId,
      userEmail: user.email,
      provider: paymentOrder.provider,
      purpose: paymentOrder.purpose,
      status: paymentOrder.status,
      currency: paymentOrder.currency,
      amountMinor: paymentOrder.amountMinor,
      creditsAmount: paymentOrder.creditsAmount,
      providerTradeNo: paymentOrder.providerTradeNo,
      createdAt: paymentOrder.createdAt,
      updatedAt: paymentOrder.updatedAt,
      expiresAt: paymentOrder.expiresAt,
      fulfilledAt: paymentOrder.fulfilledAt,
    })
    .from(paymentOrder)
    .innerJoin(user, eq(user.id, paymentOrder.userId))
    .where(and(buildOrderWhere(input), buildOrderCursorPredicate(input)))
    .orderBy(
      input.cursor?.direction === "previous"
        ? asc(paymentOrder.createdAt)
        : desc(paymentOrder.createdAt),
      input.cursor?.direction === "previous"
        ? asc(paymentOrder.id)
        : desc(paymentOrder.id)
    )
    .limit(input.limit);
  return rows.map((row) => orderRowSchema.parse(row));
}

/** 服务端搜索存在充值订单的用户，结果按最近一次下单时间排序并严格限量。 */
async function searchUsers(input: {
  query: string;
  limit: number;
}): Promise<Array<{ id: string; email: string }>> {
  const query = input.query.trim();
  const rows = await db
    .select({ id: user.id, email: user.email })
    .from(paymentOrder)
    .innerJoin(user, eq(user.id, paymentOrder.userId))
    .where(
      and(
        buildRechargePurposePredicate(),
        query ? ilike(user.email, `%${escapeLikePattern(query)}%`) : undefined
      )
    )
    .groupBy(user.id, user.email)
    .orderBy(desc(sql`max(${paymentOrder.createdAt})`), asc(user.email))
    .limit(input.limit);
  return rows.map((row) => userOptionSchema.parse(row));
}

/** 从数据库端口创建订单 count 与 rows 共用单一只读快照的仓储。 */
export function createAdminPaymentRepository(
  database: AdminPaymentTransactionDatabase
): AdminPaymentRepository {
  return {
    withReadOnlyOrderSnapshot<T>(
      work: (reader: AdminPaymentOrderSnapshotReader) => Promise<T>
    ): Promise<T> {
      return database.transaction(
        async (transaction) =>
          work({
            countOrders: (input) => countOrders(input, transaction),
            readOrders: (input) => readOrders(input, transaction),
          }),
        { isolationLevel: "repeatable read", accessMode: "read only" }
      );
    },
    readOverviewRevenue,
    readOverviewOrderCounts,
    searchUsers,
  };
}

/** 生产数据库仓储；列表分页固定在只读 repeatable-read 事务内。 */
export const databaseAdminPaymentRepository: AdminPaymentRepository =
  createAdminPaymentRepository(
    db as unknown as AdminPaymentTransactionDatabase
  );
