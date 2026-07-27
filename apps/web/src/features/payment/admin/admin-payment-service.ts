/**
 * 管理端充值支付 DB-free 应用服务。
 *
 * 使用方：支付 UOL binding。职责是解析管理员自然月、补齐每日零值、校验财务聚合、
 * 签发绑定管理员与筛选条件的 keyset cursor，并把仓储窄行收敛为稳定安全 DTO。
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import {
  type AdminPaymentOrder,
  type AdminPaymentOrderListOutput,
  type AdminPaymentOverviewOutput,
  type AdminPaymentUserSearchOutput,
  adminPaymentOrderListInputSchema,
  adminPaymentOrderSchema,
  adminPaymentOverviewInputSchema,
  adminPaymentOverviewOutputSchema,
  adminPaymentUserSearchInputSchema,
  adminPaymentUserSearchOutputSchema,
} from "@repo/shared/payment/admin-contract";
import {
  formatDateInputInTimeZone,
  parseDateInputInTimeZone,
} from "@repo/shared/time-zone";
import { z } from "zod";

const PAYMENT_CURSOR_VERSION = 1;
const PAYMENT_CURSOR_DOMAIN = "fluxmedia:admin-payment-orders:cursor:v1";
const PAYMENT_FILTER_DOMAIN = "fluxmedia:admin-payment-orders:filters:v1";
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

const paymentCursorFiltersSchema = z
  .object({
    limit: z.number().int().min(1).max(50),
    orderId: z.string().nullable(),
    status: z.string().nullable(),
    userEmail: z.string().nullable(),
  })
  .strict();

const paymentCursorPayloadSchema = z
  .object({
    v: z.literal(PAYMENT_CURSOR_VERSION),
    sub: z.string().min(1).max(512),
    filter: z.string().length(43),
    direction: z.enum(["next", "previous"]),
    asOf: z.string().datetime({ offset: true }),
    sortKey: z
      .object({
        createdAt: z.string().datetime({ offset: true }),
        id: z.string().min(1).max(128),
      })
      .strict(),
  })
  .strict();

export type AdminPaymentOverviewRevenueRow = {
  date: string;
  currency: string;
  amountMinor: number;
};

export type AdminPaymentOverviewOrderCountRow = {
  date: string;
  orderCount: number;
};

export type AdminPaymentOrderRow = Omit<
  AdminPaymentOrder,
  "createdAt" | "updatedAt" | "expiresAt" | "fulfilledAt"
> & {
  createdAt: Date | string;
  updatedAt: Date | string;
  expiresAt: Date | string | null;
  fulfilledAt: Date | string | null;
};

export type AdminPaymentOrderQuery = {
  asOf: Date;
  orderId: string | null;
  status: AdminPaymentOrder["status"] | null;
  userEmail: string | null;
  cursor: {
    createdAt: Date;
    id: string;
    direction: "next" | "previous";
  } | null;
  limit: number;
};

/** 支付管理仓储端口；所有实现必须只读取充值用途订单。 */
export interface AdminPaymentRepository {
  readOverviewRevenue(input: {
    start: Date;
    end: Date;
    timeZone: string;
  }): Promise<AdminPaymentOverviewRevenueRow[]>;
  readOverviewOrderCounts(input: {
    start: Date;
    end: Date;
    timeZone: string;
  }): Promise<AdminPaymentOverviewOrderCountRow[]>;
  readOrders(input: AdminPaymentOrderQuery): Promise<AdminPaymentOrderRow[]>;
  searchUsers(input: {
    query: string;
    limit: number;
  }): Promise<Array<{ id: string; email: string }>>;
}

/** 管理端支付查询的稳定校验错误，不携带原始 cursor 或数据库值。 */
export class AdminPaymentServiceError extends Error {
  readonly code = "validation_error" as const;

  /** 创建可安全映射到 UOL 的固定查询错误。 */
  constructor(message = "Invalid admin payment query") {
    super(message);
    this.name = "AdminPaymentServiceError";
  }
}

/** 将数据库日期严格转换为 UTC ISO；脏值必须显式失败。 */
function toIsoDateTime(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AdminPaymentServiceError();
  }
  return date.toISOString();
}

