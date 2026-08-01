-- 修复视频输入清理队列与运行时 schema 的漂移。reason 在 0065 建表后才加入
-- Drizzle schema；既有记录均来自旧 orphan 清理流程，因此可确定性回填为 orphan。
ALTER TABLE "video_input_cleanup"
  ADD COLUMN IF NOT EXISTS "reason" text;
--> statement-breakpoint
UPDATE "video_input_cleanup"
SET "reason" = 'orphan'
WHERE "reason" IS NULL;
--> statement-breakpoint
ALTER TABLE "video_input_cleanup"
  ALTER COLUMN "reason" SET DEFAULT 'orphan';
--> statement-breakpoint
ALTER TABLE "video_input_cleanup"
  ALTER COLUMN "reason" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "video_input_cleanup"
  DROP CONSTRAINT IF EXISTS "video_input_cleanup_reason_check";
--> statement-breakpoint
ALTER TABLE "video_input_cleanup"
  ADD CONSTRAINT "video_input_cleanup_reason_check"
  CHECK ("reason" IN ('orphan', 'lifecycle_delete'));
