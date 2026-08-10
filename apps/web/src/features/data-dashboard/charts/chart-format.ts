/**
 * 用户数据看板常规图表的纯格式化工具。
 *
 * 使用方：Recharts 坐标轴。日期保持账号时区自然日字符串，不重新解析为浏览器日期，
 * 避免时区转换导致刻度跨日。
 */

/** 将 ISO 自然日压缩为月/日刻度。 */
export function formatDashboardDateTick(value: string): string {
  return value.slice(5).replace("-", "/");
}

/** 将坐标轴数值压缩为当前语言的紧凑格式。 */
export function formatDashboardAxisNumber(
  value: number,
  locale: string
): string {
  return new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}
