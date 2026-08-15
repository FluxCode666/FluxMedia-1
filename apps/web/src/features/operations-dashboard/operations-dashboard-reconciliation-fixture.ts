/**
 * 运营总览端到端口径对账的 DB-free 事实夹具。
 *
 * 使用方：reconciliation 集成测试。夹具用一组不可变内存事实实现增长、商业化、
 * 内容和明细仓储端口，使汇总、分页明细与真实 CSV worker 消费完全相同的数据。
 */
import type {
  OperationsDashboardQueryInput,
  OperationsExportType,
  OperationsPaymentLifecycleStage,
} from "@repo/shared/operations-dashboard/contracts";
import {
  addOperationsCalendarDays,
  type OperationsRangeBucket,
} from "@repo/shared/operations-dashboard/range";
import {
  formatDateInputInTimeZone,
  parseDateInputInTimeZone,
} from "@repo/shared/time-zone";

import type {
  OperationsCommercialLifecycleCounts,
  OperationsCommercialSnapshotReader,
} from "./commercial-repository";
import type {
  OperationsContentSeriesRow,
  OperationsContentSnapshotReader,
} from "./content-repository";
import type {
  OperationsCommercialDetailRow,
  OperationsContentDetailRow,
  OperationsDetailCursor,
  OperationsDetailQuery,
  OperationsDetailRepository,
  OperationsDetailRow,
  OperationsGrowthDetailRow,
} from "./detail-repository";
import type { ClaimedOperationsExportTask } from "./export-task-repository";
import type {
  OperationsGrowthActivityKind,
  OperationsGrowthBucketQuery,
  OperationsGrowthCohortQuery,
  OperationsGrowthCohortRow,
  OperationsGrowthRangeQuery,
  OperationsGrowthSnapshotHeader,
  OperationsGrowthSnapshotReader,
} from "./growth-repository";

export const RECONCILIATION_TIME_ZONE = "Asia/Shanghai";
export const RECONCILIATION_AS_OF = new Date("2026-08-15T04:00:00.000Z");
export const RECONCILIATION_EPOCH = {
  appDate: "2026-05-01",
  startsAt: new Date("2026-04-30T16:00:00.000Z"),
};
export const RECONCILIATION_QUERY = {
  granularity: "day",
  range: {
    kind: "custom",
    from: "2026-06-01",
    to: "2026-06-02",
  },
} satisfies OperationsDashboardQueryInput;

type UserFact = {
  id: string;
  name: string;
  email: string;
  role: string;
  banned: boolean;
  createdAt: Date;
};

type VisitFact = {
  userId: string;
  visitedAt: Date;
};

type OutputFact = {
  taskId: string;
  userId: string;
  model: string;
  mediaType: "image" | "video";
  businessTime: Date;
  quantity: number;
  videoSeconds: number;
  netCredits: number;
};

type PaymentOrderFact = {
  id: string;
  providerTradeNo: string | null;
  userId: string;
  currency: string;
  amountMinor: number;
  status: string;
  createdAt: Date;
  fulfilledAt: Date | null;
};

type PaymentEventType =
  | "order_created"
  | "checkout_ready"
  | "payment_confirmed"
  | "fulfillment_succeeded"
  | "checkout_failed"
  | "fulfillment_attempt_failed"
  | "fulfillment_failed_terminal"
  | "expired";

type PaymentEventFact = {
  id: string;
  paymentOrderId: string;
  eventType: PaymentEventType;
  occurredAt: Date;
};

type PaymentFlags = {
  order: PaymentOrderFact;
  hasCreated: boolean;
  hasPayment: boolean;
  hasFulfillment: boolean;
  hasFailure: boolean;
  createdTime: Date | null;
  paymentTime: Date | null;
  fulfillmentTime: Date | null;
  failureTime: Date | null;
};

