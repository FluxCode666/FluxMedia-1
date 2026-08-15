/**
 * 运营总览 reconciliation 明细 repository 与内存 keyset 分页。
 *
 * 使用方：稳定组合入口、明细服务与真实 CSV worker 对账。所有领域明细从汇总
 * reader 同一组冻结事实生成，确保全分页明细、CSV 与汇总可同源反算。
 */
import { addOperationsCalendarDays } from "@repo/shared/operations-dashboard/range";

import { toOperationsCursorTimestamp } from "./database-timestamp";
import type {
  OperationsCommercialDetailRow,
  OperationsContentDetailRow,
  OperationsDetailCursor,
  OperationsDetailQuery,
  OperationsDetailRepository,
  OperationsDetailRow,
  OperationsGrowthDetailRow,
} from "./detail-repository";
import {
  buildReconciliationPaymentFlags,
  getReconciliationPaymentStageBusinessTime,
  matchesReconciliationPaymentStage,
} from "./operations-dashboard-reconciliation-commercial-fixture";
import {
  type ReconciliationOutputFact,
  type ReconciliationPaymentOrderFact,
  type ReconciliationUserFact,
  reconciliationHeader,
  reconciliationOutputs,
  reconciliationPaymentEvents,
  reconciliationPaymentOrders,
  reconciliationUsers,
} from "./operations-dashboard-reconciliation-facts";
import {
  getReconciliationDistinctActivity,
  isReconciliationUserRetained,
} from "./operations-dashboard-reconciliation-growth-fixture";
import {
  isReconciliationFactInRange,
  reconciliationAppDateStart,
  toReconciliationAppDate,
} from "./operations-dashboard-reconciliation-shared";

/**
 * 把事实用户适配为增长明细行。
 *
 * @param user 冻结用户事实。
 * @param businessTime 当前 selection 对应的业务时间。
 * @param retained 留存查询结果；非留存明细传 null。
 * @returns 符合生产明细仓储契约的增长行。
 */
function toReconciliationGrowthRow(
  user: ReconciliationUserFact,
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
    businessTimeKey: toOperationsCursorTimestamp(businessTime),
    retained,
  };
}

/**
 * 把订单事实适配为安全商业化明细行。
 *
 * @param input 订单、行类型、稳定 ID、业务时间与可选生命周期事件。
 * @returns 符合生产明细仓储契约的商业化行。
 */
function toReconciliationCommercialRow(input: {
  order: ReconciliationPaymentOrderFact;
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
    businessTimeKey: toOperationsCursorTimestamp(input.businessTime),
    eventType: input.eventType,
  };
}

/**
 * 把成功产物事实适配为安全内容明细行。
 *
 * @param output 冻结成功产物事实。
 * @returns 符合生产明细仓储契约的内容行。
 */
function toReconciliationContentRow(
  output: ReconciliationOutputFact
): OperationsContentDetailRow {
  return {
    kind: "content",
    stableId: `${output.mediaType}:${output.taskId}`,
    taskId: output.taskId,
    userId: output.userId,
    model: output.model,
    mediaType: output.mediaType,
    businessTime: output.businessTime,
    businessTimeKey: toOperationsCursorTimestamp(output.businessTime),
    status: "completed",
    quantity: output.quantity,
    videoSeconds: output.videoSeconds,
    netCredits: output.netCredits,
    operationCreatedAtMismatch: false,
  };
}

/**
 * 返回联合明细行的稳定 keyset ID。
 *
 * @param row 任一领域的安全明细行。
 * @returns 商业化和内容使用 stableId，增长使用 userId。
 */
function getReconciliationStableId(row: OperationsDetailRow): string {
  if ("stableId" in row) return row.stableId;
  return row.userId;
}

/**
 * 按生产降序 keyset 规则排序、过滤 cursor 并应用 limit。
 *
 * @param rows 尚未分页的同领域明细行。
 * @param cursor 上一页末行游标；首屏传 null。
 * @param limit 仓储层需要返回的最大行数。
 * @returns 与生产 tuple keyset 顺序一致的当前页行。
 */
function paginateReconciliationRows(
  rows: OperationsDetailRow[],
  cursor: OperationsDetailCursor | null,
  limit: number
): OperationsDetailRow[] {
  return rows
    .filter((row) => {
      if (!cursor) return true;
      const timeDelta = row.businessTimeKey.localeCompare(
        cursor.businessTimeKey
      );
      return (
        timeDelta < 0 ||
        (timeDelta === 0 && getReconciliationStableId(row) < cursor.stableId)
      );
    })
    .sort((left, right) => {
      const timeDelta = right.businessTimeKey.localeCompare(
        left.businessTimeKey
      );
      return (
        timeDelta ||
        getReconciliationStableId(right).localeCompare(
          getReconciliationStableId(left)
        )
      );
    })
    .slice(0, limit);
}

