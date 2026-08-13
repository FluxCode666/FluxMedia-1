/**
 * 数据列表的共享分页信封契约。
 *
 * 使用方：UOL operation、领域服务与页面绑定。普通列表使用 offset 信封；高量历史
 * 使用带稳定浏览上界和双向 cursor 的 keyset 信封，避免各业务域重复定义分页元数据。
 */

import { z } from "zod";

const positiveSafeIntegerSchema = z.number().int().positive().safe();
const nonnegativeSafeIntegerSchema = z.number().int().nonnegative().safe();
const cursorSchema = z.string().min(1).max(4096).nullable();
const isoDateTimeSchema = z.string().datetime({ offset: true });

/**
 * 创建可复用的 offset 分页输出 schema。
 *
 * @param recordSchema - 单条业务记录的 Zod schema。
 * @returns 严格的 records/page/pageSize/totalCount/totalPages 信封。
 */
export function createOffsetPaginationOutputSchema<
  RecordSchema extends z.ZodType,
>(recordSchema: RecordSchema) {
  return z
    .object({
      records: z.array(recordSchema),
      page: positiveSafeIntegerSchema,
      pageSize: positiveSafeIntegerSchema,
      totalCount: nonnegativeSafeIntegerSchema,
      totalPages: positiveSafeIntegerSchema,
    })
    .strict();
}

/**
 * 创建可复用的双向 keyset 分页输出 schema。
 *
 * @param recordSchema - 单条业务记录的 Zod schema。
 * @returns 带当前页、精确总数、浏览上界及前后 cursor 的严格信封。
 */
export function createKeysetPaginationOutputSchema<
  RecordSchema extends z.ZodType,
>(recordSchema: RecordSchema) {
  return z
    .object({
      records: z.array(recordSchema),
      page: positiveSafeIntegerSchema,
      pageSize: positiveSafeIntegerSchema,
      totalCount: nonnegativeSafeIntegerSchema,
      asOf: isoDateTimeSchema,
      previousCursor: cursorSchema,
      nextCursor: cursorSchema,
    })
    .strict();
}

export type OffsetPaginationOutput<Record> = {
  records: Record[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
};

export type KeysetPaginationOutput<Record> = {
  records: Record[];
  page: number;
  pageSize: number;
  totalCount: number;
  asOf: string;
  previousCursor: string | null;
  nextCursor: string | null;
};
