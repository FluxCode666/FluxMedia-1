-- 视频 worker 与请求事务分离后，API Key 配额必须在任务上保留幂等事实；否则
-- charged 阶段崩溃重放会重复增加 credits_used，失败退款也无法判断是否已归还。
ALTER TABLE "video_generation"
  ADD COLUMN IF NOT EXISTS "api_key_credits_reserved" numeric(18, 2)
  DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "video_generation"
  DROP CONSTRAINT IF EXISTS "video_generation_recovery_counts_check";
--> statement-breakpoint
ALTER TABLE "video_generation"
  ADD CONSTRAINT "video_generation_recovery_counts_check"
  CHECK (
    "state_version" >= 0
    AND "attempt_count" >= 0
    AND "api_key_credits_reserved" >= 0
    AND ("api_key_id" IS NOT NULL OR "api_key_credits_reserved" = 0)
  );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "video_generation_principal_stage_idx"
  ON "video_generation" ("principal_scope", "stage");