/**
 * 按查询联合类型从同一事实集合生成明细行。
 *
 * @param input 明细服务或 CSV worker 构造的已验证查询。
 * @returns 应用生产 keyset 顺序与 limit 后的安全明细行。
 */
function readReconciliationDetailRows(
  input: OperationsDetailQuery
): OperationsDetailRow[] {
  let rows: OperationsDetailRow[];
  if (input.kind === "cumulative_users") {
    rows = reconciliationUsers
      .filter((user) => user.createdAt < input.end)
      .map((user) => toReconciliationGrowthRow(user, user.createdAt, null));
  } else if (input.kind === "users") {
    rows = reconciliationUsers
      .filter((user) => isReconciliationFactInRange(user.createdAt, input))
      .map((user) => toReconciliationGrowthRow(user, user.createdAt, null));
  } else if (input.kind === "activity") {
    rows = getReconciliationDistinctActivity(input.activityKind, input).flatMap(
      (activity) => {
        const user = reconciliationUsers.find(
          (candidate) => candidate.id === activity.userId
        );
        return user
          ? [toReconciliationGrowthRow(user, activity.businessTime, null)]
          : [];
      }
    );
  } else if (input.kind === "cohort" || input.kind === "cohort_export") {
    rows = reconciliationUsers
      .filter((user) => isReconciliationFactInRange(user.createdAt, input))
      .flatMap((user) => {
        let retained: boolean;
        if (input.kind === "cohort") {
          retained = reconciliationOutputs.some(
            (output) =>
              output.userId === user.id &&
              isReconciliationFactInRange(output.businessTime, {
                start: input.targetStart,
                end: input.targetEnd,
              })
          );
        } else {
          const targetDate = addOperationsCalendarDays(
            toReconciliationAppDate(user.createdAt),
            input.retentionDay
          );
          if (reconciliationAppDateStart(targetDate) > input.asOf) return [];
          retained = isReconciliationUserRetained(user, input.retentionDay);
        }
        return [toReconciliationGrowthRow(user, user.createdAt, retained)];
      });
  } else if (input.kind === "orders") {
    rows = reconciliationPaymentOrders
      .filter((order) => isReconciliationFactInRange(order.createdAt, input))
      .map((order) =>
        toReconciliationCommercialRow({
          order,
          kind: "orders",
          stableId: order.id,
          businessTime: order.createdAt,
          eventType: null,
        })
      );
  } else if (input.kind === "fulfilled_orders") {
    rows = reconciliationPaymentOrders.flatMap((order) =>
      order.status === "fulfilled" &&
      order.fulfilledAt &&
      isReconciliationFactInRange(order.fulfilledAt, input) &&
      (!input.currency || order.currency === input.currency)
        ? [
            toReconciliationCommercialRow({
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
    rows = reconciliationPaymentEvents.flatMap((event) => {
      const order = reconciliationPaymentOrders.find(
        (candidate) => candidate.id === event.paymentOrderId
      );
      return order && isReconciliationFactInRange(event.occurredAt, input)
        ? [
            toReconciliationCommercialRow({
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
    rows = buildReconciliationPaymentFlags(input).flatMap((flags) => {
      const businessTime = getReconciliationPaymentStageBusinessTime(
        flags,
        input.stage
      );
      return matchesReconciliationPaymentStage(flags, input.stage) &&
        businessTime &&
        (!input.currency || flags.order.currency === input.currency)
        ? [
            toReconciliationCommercialRow({
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
    rows = reconciliationOutputs
      .filter(
        (output) =>
          isReconciliationFactInRange(output.businessTime, input) &&
          (input.detail === "credit_usage" ||
            (input.detail === "image_outputs" &&
              output.mediaType === "image") ||
            (input.detail === "video_outputs" && output.mediaType === "video"))
      )
      .map(toReconciliationContentRow);
  }
  return paginateReconciliationRows(rows, input.cursor, input.limit);
}

/**
 * 生成明细服务与 CSV worker 共用的内存快照仓储。
 *
 * @returns 只读快照 repository；work 内异常原样上抛，不产生外部副作用。
 */
export function createReconciliationDetailRepository(): OperationsDetailRepository {
  return {
    async withReadOnlySnapshot(work) {
      return work({
        async readHeader() {
          return reconciliationHeader;
        },
        async readRows(input) {
          // 夹具事实本身就是冻结快照，高水位字段只验证 worker 能完整透传契约。
          return readReconciliationDetailRows(input);
        },
      });
    },
  };
}
