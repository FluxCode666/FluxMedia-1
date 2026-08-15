-- 运营明细与完整 CSV 使用无损微秒时间及稳定事实键进行降序 keyset 分页。
--
-- WHY：对业务时间做毫秒截断会阻止 PostgreSQL 复用原始时间索引；以下索引与
-- fulfilled order、支付生命周期和成功产物的 ORDER BY/tuple seek 完全一致。
-- 生产大表须先按运行手册在迁移事务外使用 CREATE INDEX CONCURRENTLY 预建同名
-- 索引；迁移中的普通 CREATE INDEX 随后成为 no-op。

CREATE INDEX IF NOT EXISTS "payment_order_operations_fulfilled_cursor_idx"
  ON "payment_order" ("fulfilled_at" DESC, "id" DESC)
  WHERE "status" = 'fulfilled'
    AND "purpose" IN ('credit_top_up', 'credit_package')
    AND "fulfilled_at" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "payment_lifecycle_event_occurred_id_idx"
  ON "payment_lifecycle_event" ("occurred_at" DESC, "id" DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "user_output_usage_event_operation_cursor_idx"
  ON "user_output_usage_event" (
    "operation_created_at" DESC,
    "output_kind" DESC,
    "source_task_id" DESC
  );
