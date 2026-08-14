/**
 * Dashboard 跨自然日访问记录器的 DB-free 日期判断。
 *
 * 使用方：客户端可见性监听器与 Vitest。这里只决定何时发起请求，最终日期仍由服务端
 * APP_TIME_ZONE 和服务器时钟派生，客户端值不能进入事实写入。
 */
import { formatDateInputInTimeZone } from "@repo/shared/time-zone";

/**
 * 格式化浏览器当前瞬间在应用时区中的自然日。
 *
 * @param now 浏览器当前瞬间，仅用于触发时机。
 * @param timeZone 服务端下发的应用 IANA 时区。
 * @returns YYYY-MM-DD 自然日标签；无副作用。
 */
export function formatClientAppDate(now: Date, timeZone: string): string {
  return formatDateInputInTimeZone(now, timeZone);
}

/**
 * 判断页面重新可见时是否已经进入服务端尚未记录的新应用自然日。
 *
 * @param currentAppDate 浏览器当前应用日。
 * @param lastRecordedAppDate 最近由服务端确认的应用日；null 表示需要补试。
 * @returns 日期不同或尚无成功记录时为 true；无副作用。
 */
export function shouldRecordVisibleVisit(
  currentAppDate: string,
  lastRecordedAppDate: string | null
): boolean {
  return currentAppDate !== lastRecordedAppDate;
}
