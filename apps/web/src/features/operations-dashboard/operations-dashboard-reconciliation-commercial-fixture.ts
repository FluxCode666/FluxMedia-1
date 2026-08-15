/**
 * 运营总览商业化 reconciliation reader 与支付阶段事实计算。
 *
 * 使用方：稳定组合入口与明细 repository。汇总和明细共用同一阶段布尔规则与
 * 首次事件时间，避免 characterization 内部出现两套支付口径。
 */
import type { OperationsPaymentLifecycleStage } from "@repo/shared/operations-dashboard/contracts";

import type {
  OperationsCommercialLifecycleCounts,
  OperationsCommercialSnapshotReader,
} from "./commercial-repository";
import type { OperationsGrowthRangeQuery } from "./growth-repository";
import {
  type ReconciliationPaymentEventType,
  type ReconciliationPaymentOrderFact,
  reconciliationHeader,
  reconciliationPaymentEvents,
  reconciliationPaymentOrders,
} from "./operations-dashboard-reconciliation-facts";
import { getReconciliationDistinctActivity } from "./operations-dashboard-reconciliation-growth-fixture";
import { isReconciliationFactInRange } from "./operations-dashboard-reconciliation-shared";

export type ReconciliationPaymentFlags = {
  readonly order: ReconciliationPaymentOrderFact;
  readonly hasCreated: boolean;
  readonly hasPayment: boolean;
  readonly hasFulfillment: boolean;
  readonly hasFailure: boolean;
  readonly createdTime: Date | null;
  readonly paymentTime: Date | null;
  readonly fulfillmentTime: Date | null;
  readonly failureTime: Date | null;
};

/**
 * 对支付事件建立每订单布尔阶段与各阶段首次业务时间。
 *
 * @param range 支付事件发生时间的半开范围。
 * @returns 仅包含范围内至少一个事件的订单阶段事实。
 */
export function buildReconciliationPaymentFlags(
  range: OperationsGrowthRangeQuery
): ReconciliationPaymentFlags[] {
  const events = reconciliationPaymentEvents.filter((event) =>
    isReconciliationFactInRange(event.occurredAt, range)
  );
  return reconciliationPaymentOrders.flatMap((order) => {
    const orderEvents = events.filter(
      (event) => event.paymentOrderId === order.id
    );
    if (orderEvents.length === 0) return [];
    const first = (
      types: readonly ReconciliationPaymentEventType[]
    ): Date | null =>
      orderEvents
        .filter((event) => types.includes(event.eventType))
        .map((event) => event.occurredAt)
        .sort((left, right) => left.getTime() - right.getTime())[0] ?? null;
    const has = (types: readonly ReconciliationPaymentEventType[]) =>
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

/**
 * 判断订单阶段事实是否命中汇总与明细共用的阶段定义。
 *
 * @param flags 单个订单在查询范围内的事件阶段事实。
 * @param stage 运营总览支付生命周期阶段。
 * @returns 命中对应阶段时返回 true。
 */
export function matchesReconciliationPaymentStage(
  flags: ReconciliationPaymentFlags,
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

/**
 * 返回单个支付阶段用于排序的首次事件时间。
 *
 * @param flags 单个订单在查询范围内的事件阶段事实。
 * @param stage 需要读取业务时间的支付阶段。
 * @returns 对应阶段的首次业务时间；阶段没有事件时返回 null。
 */
export function getReconciliationPaymentStageBusinessTime(
  flags: ReconciliationPaymentFlags,
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

/**
 * 计算商业化汇总服务使用的阶段数量。
 *
 * @param input 支付事件发生时间半开范围。
 * @returns 与生产 reader 字段一致的生命周期计数。
 */
function readReconciliationLifecycleCounts(
  input: OperationsGrowthRangeQuery
): OperationsCommercialLifecycleCounts {
  const flags = buildReconciliationPaymentFlags(input);
  return {
    createdOrders: flags.filter((value) => value.hasCreated).length,
    pendingOrders: flags.filter((value) =>
      matchesReconciliationPaymentStage(value, "pending_orders")
    ).length,
    paymentConfirmedOrders: flags.filter((value) => value.hasPayment).length,
    paidNotFulfilledOrders: flags.filter((value) =>
      matchesReconciliationPaymentStage(value, "paid_not_fulfilled_orders")
    ).length,
    fulfilledOrders: flags.filter((value) => value.hasFulfillment).length,
    failedOrders: flags.filter((value) => value.hasFailure).length,
  };
}

/**
 * 生成商业化汇总服务使用的真实端口 reader。
 *
 * @returns 只读取冻结支付事实的异步 reader，无外部副作用。
 */
export function createReconciliationCommercialReader(): OperationsCommercialSnapshotReader {
  return {
    async readHeader() {
      return reconciliationHeader;
    },
    async readLifecycleCounts(input) {
      return readReconciliationLifecycleCounts(input);
    },
    async readRevenue(input) {
      const indexed = new Map<string, number>();
      for (const order of reconciliationPaymentOrders) {
        if (
          order.status !== "fulfilled" ||
          !order.fulfilledAt ||
          !isReconciliationFactInRange(order.fulfilledAt, input)
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
      return getReconciliationDistinctActivity("payment", input).length;
    },
    async readActivityUserCount(kind, input) {
      return getReconciliationDistinctActivity(kind, input).length;
    },
  };
}
