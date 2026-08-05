-- 图片异步任务 MQ 投递 fencing。
--
-- 职责：把 MQ 投递代次与 Worker 执行 attempt 分离，使补投确认能按版本和 due 做 CAS；
-- 迟到的 Queue.add 确认不得清除后续失败重新产生的唤醒游标。

ALTER TABLE "image_async_task"
  ADD COLUMN IF NOT EXISTS "mq_delivery_version" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "image_async_task"
  DROP CONSTRAINT IF EXISTS "image_async_task_attempt_count_check";
--> statement-breakpoint
ALTER TABLE "image_async_task"
  ADD CONSTRAINT "image_async_task_attempt_count_check"
  CHECK ("attempt_count" >= 0 AND "mq_delivery_version" >= 0);