const users: readonly UserFact[] = [
  {
    id: "user-base",
    name: "Base User",
    email: "base@example.com",
    role: "user",
    banned: false,
    createdAt: new Date("2026-04-10T09:00:00.000+08:00"),
  },
  {
    id: "user-previous",
    name: "Previous User",
    email: "previous@example.com",
    role: "user",
    banned: false,
    createdAt: new Date("2026-05-30T09:00:00.000+08:00"),
  },
  {
    id: "user-1",
    name: "Current One",
    email: "one@example.com",
    role: "user",
    banned: false,
    createdAt: new Date("2026-06-01T08:00:00.000+08:00"),
  },
  {
    id: "user-3",
    name: "API Only",
    email: "api-only@example.com",
    role: "user",
    banned: false,
    createdAt: new Date("2026-06-01T09:00:00.000+08:00"),
  },
  {
    id: "user-2",
    name: "Current Two",
    email: "two@example.com",
    role: "user",
    banned: false,
    createdAt: new Date("2026-06-02T08:00:00.000+08:00"),
  },
  {
    id: "admin-banned",
    name: "Banned Admin",
    email: "banned-admin@example.com",
    role: "admin",
    banned: true,
    createdAt: new Date("2026-06-02T09:00:00.000+08:00"),
  },
];

const visits: readonly VisitFact[] = [
  {
    userId: "user-previous",
    visitedAt: new Date("2026-05-30T10:00:00.000+08:00"),
  },
  {
    userId: "user-1",
    visitedAt: new Date("2026-06-01T10:00:00.000+08:00"),
  },
  {
    userId: "user-1",
    visitedAt: new Date("2026-06-01T11:00:00.000+08:00"),
  },
  {
    userId: "user-2",
    visitedAt: new Date("2026-06-02T10:00:00.000+08:00"),
  },
];

const outputs: readonly OutputFact[] = [
  {
    taskId: "previous-image",
    userId: "user-previous",
    model: "image-model",
    mediaType: "image",
    businessTime: new Date("2026-05-31T10:00:00.000+08:00"),
    quantity: 1,
    videoSeconds: 0,
    netCredits: 1,
  },
  {
    taskId: "image-u3-d0",
    userId: "user-3",
    model: "image-model",
    mediaType: "image",
    businessTime: new Date("2026-06-01T10:00:00.000+08:00"),
    quantity: 4,
    videoSeconds: 0,
    netCredits: 0.75,
  },
  {
    taskId: "image-u1-d1",
    userId: "user-1",
    model: "image-model",
    mediaType: "image",
    businessTime: new Date("2026-06-02T09:00:00.000+08:00"),
    quantity: 2,
    videoSeconds: 0,
    netCredits: 1.25,
  },
  {
    taskId: "image-u1-extra",
    userId: "user-1",
    model: "image-model",
    mediaType: "image",
    businessTime: new Date("2026-06-02T10:00:00.000+08:00"),
    quantity: 1,
    videoSeconds: 0,
    netCredits: 0,
  },
  {
    taskId: "video-u2-d0",
    userId: "user-2",
    model: "video-model",
    mediaType: "video",
    businessTime: new Date("2026-06-02T11:00:00.000+08:00"),
    quantity: 1,
    videoSeconds: 12,
    netCredits: 2.5,
  },
  {
    taskId: "image-u2-d1",
    userId: "user-2",
    model: "image-model",
    mediaType: "image",
    businessTime: new Date("2026-06-03T10:00:00.000+08:00"),
    quantity: 1,
    videoSeconds: 0,
    netCredits: 0.5,
  },
  {
    taskId: "video-u3-d7",
    userId: "user-3",
    model: "video-model",
    mediaType: "video",
    businessTime: new Date("2026-06-08T10:00:00.000+08:00"),
    quantity: 1,
    videoSeconds: 5,
    netCredits: 0.5,
  },
  {
    taskId: "image-u1-d30",
    userId: "user-1",
    model: "image-model",
    mediaType: "image",
    businessTime: new Date("2026-07-01T10:00:00.000+08:00"),
    quantity: 1,
    videoSeconds: 0,
    netCredits: 0.5,
  },
  {
    taskId: "image-u3-d30",
    userId: "user-3",
    model: "image-model",
    mediaType: "image",
    businessTime: new Date("2026-07-01T11:00:00.000+08:00"),
    quantity: 1,
    videoSeconds: 0,
    netCredits: 0.5,
  },
  {
    taskId: "image-u2-d30",
    userId: "user-2",
    model: "image-model",
    mediaType: "image",
    businessTime: new Date("2026-07-02T10:00:00.000+08:00"),
    quantity: 1,
    videoSeconds: 0,
    netCredits: 0.5,
  },
];

