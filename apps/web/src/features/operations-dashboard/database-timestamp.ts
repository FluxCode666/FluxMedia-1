/**
 * 运营统计 PostgreSQL 精确时间参数工具。
 *
 * 使用方：导出高水位相关仓储。冻结时间以六位微秒字符串保存，本模块负责在 SQL
 * 内恢复为 UTC timestamp，避免经过 JavaScript Date 后丢失微秒精度。
 */
import { type SQL, sql } from "drizzle-orm";

const MILLISECOND_ISO_SUFFIX_PATTERN = /\.(\d{3})Z$/u;

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

/**
 * 把数据库 timestamp 表达式投影为固定六位微秒 UTC 文本。
 *
 * @param value PostgreSQL `timestamp without time zone` 表达式。
 * @returns 可无损写入签名 cursor 的 ISO 8601 文本表达式。
 * @sideEffects 无。
 */
export function toOperationsDatabaseTimestampText(value: SQL): SQL {
  return sql`to_char(${value}, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/**
 * 把 JavaScript Date 补齐为数据库游标使用的六位微秒文本。
 *
 * @param value 有效 Date；调用方已完成范围校验。
 * @returns 与该毫秒精确对应、后三位微秒为零的 UTC 文本。
 * @sideEffects 无。
 */
export function toOperationsCursorTimestamp(value: Date): string {
  return value.toISOString().replace(MILLISECOND_ISO_SUFFIX_PATTERN, ".$1000Z");
}
