/**
 * 运营统计 PostgreSQL 精确时间参数工具。
 *
 * 使用方：导出高水位相关仓储。冻结时间以六位微秒字符串保存，本模块负责在 SQL
 * 内恢复为 UTC timestamp，避免经过 JavaScript Date 后丢失微秒精度。
 */
import { type SQL, sql } from "drizzle-orm";

/**
 * 把带 UTC 偏移的精确时间字符串转换为 PostgreSQL 无时区时间表达式。
 *
 * @param value 由数据库生成并经 Zod 校验的 ISO 8601 UTC 时间。
 * @returns 可参与 timestamp tuple 比较的参数化 SQL。
 * @sideEffects 无。
 * @failure 非法时间由调用边界的 Zod 校验拒绝；数据库转换失败时查询显式失败。
 */
export function toOperationsDatabaseTimestamp(value: string): SQL {
  return sql`(${value}::timestamptz at time zone 'UTC')`;
}