/** 计算 YYYY-MM 对应的下一自然月，不依赖服务器本地时区。 */
function getNextMonth(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  if (!year || !monthNumber) throw new AdminPaymentServiceError();
  const next = new Date(Date.UTC(year, monthNumber, 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(
    2,
    "0"
  )}`;
}

/** 枚举自然月内所有 YYYY-MM-DD，用于完整补零和未来日期占位。 */
function listMonthDates(month: string): string[] {
  const [year, monthNumber] = month.split("-").map(Number);
  if (!year || !monthNumber) throw new AdminPaymentServiceError();
  const dayCount = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return Array.from(
    { length: dayCount },
    (_, index) => `${month}-${String(index + 1).padStart(2, "0")}`
  );
}

/**
 * 将可选月份解析为管理员时区中的完整自然月 UTC 半开范围。
 *
 * @param input 已通过 UOL schema 的月份、管理员时区与查询时刻。
 * @returns 月份、连续日期和 UTC 边界；未来月份失败关闭。
 */
export function resolveAdminPaymentMonth(input: {
  month?: string;
  timeZone: string;
  asOf: Date;
}): {
  month: string;
  dates: string[];
  start: Date;
  end: Date;
} {
  if (Number.isNaN(input.asOf.getTime())) {
    throw new AdminPaymentServiceError();
  }
  const currentMonth = formatDateInputInTimeZone(
    input.asOf,
    input.timeZone
  ).slice(0, 7);
  const month = input.month ?? currentMonth;
  if (month > currentMonth) {
    throw new AdminPaymentServiceError("Future payment months are not allowed");
  }
  const start = parseDateInputInTimeZone(`${month}-01`, {
    timeZone: input.timeZone,
  });
  const end = parseDateInputInTimeZone(`${getNextMonth(month)}-01`, {
    timeZone: input.timeZone,
  });
  if (!start || !end || start >= end) throw new AdminPaymentServiceError();
  return { month, dates: listMonthDates(month), start, end };
}

/** 解析或测试注入签名密钥；缺失时不得签发可伪造 cursor。 */
function resolveCursorSecret(secret?: string): string {
  const value = secret ?? process.env.BETTER_AUTH_SECRET;
  if (!value?.trim()) {
    throw new Error("BETTER_AUTH_SECRET is required for payment cursors");
  }
  return value;
}

/** 对订单筛选生成固定长度 HMAC 指纹，防止 cursor 跨筛选复用。 */
function fingerprintFilters(
  filters: z.output<typeof paymentCursorFiltersSchema>,
  secret: string
): string {
  return createHmac("sha256", secret)
    .update(PAYMENT_FILTER_DOMAIN)
    .update("\0")
    .update(JSON.stringify(paymentCursorFiltersSchema.parse(filters)))
    .digest("base64url");
}

/** 使用独立域标签签名 cursor payload，禁止与其他模块 token 互换。 */
function signCursorPayload(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret)
    .update(PAYMENT_CURSOR_DOMAIN)
    .update("\0")
    .update(payload)
    .digest();
}

/** 签发绑定管理员、筛选、快照和排序键的订单 cursor。 */
function encodePaymentCursor(
  input: {
    actorUserId: string;
    filters: z.output<typeof paymentCursorFiltersSchema>;
    asOf: string;
    direction: "next" | "previous";
    sortKey: { createdAt: string; id: string };
  },
  secret?: string
): string {
  const resolvedSecret = resolveCursorSecret(secret);
  const payload = paymentCursorPayloadSchema.parse({
    v: PAYMENT_CURSOR_VERSION,
    sub: input.actorUserId,
    filter: fingerprintFilters(input.filters, resolvedSecret),
    direction: input.direction,
    asOf: input.asOf,
    sortKey: input.sortKey,
  });
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    "base64url"
  );
  const signature = signCursorPayload(encodedPayload, resolvedSecret).toString(
    "base64url"
  );
  return `${encodedPayload}.${signature}`;
}

/** 校验订单 cursor 的格式、签名、管理员、筛选指纹与快照上限。 */
function decodePaymentCursor(
  token: string,
  expected: {
    actorUserId: string;
    filters: z.output<typeof paymentCursorFiltersSchema>;
    asOfNotAfter: Date;
  },
  secret?: string
): {
  asOf: Date;
  direction: "next" | "previous";
  sortKey: { createdAt: Date; id: string };
} {
  try {
    const [payloadPart, signaturePart, extraPart] = token.split(".");
    if (
      !payloadPart ||
      !signaturePart ||
      extraPart !== undefined ||
      !BASE64URL_PATTERN.test(payloadPart) ||
      !BASE64URL_PATTERN.test(signaturePart)
    ) {
      throw new AdminPaymentServiceError();
    }
    const payloadBytes = Buffer.from(payloadPart, "base64url");
    const signatureBytes = Buffer.from(signaturePart, "base64url");
    if (
      payloadBytes.toString("base64url") !== payloadPart ||
      signatureBytes.toString("base64url") !== signaturePart
    ) {
      throw new AdminPaymentServiceError();
    }
    const resolvedSecret = resolveCursorSecret(secret);
    const expectedSignature = signCursorPayload(payloadPart, resolvedSecret);
    if (
      signatureBytes.length !== expectedSignature.length ||
      !timingSafeEqual(signatureBytes, expectedSignature)
    ) {
      throw new AdminPaymentServiceError();
    }
    const payload = paymentCursorPayloadSchema.parse(
      JSON.parse(payloadBytes.toString("utf8")) as unknown
    );
    const expectedFilter = fingerprintFilters(expected.filters, resolvedSecret);
    const left = Buffer.from(payload.filter);
    const right = Buffer.from(expectedFilter);
    const asOf = new Date(payload.asOf);
    const createdAt = new Date(payload.sortKey.createdAt);
    if (
      payload.sub !== expected.actorUserId ||
      left.length !== right.length ||
      !timingSafeEqual(left, right) ||
      asOf > expected.asOfNotAfter ||
      createdAt > asOf
    ) {
      throw new AdminPaymentServiceError();
    }
    return {
      asOf,
      direction: payload.direction,
      sortKey: { createdAt, id: payload.sortKey.id },
    };
  } catch (error) {
    if (error instanceof AdminPaymentServiceError) throw error;
    throw new AdminPaymentServiceError();
  }
}

/** 将仓储订单行转换为严格、可序列化的管理员 DTO。 */
function adaptPaymentOrderRow(row: AdminPaymentOrderRow): AdminPaymentOrder {
  return adminPaymentOrderSchema.parse({
    ...row,
    createdAt: toIsoDateTime(row.createdAt),
    updatedAt: toIsoDateTime(row.updatedAt),
    expiresAt: row.expiresAt ? toIsoDateTime(row.expiresAt) : null,
    fulfilledAt: row.fulfilledAt ? toIsoDateTime(row.fulfilledAt) : null,
  });
}

/**
 * 读取并补齐指定自然月的每日收入与充值订单数。
 *
 * WHY：收入按 fulfilled_at 统计已履约订单，订单量按 created_at 统计全部状态。两种
 * 时间口径不可从同一 SQL 分桶推导，否则待支付和失败订单会从订单趋势中消失。
 */
export async function loadAdminPaymentOverview(
  request: {
    timeZone: string;
    input: unknown;
    now?: Date;
  },
  dependencies: { repository: AdminPaymentRepository }
): Promise<AdminPaymentOverviewOutput> {
  const parsed = adminPaymentOverviewInputSchema.parse(request.input);
  const range = resolveAdminPaymentMonth({
    month: parsed.month,
    timeZone: request.timeZone,
    asOf: request.now ?? new Date(),
  });
  const [revenueRows, orderCountRows] = await Promise.all([
    dependencies.repository.readOverviewRevenue({
      start: range.start,
      end: range.end,
      timeZone: request.timeZone,
    }),
    dependencies.repository.readOverviewOrderCounts({
      start: range.start,
      end: range.end,
      timeZone: request.timeZone,
    }),
  ]);
  const knownDates = new Set(range.dates);
  const bucketAmounts = new Map<string, number>();
  const dailyCounts = new Map<string, number>();
  const totals = new Map<string, number>();
  const currencies = new Set<string>();

  for (const row of revenueRows) {
    const currency = row.currency.trim().toUpperCase();
    const bucketKey = `${row.date}\0${currency}`;
    if (
      !knownDates.has(row.date) ||
      !/^[A-Z]{3}$/.test(currency) ||
      !Number.isSafeInteger(row.amountMinor) ||
      row.amountMinor < 0 ||
      bucketAmounts.has(bucketKey)
    ) {
      throw new AdminPaymentServiceError();
    }
    bucketAmounts.set(bucketKey, row.amountMinor);
    totals.set(currency, (totals.get(currency) ?? 0) + row.amountMinor);
    currencies.add(currency);
  }

  for (const row of orderCountRows) {
    if (
      !knownDates.has(row.date) ||
      !Number.isSafeInteger(row.orderCount) ||
      row.orderCount < 0 ||
      dailyCounts.has(row.date)
    ) {
      throw new AdminPaymentServiceError();
    }
    dailyCounts.set(row.date, row.orderCount);
  }

  const sortedCurrencies = [...currencies].sort();
  const daily = range.dates.map((date) => ({
    date,
    orderCount: dailyCounts.get(date) ?? 0,
    revenue: sortedCurrencies.map((currency) => ({
      currency,
      amountMinor: bucketAmounts.get(`${date}\0${currency}`) ?? 0,
    })),
  }));
  return adminPaymentOverviewOutputSchema.parse({
    month: range.month,
    timeZone: request.timeZone,
    rangeStart: range.start.toISOString(),
    rangeEnd: range.end.toISOString(),
    rechargeOrderCount: daily.reduce((sum, point) => sum + point.orderCount, 0),
    revenueDayCount: daily.filter((point) =>
      point.revenue.some((item) => item.amountMinor > 0)
    ).length,
    revenueTotals: sortedCurrencies.map((currency) => ({
      currency,
      amountMinor: totals.get(currency) ?? 0,
    })),
    daily,
  });
}

/**
 * 读取一页全站充值订单并签发前后页 cursor。
 *
 * @param request 管理员身份、未信任筛选与可选测试时刻。
 * @param dependencies DB 仓储和可选测试签名密钥。
 * @returns 降序稳定订单及绑定当前管理员和筛选的分页 cursor。
 */
export async function loadAdminPaymentOrders(
  request: {
    actorUserId: string;
    input: unknown;
    now?: Date;
  },
  dependencies: {
    repository: AdminPaymentRepository;
    tokenSecret?: string;
  }
): Promise<AdminPaymentOrderListOutput> {
  const parsed = adminPaymentOrderListInputSchema.parse(request.input);
  const filters = paymentCursorFiltersSchema.parse({
    limit: parsed.limit,
    orderId: parsed.orderId ?? null,
    status: parsed.status ?? null,
    userEmail: parsed.userEmail ?? null,
  });
  const now = request.now ?? new Date();
  const decoded = parsed.cursor
    ? decodePaymentCursor(
        parsed.cursor,
        {
          actorUserId: request.actorUserId,
          filters,
          asOfNotAfter: now,
        },
        dependencies.tokenSecret
      )
    : null;
  const asOf = decoded?.asOf ?? now;
  const rows = await dependencies.repository.readOrders({
    asOf,
    orderId: parsed.orderId ?? null,
    status: parsed.status ?? null,
    userEmail: parsed.userEmail ?? null,
    cursor: decoded
      ? { ...decoded.sortKey, direction: decoded.direction }
      : null,
    limit: parsed.limit + 1,
  });
  const hasDirectionalExtra = rows.length > parsed.limit;
  const selectedRows = rows.slice(0, parsed.limit);
  if (decoded?.direction === "previous") selectedRows.reverse();
  const records = selectedRows.map(adaptPaymentOrderRow);
  const first = records[0];
  const last = records.at(-1);
  const sharedCursorInput = {
    actorUserId: request.actorUserId,
    filters,
    asOf: asOf.toISOString(),
  };
  const previousCursor =
    first &&
    decoded &&
    (decoded.direction !== "previous" || hasDirectionalExtra)
      ? encodePaymentCursor(
          {
            ...sharedCursorInput,
            direction: "previous",
            sortKey: { createdAt: first.createdAt, id: first.id },
          },
          dependencies.tokenSecret
        )
      : null;
  const nextCursor =
    last && (decoded?.direction === "previous" || hasDirectionalExtra)
      ? encodePaymentCursor(
          {
            ...sharedCursorInput,
            direction: "next",
            sortKey: { createdAt: last.createdAt, id: last.id },
          },
          dependencies.tokenSecret
        )
      : null;
  return { records, nextCursor, previousCursor };
}

/** 搜索存在充值订单的用户邮箱，并对仓储结果做严格输出校验。 */
export async function searchAdminPaymentOrderUsers(
  input: unknown,
  dependencies: { repository: AdminPaymentRepository }
): Promise<AdminPaymentUserSearchOutput> {
  const parsed = adminPaymentUserSearchInputSchema.parse(input);
  return adminPaymentUserSearchOutputSchema.parse({
    users: await dependencies.repository.searchUsers(parsed),
  });
}