const paymentOrders: readonly PaymentOrderFact[] = [
  {
    id: "order-previous",
    providerTradeNo: "trade-previous",
    userId: "user-previous",
    currency: "CNY",
    amountMinor: 600,
    status: "fulfilled",
    createdAt: new Date("2026-05-30T12:00:00.000+08:00"),
    fulfilledAt: new Date("2026-05-31T12:00:00.000+08:00"),
  },
  {
    id: "order-1",
    providerTradeNo: "trade-1",
    userId: "user-1",
    currency: "CNY",
    amountMinor: 1000,
    status: "fulfilled",
    createdAt: new Date("2026-05-31T12:00:00.000+08:00"),
    fulfilledAt: new Date("2026-06-01T12:00:00.000+08:00"),
  },
  {
    id: "order-2",
    providerTradeNo: "trade-2",
    userId: "user-2",
    currency: "USD",
    amountMinor: 2500,
    status: "fulfilled",
    createdAt: new Date("2026-06-01T13:00:00.000+08:00"),
    fulfilledAt: new Date("2026-06-02T13:00:00.000+08:00"),
  },
  {
    id: "order-3",
    providerTradeNo: null,
    userId: "user-3",
    currency: "CNY",
    amountMinor: 500,
    status: "pending",
    createdAt: new Date("2026-06-01T14:00:00.000+08:00"),
    fulfilledAt: null,
  },
  {
    id: "order-4",
    providerTradeNo: null,
    userId: "user-3",
    currency: "CNY",
    amountMinor: 700,
    status: "failed",
    createdAt: new Date("2026-06-02T14:00:00.000+08:00"),
    fulfilledAt: null,
  },
  {
    id: "order-5",
    providerTradeNo: "trade-5",
    userId: "user-3",
    currency: "USD",
    amountMinor: 1000,
    status: "paid",
    createdAt: new Date("2026-06-02T15:00:00.000+08:00"),
    fulfilledAt: null,
  },
];

const paymentEvents: readonly PaymentEventFact[] = [
  {
    id: "event-previous-created",
    paymentOrderId: "order-previous",
    eventType: "order_created",
    occurredAt: new Date("2026-05-30T12:00:00.000+08:00"),
  },
  {
    id: "event-previous-paid",
    paymentOrderId: "order-previous",
    eventType: "payment_confirmed",
    occurredAt: new Date("2026-05-31T11:00:00.000+08:00"),
  },
  {
    id: "event-previous-fulfilled",
    paymentOrderId: "order-previous",
    eventType: "fulfillment_succeeded",
    occurredAt: new Date("2026-05-31T12:00:00.000+08:00"),
  },
  {
    id: "event-1-created",
    paymentOrderId: "order-1",
    eventType: "order_created",
    occurredAt: new Date("2026-05-31T12:00:00.000+08:00"),
  },
  {
    id: "event-1-paid",
    paymentOrderId: "order-1",
    eventType: "payment_confirmed",
    occurredAt: new Date("2026-06-01T11:00:00.000+08:00"),
  },
  {
    id: "event-1-fulfilled",
    paymentOrderId: "order-1",
    eventType: "fulfillment_succeeded",
    occurredAt: new Date("2026-06-01T12:00:00.000+08:00"),
  },
  {
    id: "event-2-created",
    paymentOrderId: "order-2",
    eventType: "order_created",
    occurredAt: new Date("2026-06-01T13:00:00.000+08:00"),
  },
  {
    id: "event-2-paid",
    paymentOrderId: "order-2",
    eventType: "payment_confirmed",
    occurredAt: new Date("2026-06-02T12:00:00.000+08:00"),
  },
  {
    id: "event-2-fulfilled",
    paymentOrderId: "order-2",
    eventType: "fulfillment_succeeded",
    occurredAt: new Date("2026-06-02T13:00:00.000+08:00"),
  },
  {
    id: "event-3-created",
    paymentOrderId: "order-3",
    eventType: "order_created",
    occurredAt: new Date("2026-06-01T14:00:00.000+08:00"),
  },
  {
    id: "event-4-created",
    paymentOrderId: "order-4",
    eventType: "order_created",
    occurredAt: new Date("2026-06-02T14:00:00.000+08:00"),
  },
  {
    id: "event-4-failed",
    paymentOrderId: "order-4",
    eventType: "checkout_failed",
    occurredAt: new Date("2026-06-02T14:01:00.000+08:00"),
  },
  {
    id: "event-5-created",
    paymentOrderId: "order-5",
    eventType: "order_created",
    occurredAt: new Date("2026-06-02T15:00:00.000+08:00"),
  },
  {
    id: "event-5-paid",
    paymentOrderId: "order-5",
    eventType: "payment_confirmed",
    occurredAt: new Date("2026-06-02T15:01:00.000+08:00"),
  },
];

