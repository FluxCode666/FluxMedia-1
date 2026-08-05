-- 分组任务队列优先级契约。
--
-- 职责：把 priority 的 0..10000 范围和默认组查询索引下沉到数据库，防止绕过
-- UOL/管理页面的直接写入制造无法调度的分组值。priority 不参与管理列表排序。

ALTER TABLE "image_backend_group"
  DROP CONSTRAINT IF EXISTS "image_backend_group_priority_check";
--> statement-breakpoint
ALTER TABLE "image_backend_group"
  ADD CONSTRAINT "image_backend_group_priority_check"
  CHECK ("priority" BETWEEN 0 AND 10000);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "image_backend_group_default_lookup_idx"
  ON "image_backend_group" ("is_enabled", "is_default", "created_at", "id");
