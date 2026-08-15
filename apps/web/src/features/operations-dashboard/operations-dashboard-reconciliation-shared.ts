/**
 * 运营总览 reconciliation fixture 的时区与范围公共工具。
 *
 * 使用方：增长、商业化、内容和明细领域夹具。关键依赖为生产时区工具，确保
 * 内存事实使用与真实仓储一致的半开范围和自然日语义。
 */

import {
  formatDateInputInTimeZone,
  parseDateInputInTimeZone,
} from "@repo/shared/time-zone";
import type { OperationsGrowthRangeQuery } from "./growth-repository";

import { RECONCILIATION_TIME_ZONE } from "./operations-dashboard-reconciliation-facts";

/**
 * 判断事实业务时间是否落在 UTC 半开范围内。
 *
 * @param date 待判断的事实绝对时间。
 * @param range 已解析的查询半开范围。
 * @returns 落在 `[start, end)` 时返回 true，不产生副作用。
 */
export function isReconciliationFactInRange(
  date: Date,
  range: OperationsGrowthRangeQuery
): boolean {
  return date >= range.start && date < range.end;
}

/**
 * 把 UTC 时间转换成固定应用时区自然日。
 *
 * @param date 对账事实的绝对时间。
 * @returns `Asia/Shanghai` 下的 `YYYY-MM-DD`。
 */
export function toReconciliationAppDate(date: Date): string {
  return formatDateInputInTimeZone(date, RECONCILIATION_TIME_ZONE);
}

/**
 * 把应用自然日解析为夹具时区零点。
 *
 * @param appDate `YYYY-MM-DD` 应用自然日。
 * @returns 对应固定时区零点的绝对时间。
 * @throws Error 非法测试日期直接失败，避免静默污染对账结果。
 */
export function reconciliationAppDateStart(appDate: string): Date {
  const value = parseDateInputInTimeZone(appDate, {
    timeZone: RECONCILIATION_TIME_ZONE,
  });
  if (!value) throw new Error(`对账夹具日期无效：${appDate}`);
  return value;
}