const header: OperationsGrowthSnapshotHeader = {
  asOf: RECONCILIATION_AS_OF,
  epoch: RECONCILIATION_EPOCH,
};

/** 判断业务时间是否落在 UTC 半开范围内。 */
function isInRange(date: Date, range: OperationsGrowthRangeQuery): boolean {
  return date >= range.start && date < range.end;
}

/**
 * 把 UTC 时间转换成固定应用时区自然日。
 *
 * @param date 对账事实的绝对时间。
 * @returns `Asia/Shanghai` 下的 `YYYY-MM-DD`。
 */
function toAppDate(date: Date): string {
  return formatDateInputInTimeZone(date, RECONCILIATION_TIME_ZONE);
}

/** 把应用自然日解析为夹具时区零点，非法测试数据直接失败。 */
function appDateStart(appDate: string): Date {
  const value = parseDateInputInTimeZone(appDate, {
    timeZone: RECONCILIATION_TIME_ZONE,
  });
  if (!value) throw new Error(`对账夹具日期无效：${appDate}`);
  return value;
}

/** 返回某类活跃事实的原始用户与业务时间。 */
function getActivityFacts(
  kind: OperationsGrowthActivityKind
): Array<{ userId: string; businessTime: Date }> {
  if (kind === "login") {
    return visits.map((visit) => ({
      userId: visit.userId,
      businessTime: visit.visitedAt,
    }));
  }
  if (kind === "creation") {
    return outputs.map((output) => ({
      userId: output.userId,
      businessTime: output.businessTime,
    }));
  }
  return paymentOrders.flatMap((order) =>
    order.status === "fulfilled" && order.fulfilledAt
      ? [{ userId: order.userId, businessTime: order.fulfilledAt }]
      : []
  );
}

/** 对范围内活跃事实按用户去重并保留首次业务时间。 */
function getDistinctActivity(
  kind: OperationsGrowthActivityKind,
  range: OperationsGrowthRangeQuery
): Array<{ userId: string; businessTime: Date }> {
  const indexed = new Map<string, Date>();
  for (const fact of getActivityFacts(kind)) {
    if (!isInRange(fact.businessTime, range)) continue;
    const existing = indexed.get(fact.userId);
    if (!existing || fact.businessTime < existing) {
      indexed.set(fact.userId, fact.businessTime);
    }
  }
  return Array.from(indexed, ([userId, businessTime]) => ({
    userId,
    businessTime,
  }));
}

/** 根据事实计算单个趋势桶的去重用户数。 */
function countActivityBucket(
  kind: OperationsGrowthActivityKind,
  bucket: OperationsGrowthBucketQuery
): number {
  if (!bucket.dataFrom) return 0;
  return getDistinctActivity(kind, {
    start: bucket.dataFrom,
    end: bucket.end,
  }).length;
}

/** 判断用户是否在注册后的精确自然日产生过成功内容。 */
function isRetained(user: UserFact, retentionDay: 1 | 7 | 30): boolean {
  const targetDate = addOperationsCalendarDays(
    toAppDate(user.createdAt),
    retentionDay
  );
  return outputs.some(
    (output) =>
      output.userId === user.id && toAppDate(output.businessTime) === targetDate
  );
}

