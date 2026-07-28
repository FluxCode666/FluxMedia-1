/**
 * 使用日志数据库行到共享 UOL 契约的纯适配器。
 *
 * 使用方：usage-log 查询服务。数据库中的 prompt、metadata、storage key 和原始错误
 * 只能在本文件的窄输入中短暂存在，输出统一经过共享 Zod schema 收窄。
 */

import {
  classifyUsageBusinessType,
  mapUsageFailureCode,
  mapUsageStatus,
  type UsageBusinessType,
  type UsageEvent,
  type UsageEventDetail,
  type UsageSourceChannel,
  type UsageStatus,
  usageEventDetailSchema,
  usageEventSchema,
} from "@repo/shared/credits/usage-log-contract";
import { encodeUsageEventRef } from "@repo/shared/credits/usage-log-token";
import { normalizeSupportedModelId } from "@repo/shared/image-backend/supported-models";

/** 主查询返回的安全窄行；stableId 只进入签名引用，不进入响应字段。 */
export interface UsageLogListRow {
  eventKind: "request" | "refund";
  businessType: UsageBusinessType;
  relatedBusinessType?: UsageBusinessType | null;
  operationType: string;
  factKind: "request" | "refund" | "financial";
  generationMode: string | null;
  sourceChannel: UsageSourceChannel;
  eventAt: Date | string;
  eventKindRank: number;
  stableId: string;
  status: UsageStatus;
  rawStatus: string | null;
  grossConsumed: number;
  refundAmount: number;
}

/** 请求详情查询的窄行；rawError 只允许进入稳定错误分类器。 */
export interface UsageRequestDetailRow {
  businessType: Exclude<UsageBusinessType, "refund">;
  requestId: string;
  sourceChannel: UsageSourceChannel;
  status: Exclude<UsageStatus, "refund">;
  rawStatus: string | null;
  modelOrEndpoint: string | null;
  actualUsageValue: number | null;
  grossConsumed: number;
  refunded: number;
  createdAt: Date | string;
  completedAt: Date | string | null;
  rawError: string | null;
  hasResource: boolean;
}

/** 退款详情查询的窄行；原操作不存在时保持未关联。 */
export interface UsageRefundDetailRow {
  refundId: string;
  originalStableId: string | null;
  originalBusinessType: UsageBusinessType | null;
  originalRequestLabel: string;
  sourceChannel: UsageSourceChannel;
  refunded: number;
  createdAt: Date | string;
  resourceKind: "image" | "video" | null;
  resourceId: string | null;
}

/** 把数据库时间收窄为共享契约要求的带时区 ISO 字符串。 */
function toIsoDateTime(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new RangeError("Usage event date is invalid");
  }
  return parsed.toISOString();
}

