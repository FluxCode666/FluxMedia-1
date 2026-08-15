/**
 * 运营明细 SQL 构造器共享的输入校验、时间边界与 keyset 辅助函数。
 *
 * 使用方：增长、商业化与内容生产明细 SQL 模块。关键依赖为统一数据库时间格式，
 * 从而让各领域查询共享无损微秒游标语义而不重复实现边界规则。
 */
import { type SQL, sql } from "drizzle-orm";

import { toOperationsDatabaseTimestamp } from "./database-timestamp";
import type {
  OperationsDetailCursor,
  OperationsDetailQuery,
} from "./detail-contracts";

/**
 * 对内部明细查询进行资源与边界防御。
 *
 * @param input 任意封闭的运营明细查询。
 * @returns 校验成功时无返回值，且不产生副作用。
 * @throws RangeError 日期、页大小、游标或 Cohort 参数不满足仓储契约时抛出。
 */
export function assertValidDetailQuery(input: OperationsDetailQuery): void {
  const validDates = [
    input.start,
    input.end,
    input.epochStart,
    input.asOf,
  ].every((value) => !Number.isNaN(value.getTime()));
  if (
    !validDates ||
    input.start >= input.end ||
    (input.kind !== "cumulative_users" && input.start < input.epochStart) ||
    input.end > input.asOf ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 10_001
  ) {
    throw new RangeError("运营增长明细查询无效");
  }
  if (
    input.cursor &&
    (Number.isNaN(input.cursor.businessTime.getTime()) ||
      Number.isNaN(new Date(input.cursor.businessTimeKey).getTime()) ||
      input.cursor.stableId.length === 0 ||
      input.cursor.stableId.length > 512)
  ) {
    throw new RangeError("运营增长明细游标无效");
  }
  if (
    input.kind === "cohort" &&
    (Number.isNaN(input.targetStart.getTime()) ||
      Number.isNaN(input.targetEnd.getTime()) ||
      input.targetStart >= input.targetEnd ||
      input.targetEnd > input.asOf)
  ) {
    throw new RangeError("Cohort 目标日范围无效");
  }
  if (
    input.kind === "cohort_export" &&
    (![1, 7, 30].includes(input.retentionDay) || !input.timeZone.trim())
  ) {
    throw new RangeError("Cohort 导出参数无效");
  }
}

/**
 * 构造原始业务时间和主键上的降序 keyset 谓词。
 *
 * @param cursor 当前页游标；首屏传入 null。
 * @param businessTime SQL 中的原始业务时间表达式。
 * @param stableId SQL 中用于稳定排序的唯一标识表达式。
 * @returns 可直接嵌入 Drizzle 查询的布尔 SQL，不产生副作用。
 */
export function buildDetailKeysetPredicate(
  cursor: OperationsDetailCursor | null,
  businessTime: SQL,
  stableId: SQL
): SQL {
  if (!cursor) return sql`true`;
  const cursorTime = toOperationsDatabaseTimestamp(cursor.businessTimeKey);
  return sql`(${businessTime}, ${stableId}) < (${cursorTime}, ${cursor.stableId})`;
}

/**
 * 将内容稳定 ID 解析为索引可直接使用的产物类型与任务 ID。
 *
 * @param stableId 形如 image:task-id 或 video:task-id 的稳定标识。
 * @returns 产物类型和任务 ID，不产生副作用。
 * @throws RangeError 标识格式非法或任务 ID 为空时抛出。
 */
function parseContentDetailStableId(stableId: string): {
  outputKind: "image" | "video";
  taskId: string;
} {
  const separatorIndex = stableId.indexOf(":");
  const outputKind = stableId.slice(0, separatorIndex);
  const taskId = stableId.slice(separatorIndex + 1);
  if (
    separatorIndex < 1 ||
    (outputKind !== "image" && outputKind !== "video") ||
    taskId.length === 0
  ) {
    throw new RangeError("运营内容明细游标无效");
  }
  return { outputKind, taskId };
}

/**
 * 构造成功产物原始三列索引上的降序 keyset 谓词。
 *
 * @param cursor 当前内容明细页游标；首屏传入 null。
 * @returns 与业务时间、产物类型、任务 ID tuple 索引一致的 SQL 谓词。
 * @throws RangeError 游标稳定 ID 不是合法内容标识时抛出。
 */
export function buildContentDetailKeysetPredicate(
  cursor: OperationsDetailCursor | null
): SQL {
  if (!cursor) return sql`true`;
  const cursorTime = toOperationsDatabaseTimestamp(cursor.businessTimeKey);
  const stableKey = parseContentDetailStableId(cursor.stableId);
  return sql`(
    scoped_outputs.business_time,
    scoped_outputs.sort_output_kind,
    scoped_outputs.task_id
  ) < (
    ${cursorTime},
    ${stableKey.outputKind}::output_usage_kind,
    ${stableKey.taskId}
  )`;
}

/**
 * 返回可包含 Date 所代表整毫秒的排除式上界。
 *
 * @param value 需要转换为排除式上界的时间。
 * @returns 增加一毫秒的新 Date，不修改输入对象且不产生副作用。
 */
export function nextMillisecond(value: Date): Date {
  return new Date(value.getTime() + 1);
}