/** 计算与生产 SQL 相同的 Cohort 稀疏聚合行。 */
function readCohortFacts(
  input: OperationsGrowthCohortQuery
): OperationsGrowthCohortRow[] {
  const indexed = new Map<string, UserFact[]>();
  for (const user of users) {
    if (!isInRange(user.createdAt, input)) continue;
    const date = toAppDate(user.createdAt);
    indexed.set(date, [...(indexed.get(date) ?? []), user]);
  }
  return Array.from(indexed, ([cohortDate, cohortUsers]) => ({
    cohortDate,
    cohortSize: cohortUsers.length,
    retainedD1: cohortUsers.filter((user) => isRetained(user, 1)).length,
    retainedD7: cohortUsers.filter((user) => isRetained(user, 7)).length,
    retainedD30: cohortUsers.filter((user) => isRetained(user, 30)).length,
  })).sort((left, right) => left.cohortDate.localeCompare(right.cohortDate));
}

/** 生成增长汇总服务使用的真实端口 reader。 */
function createGrowthReader(): OperationsGrowthSnapshotReader {
  return {
    async readHeader() {
      return header;
    },
    async readCumulativeUserCount(end) {
      return users.filter((user) => user.createdAt < end).length;
    },
    async readNewUserCount(input) {
      return users.filter((user) => isInRange(user.createdAt, input)).length;
    },
    async readActivityUserCount(kind, input) {
      return getDistinctActivity(kind, input).length;
    },
    async readNewUserSeries(buckets) {
      return buckets.flatMap((bucket) =>
        bucket.dataFrom
          ? [
              {
                bucketKey: bucket.key,
                userCount: users.filter((user) =>
                  isInRange(user.createdAt, {
                    start: bucket.dataFrom as Date,
                    end: bucket.end,
                  })
                ).length,
              },
            ]
          : []
      );
    },
    async readActivitySeries(kind, buckets) {
      return buckets.flatMap((bucket) =>
        bucket.dataFrom
          ? [
              {
                bucketKey: bucket.key,
                userCount: countActivityBucket(kind, bucket),
              },
            ]
          : []
      );
    },
    async readCohorts(input) {
      return readCohortFacts(input);
    },
  };
}

/** 对支付事件建立每订单布尔阶段与各阶段首次业务时间。 */
function buildPaymentFlags(range: OperationsGrowthRangeQuery): PaymentFlags[] {
  const events = paymentEvents.filter((event) =>
    isInRange(event.occurredAt, range)
  );
  return paymentOrders.flatMap((order) => {
    const orderEvents = events.filter(
      (event) => event.paymentOrderId === order.id
    );
    if (orderEvents.length === 0) return [];
    const first = (types: readonly PaymentEventType[]): Date | null =>
      orderEvents
        .filter((event) => types.includes(event.eventType))
        .map((event) => event.occurredAt)
        .sort((left, right) => left.getTime() - right.getTime())[0] ?? null;
    const has = (types: readonly PaymentEventType[]) =>
      orderEvents.some((event) => types.includes(event.eventType));
    return [
      {
        order,
        hasCreated: has(["order_created"]),
        hasPayment: has(["payment_confirmed"]),
        hasFulfillment: has(["fulfillment_succeeded"]),
        hasFailure: has([
          "checkout_failed",
          "fulfillment_failed_terminal",
          "expired",
        ]),
        createdTime: first(["order_created"]),
        paymentTime: first(["payment_confirmed"]),
        fulfillmentTime: first(["fulfillment_succeeded"]),
        failureTime: first([
          "checkout_failed",
          "fulfillment_failed_terminal",
          "expired",
        ]),
      },
    ];
  });
}

/** 判断订单阶段布尔值是否命中汇总与明细共用的阶段定义。 */
function matchesPaymentStage(
  flags: PaymentFlags,
  stage: OperationsPaymentLifecycleStage
): boolean {
  switch (stage) {
    case "created_orders":
      return flags.hasCreated;
    case "pending_orders":
      return (
        flags.hasCreated &&
        !flags.hasPayment &&
        !flags.hasFulfillment &&
        !flags.hasFailure
      );
    case "payment_confirmed_orders":
      return flags.hasPayment;
    case "paid_not_fulfilled_orders":
      return flags.hasPayment && !flags.hasFulfillment && !flags.hasFailure;
    case "fulfilled_orders":
      return flags.hasFulfillment;
    case "failed_orders":
      return flags.hasFailure;
  }
}

