/**
 * 运营总览端到端对账使用的只读事实与冻结查询边界。
 *
 * 使用方：增长、商业化、内容与明细 reconciliation fixture。所有事实仅用于
 * DB-free characterization，不连接数据库，也不在测试运行期间修改。
 */
import type { OperationsDashboardQueryInput } from "@repo/shared/operations-dashboard/contracts";

import type { OperationsGrowthSnapshotHeader } from "./growth-repository";

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

export type ReconciliationUserFact = {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: string;
  readonly banned: boolean;
  readonly createdAt: Date;
};

export type ReconciliationVisitFact = {
  readonly userId: string;
  readonly visitedAt: Date;
};

export type ReconciliationOutputFact = {
  readonly taskId: string;
  readonly userId: string;
  readonly model: string;
  readonly mediaType: "image" | "video";
  readonly businessTime: Date;
  readonly quantity: number;
  readonly videoSeconds: number;
  readonly netCredits: number;
};

export type ReconciliationPaymentOrderFact = {
  readonly id: string;
  readonly providerTradeNo: string | null;
  readonly userId: string;
  readonly currency: string;
  readonly amountMinor: number;
  readonly status: string;
  readonly createdAt: Date;
  readonly fulfilledAt: Date | null;
};

export type ReconciliationPaymentEventType =
  | "order_created"
  | "checkout_ready"
  | "payment_confirmed"
  | "fulfillment_succeeded"
  | "checkout_failed"
  | "fulfillment_attempt_failed"
  | "fulfillment_failed_terminal"
  | "expired";

export type ReconciliationPaymentEventFact = {
  readonly id: string;
  readonly paymentOrderId: string;
  readonly eventType: ReconciliationPaymentEventType;
  readonly occurredAt: Date;
};

export const reconciliationUsers: readonly ReconciliationUserFact[] = [
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

export const reconciliationVisits: readonly ReconciliationVisitFact[] = [
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

export const reconciliationOutputs: readonly ReconciliationOutputFact[] = [
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

export const reconciliationPaymentOrders: readonly ReconciliationPaymentOrderFact[] =
  [
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

export const reconciliationPaymentEvents: readonly ReconciliationPaymentEventFact[] =
  [
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

export const reconciliationHeader: OperationsGrowthSnapshotHeader = {
  asOf: RECONCILIATION_AS_OF,
  epoch: RECONCILIATION_EPOCH,
};