/** 金额来自 DB numeric；无效或负数属于读模型损坏，拒绝静默修正。 */
function requireNonnegativeCredits(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a nonnegative finite number`);
  }
  return value;
}

/** 生成稳定且不含 prompt、模型参数或内部 metadata 的列表摘要。 */
function getSafeSummary(
  businessType: UsageBusinessType,
  isRefund: boolean
): string {
  if (isRefund) {
    if (businessType === "image") return "Image generation refund";
    if (businessType === "video") return "Video generation refund";
    return "Unlinked historical refund";
  }
  if (businessType === "image") return "Image generation";
  if (businessType === "video") return "Video generation";
  return "Historical usage";
}

/**
 * 把单条主查询行适配为列表契约。
 *
 * @param row 已在 SQL 数据源层通过本人和 relay 隐私谓词的窄行。
 * @param options 当前主体与签名密钥。
 * @returns 不暴露 stableId 的请求或退款行。
 */
export function adaptUsageListRow(
  row: UsageLogListRow,
  options: { userId: string; tokenSecret?: string }
): UsageEvent {
  const isRefund = row.eventKind === "refund";
  const amount = isRefund
    ? requireNonnegativeCredits(row.refundAmount, "refundAmount")
    : requireNonnegativeCredits(row.grossConsumed, "grossConsumed");
  const businessType = classifyUsageBusinessType({
    operationType: row.operationType,
    factKind: row.factKind,
    hasFinancialFact: isRefund || row.grossConsumed > 0,
    generationMode: row.generationMode,
  });
  if (!businessType || businessType !== row.businessType) {
    throw new RangeError("Usage business classification is inconsistent");
  }
  const status = mapUsageStatus({ businessType, status: row.rawStatus });
  if (status !== row.status) {
    throw new RangeError("Usage status classification is inconsistent");
  }
  return usageEventSchema.parse({
    kind: row.eventKind,
    eventRef: encodeUsageEventRef(
      {
        userId: options.userId,
        eventKind: row.eventKind,
        businessType,
        stableId: row.stableId,
      },
      options.tokenSecret
    ),
    eventAt: toIsoDateTime(row.eventAt),
    businessType,
    sourceChannel: row.sourceChannel,
    summary: getSafeSummary(
      isRefund ? (row.relatedBusinessType ?? "historical") : businessType,
      isRefund
    ),
    status,
    creditsDelta: isRefund ? amount : -amount,
  });
}

/**
 * 构造请求展开详情并在服务端完成错误脱敏与净额计算。
 *
 * @param row 当前用户单条权威请求及聚合金额。
 * @returns 共享 request detail；未知失败只得到 processing_failed。
 */
export function adaptRequestDetailRow(
  row: UsageRequestDetailRow
): UsageEventDetail {
  const status = mapUsageStatus({
    businessType: row.businessType,
    status: row.rawStatus,
  });
  if (status === "refund" || status !== row.status) {
    throw new RangeError("Usage detail status classification is inconsistent");
  }
  const grossConsumed = requireNonnegativeCredits(
    row.grossConsumed,
    "grossConsumed"
  );
  const refunded = requireNonnegativeCredits(row.refunded, "refunded");
  const actualUsage =
    row.actualUsageValue === null
      ? null
      : {
          unit:
            row.businessType === "video"
              ? ("seconds" as const)
              : ("images" as const),
          value: requireNonnegativeCredits(row.actualUsageValue, "actualUsage"),
        };
  const resourceRef =
    row.hasResource &&
    (row.businessType === "image" || row.businessType === "video")
      ? { kind: row.businessType, id: row.requestId }
      : null;
  return usageEventDetailSchema.parse({
    kind: "request",
    requestId: row.requestId,
    businessType: row.businessType,
    sourceChannel: row.sourceChannel,
    status,
    modelOrEndpoint:
      normalizeSupportedModelId(row.modelOrEndpoint) ?? row.modelOrEndpoint,
    actualUsage,
    grossConsumed,
    refunded,
    netConsumed: Math.max(0, grossConsumed - refunded),
    createdAt: toIsoDateTime(row.createdAt),
    completedAt: row.completedAt ? toIsoDateTime(row.completedAt) : null,
    failureCode: status === "failed" ? mapUsageFailureCode(row.rawError) : null,
    resourceRef,
  });
}

/**
 * 构造字段互斥的退款详情。
 *
 * @param row 当前用户单笔账本退款及可选原请求关联。
 * @param options 当前主体与签名密钥。
 * @returns 不含请求专属空占位的 refund detail。
 */
export function adaptRefundDetailRow(
  row: UsageRefundDetailRow,
  options: { userId: string; tokenSecret?: string }
): UsageEventDetail {
  const originalRequestRef =
    row.originalStableId &&
    row.originalBusinessType &&
    row.originalBusinessType !== "refund"
      ? encodeUsageEventRef(
          {
            userId: options.userId,
            eventKind: "request",
            businessType: row.originalBusinessType,
            stableId: row.originalStableId,
          },
          options.tokenSecret
        )
      : null;
  const resourceRef =
    row.resourceKind && row.resourceId
      ? { kind: row.resourceKind, id: row.resourceId }
      : null;
  return usageEventDetailSchema.parse({
    kind: "refund",
    refundId: row.refundId,
    originalRequestRef,
    originalRequestLabel: row.originalRequestLabel,
    sourceChannel: row.sourceChannel,
    refunded: requireNonnegativeCredits(row.refunded, "refunded"),
    createdAt: toIsoDateTime(row.createdAt),
    resourceRef,
  });
}