/** 返回单个支付阶段用于排序的首次事件时间。 */
function getPaymentStageBusinessTime(
  flags: PaymentFlags,
  stage: OperationsPaymentLifecycleStage
): Date | null {
  switch (stage) {
    case "created_orders":
    case "pending_orders":
      return flags.createdTime;
    case "payment_confirmed_orders":
    case "paid_not_fulfilled_orders":
      return flags.paymentTime;
    case "fulfilled_orders":
      return flags.fulfillmentTime;
    case "failed_orders":
      return flags.failureTime;
  }
}

/** 计算商业化汇总服务使用的阶段数量。 */
function readLifecycleCounts(
  input: OperationsGrowthRangeQuery
): OperationsCommercialLifecycleCounts {
  const flags = buildPaymentFlags(input);
  return {
    createdOrders: flags.filter((value) => value.hasCreated).length,
    pendingOrders: flags.filter((value) =>
      matchesPaymentStage(value, "pending_orders")
    ).length,
    paymentConfirmedOrders: flags.filter((value) => value.hasPayment).length,
    paidNotFulfilledOrders: flags.filter((value) =>
      matchesPaymentStage(value, "paid_not_fulfilled_orders")
    ).length,
    fulfilledOrders: flags.filter((value) => value.hasFulfillment).length,
    failedOrders: flags.filter((value) => value.hasFailure).length,
  };
}

/** 生成商业化汇总服务使用的真实端口 reader。 */
function createCommercialReader(): OperationsCommercialSnapshotReader {
  return {
    async readHeader() {
      return header;
    },
    async readLifecycleCounts(input) {
      return readLifecycleCounts(input);
    },
    async readRevenue(input) {
      const indexed = new Map<string, number>();
      for (const order of paymentOrders) {
        if (
          order.status !== "fulfilled" ||
          !order.fulfilledAt ||
          !isInRange(order.fulfilledAt, input)
        ) {
          continue;
        }
        indexed.set(
          order.currency,
          (indexed.get(order.currency) ?? 0) + order.amountMinor
        );
      }
      return Array.from(indexed, ([currency, amountMinor]) => ({
        currency,
        amountMinor,
      }));
    },
    async readPayingUserCount(input) {
      return getDistinctActivity("payment", input).length;
    },
    async readActivityUserCount(kind, input) {
      return getDistinctActivity(kind, input).length;
    },
  };
}

/** 计算内容汇总服务的单个真实趋势桶。 */
function readContentBucket(
  bucket: OperationsGrowthBucketQuery
): OperationsContentSeriesRow | null {
  if (!bucket.dataFrom) return null;
  const scoped = outputs.filter((output) =>
    isInRange(output.businessTime, {
      start: bucket.dataFrom as Date,
      end: bucket.end,
    })
  );
  return {
    bucketKey: bucket.key,
    imageCount: scoped
      .filter((output) => output.mediaType === "image")
      .reduce((sum, output) => sum + output.quantity, 0),
    videoCount: scoped.filter((output) => output.mediaType === "video").length,
    videoSeconds: scoped.reduce((sum, output) => sum + output.videoSeconds, 0),
    creditHundredths: scoped.reduce(
      (sum, output) => sum + Math.round(output.netCredits * 100),
      0
    ),
    operationCreatedAtMismatchCount: 0,
  };
}

/** 生成内容汇总服务使用的真实端口 reader。 */
function createContentReader(): OperationsContentSnapshotReader {
  return {
    async readHeader() {
      return {
        ...header,
        outputUsage: { version: 1, status: "ready" },
        creditUsage: { version: 1, status: "ready" },
      };
    },
    async readSeries(buckets) {
      return buckets.flatMap((bucket) => {
        const row = readContentBucket(bucket);
        return row ? [row] : [];
      });
    },
  };
}

/** 把事实用户适配为增长明细行。 */
function toGrowthRow(
  user: UserFact,
  businessTime: Date,
  retained: boolean | null
): OperationsGrowthDetailRow {
  return {
    kind: "growth",
    userId: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    banned: user.banned,
    businessTime,
    retained,
  };
}

