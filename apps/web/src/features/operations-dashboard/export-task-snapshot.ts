/**
 * 运营 CSV 导出冻结快照读取。
 *
 * 使用方：导出任务创建事务与 PostgreSQL 集成测试。调用方必须传入当前事务的
 * execute，使数据库时钟、统计起点和全部 append 事实高水位处于同一事务视图。
 */
import { sql } from "drizzle-orm";
import { z } from "zod";

import { extractExecuteRows } from "@/server/database-result";
import type { OperationsExportSnapshot } from "./export-task-contracts";
import { operationsExportHighWatermarksSchema } from "./export-task-parsers";

/**
 * 构造一次性读取数据库时钟、epoch 与全部事实高水位的 SQL。
 *
 * @returns 可由创建事务和 PostgreSQL EXPLAIN 测试复用的只读查询。
 * @sideEffects 无；实际一致性由调用方事务隔离级别保证。
 */
export function buildOperationsExportSnapshotSql(): ReturnType<typeof sql> {
  return sql`
    select
      transaction_timestamp() as snapshot_at,
      (select app_date from operations_analytics_epoch where id = 1) as epoch_app_date,
      (select starts_at from operations_analytics_epoch where id = 1) as epoch_starts_at,
      json_build_object(
        'users', (select json_build_object('createdAt', to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'id', id) from "user" order by created_at desc, id desc limit 1),
        'webVisits', (select json_build_object('createdAt', to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'userId', user_id, 'appDate', app_date) from user_web_visit order by created_at desc, user_id desc, app_date desc limit 1),
        'outputs', (select json_build_object('createdAt', to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'outputKind', output_kind, 'sourceTaskId', source_task_id) from user_output_usage_event order by created_at desc, output_kind desc, source_task_id desc limit 1),
        'paymentOrders', (select json_build_object('createdAt', to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'id', id) from payment_order order by created_at desc, id desc limit 1),
        'paymentLifecycle', (select json_build_object('recordedAt', to_char(recorded_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'id', id) from payment_lifecycle_event order by recorded_at desc, id desc limit 1),
        'creditContributions', (select json_build_object('projectedAt', to_char(projected_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'transactionId', transaction_id) from credit_usage_projection_entry order by projected_at desc, transaction_id desc limit 1)
      ) as high_watermarks
  `;
}

/**
 * 在同一事务中捕获数据库时钟、epoch 与全部事实 append 高水位。
 *
 * @param execute 当前 repeatable-read 创建事务绑定的 SQL 执行器。
 * @returns 同一事务视图下的快照时间、可选统计起点和全部事实高水位。
 * @throws ZodError 当数据库返回结构非法时抛出；epoch 半缺失时抛稳定完整性错误。
 * @sideEffects 仅在调用方事务中执行一次只读 SQL，不自行创建或提交事务。
 */
export async function readOperationsExportSnapshot(
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>
): Promise<OperationsExportSnapshot> {
  const row = z
    .object({
      snapshot_at: z.coerce.date(),
      epoch_app_date: z.string().nullable(),
      epoch_starts_at: z.coerce.date().nullable(),
      high_watermarks: operationsExportHighWatermarksSchema,
    })
    .parse(
      extractExecuteRows(await execute(buildOperationsExportSnapshotSql()))[0]
    );
  if ((row.epoch_app_date === null) !== (row.epoch_starts_at === null)) {
    throw new Error("运营统计起点数据不完整");
  }
  return {
    snapshotAt: row.snapshot_at,
    epoch:
      row.epoch_app_date && row.epoch_starts_at
        ? { appDate: row.epoch_app_date, startsAt: row.epoch_starts_at }
        : null,
    highWatermarks: row.high_watermarks,
  };
}