/** 把订单事实适配为安全商业化明细行。 */
function toCommercialRow(input: {
  order: PaymentOrderFact;
  kind: OperationsCommercialDetailRow["kind"];
  stableId: string;
  businessTime: Date;
  eventType: string | null;
}): OperationsCommercialDetailRow {
  return {
    kind: input.kind,
    stableId: input.stableId,
    paymentOrderId: input.order.id,
    providerTradeNo: input.order.providerTradeNo,
    userId: input.order.userId,
    currency: input.order.currency,
    amountMinor: input.order.amountMinor,
    orderStatus: input.order.status,
    createdAt: input.order.createdAt,
    fulfilledAt: input.order.fulfilledAt,
    businessTime: input.businessTime,
    eventType: input.eventType,
  };
}

/** 把成功产物事实适配为安全内容明细行。 */
function toContentRow(output: OutputFact): OperationsContentDetailRow {
  return {
    kind: "content",
    stableId: `${output.mediaType}:${output.taskId}`,
    taskId: output.taskId,
    userId: output.userId,
    model: output.model,
    mediaType: output.mediaType,
    businessTime: output.businessTime,
    status: "completed",
    quantity: output.quantity,
    videoSeconds: output.videoSeconds,
    netCredits: output.netCredits,
    operationCreatedAtMismatch: false,
  };
}

/** 返回联合明细行的稳定 keyset ID。 */
function getStableId(row: OperationsDetailRow): string {
  if ("stableId" in row) return row.stableId;
  return row.userId;
}

/** 按生产降序 keyset 规则排序、过滤 cursor 并应用 limit。 */
function paginateRows(
  rows: OperationsDetailRow[],
  cursor: OperationsDetailCursor | null,
  limit: number
): OperationsDetailRow[] {
  return rows
    .filter((row) => {
      if (!cursor) return true;
      const timeDelta =
        row.businessTime.getTime() - cursor.businessTime.getTime();
      return (
        timeDelta < 0 || (timeDelta === 0 && getStableId(row) < cursor.stableId)
      );
    })
    .sort((left, right) => {
      const timeDelta =
        right.businessTime.getTime() - left.businessTime.getTime();
      return timeDelta || getStableId(right).localeCompare(getStableId(left));
    })
    .slice(0, limit);
}

/** 按查询联合类型从同一事实集合生成明细行。 */
function readDetailRows(input: OperationsDetailQuery): OperationsDetailRow[] {
  let rows: OperationsDetailRow[];
  if (input.kind === "cumulative_users") {
    rows = users
      .filter((user) => user.createdAt < input.end)
      .map((user) => toGrowthRow(user, user.createdAt, null));
  } else if (input.kind === "users") {
    rows = users
      .filter((user) => isInRange(user.createdAt, input))
      .map((user) => toGrowthRow(user, user.createdAt, null));
  } else if (input.kind === "activity") {
    rows = getDistinctActivity(input.activityKind, input).flatMap(
      (activity) => {
        const user = users.find(
          (candidate) => candidate.id === activity.userId
        );
        return user ? [toGrowthRow(user, activity.businessTime, null)] : [];
      }
    );
  } else if (input.kind === "cohort" || input.kind === "cohort_export") {
    rows = users
      .filter((user) => isInRange(user.createdAt, input))
      .flatMap((user) => {
        let retained: boolean;
        if (input.kind === "cohort") {
          retained = outputs.some(
            (output) =>
              output.userId === user.id &&
              isInRange(output.businessTime, {
                start: input.targetStart,
                end: input.targetEnd,
              })
          );
        } else {
          const targetDate = addOperationsCalendarDays(
            toAppDate(user.createdAt),
            input.retentionDay
          );
          if (appDateStart(targetDate) > input.asOf) return [];
          retained = isRetained(user, input.retentionDay);
        }
        return [toGrowthRow(user, user.createdAt, retained)];
      });
  } else if (input.kind === "orders") {
    rows = paymentOrders
      .filter((order) => isInRange(order.createdAt, input))
      .map((order) =>
        toCommercialRow({
          order,
          kind: "orders",
          stableId: order.id,
          businessTime: order.createdAt,
          eventType: null,
        })
      );
  } else if (input.kind === "fulfilled_orders") {
    rows = paymentOrders.flatMap((order) =>
      order.status === "fulfilled" &&
      order.fulfilledAt &&
      isInRange(order.fulfilledAt, input) &&
      (!input.currency || order.currency === input.currency)
        ? [
            toCommercialRow({
              order,
              kind: "fulfilled_orders",
              stableId: order.id,
              businessTime: order.fulfilledAt,
              eventType: null,
            }),
          ]
        : []
    );
  } else if (input.kind === "payment_lifecycle") {
    rows = paymentEvents.flatMap((event) => {
      const order = paymentOrders.find(
        (candidate) => candidate.id === event.paymentOrderId
      );
      return order && isInRange(event.occurredAt, input)
        ? [
            toCommercialRow({
              order,
              kind: "payment_lifecycle",
              stableId: event.id,
              businessTime: event.occurredAt,
              eventType: event.eventType,
            }),
          ]
        : [];
    });
  } else if (input.kind === "payment_stage") {
    rows = buildPaymentFlags(input).flatMap((flags) => {
      const businessTime = getPaymentStageBusinessTime(flags, input.stage);
      return matchesPaymentStage(flags, input.stage) &&
        businessTime &&
        (!input.currency || flags.order.currency === input.currency)
        ? [
            toCommercialRow({
              order: flags.order,
              kind: "payment_stage",
              stableId: flags.order.id,
              businessTime,
              eventType: input.stage,
            }),
          ]
        : [];
    });
  } else {
    rows = outputs
      .filter(
        (output) =>
          isInRange(output.businessTime, input) &&
          (input.detail === "credit_usage" ||
            (input.detail === "image_outputs" &&
              output.mediaType === "image") ||
            (input.detail === "video_outputs" && output.mediaType === "video"))
      )
      .map(toContentRow);
  }
  return paginateRows(rows, input.cursor, input.limit);
}

/** 生成明细服务与 CSV worker 共用的内存快照仓储。 */
function createDetailRepository(): OperationsDetailRepository {
  return {
    async withReadOnlySnapshot(work) {
      return work({
        async readHeader() {
          return header;
        },
        async readRows(input) {
          // 夹具事实本身就是冻结快照，高水位字段只验证 worker 能完整透传契约。
          return readDetailRows(input);
        },
      });
    },
  };
}

/** 构造三类使用同一冻结范围、时区、epoch 与高水位的 worker 任务。 */
export function createReconciliationExportTasks(): ClaimedOperationsExportTask[] {
  const highWatermarks = {
    users: null,
    webVisits: null,
    outputs: null,
    paymentOrders: null,
    paymentLifecycle: null,
    creditContributions: null,
  };
  return (
    [
      "user_growth",
      "commercialization",
      "content_production",
    ] satisfies OperationsExportType[]
  ).map((exportType, index) => ({
    id: `reconciliation-${exportType}`,
    createdBy: "admin-reconciliation",
    exportType,
    query: RECONCILIATION_QUERY,
    timeZone: RECONCILIATION_TIME_ZONE,
    epochAppDate: RECONCILIATION_EPOCH.appDate,
    epochStartsAt: RECONCILIATION_EPOCH.startsAt,
    schemaVersion: 1,
    snapshotAt: RECONCILIATION_AS_OF,
    highWatermarks,
    leaseOwner: "worker-reconciliation",
    leaseToken: `lease-${index + 1}`,
    attemptCount: 1,
  }));
}

/** 单组事实对外暴露的四个真实应用端口。 */
export function createOperationsReconciliationFixture(): {
  growthReader: OperationsGrowthSnapshotReader;
  commercialReader: OperationsCommercialSnapshotReader;
  contentReader: OperationsContentSnapshotReader;
  detailRepository: OperationsDetailRepository;
} {
  return {
    growthReader: createGrowthReader(),
    commercialReader: createCommercialReader(),
    contentReader: createContentReader(),
    detailRepository: createDetailRepository(),
  };
}

/** 把 resolved range 桶收窄为明细 selection 使用的闭区间日期。 */
export function toDetailBucket(
  bucket: Pick<OperationsRangeBucket, "from" | "to">
): { from: string; to: string } {
  return { from: bucket.from, to: bucket.to };
}
