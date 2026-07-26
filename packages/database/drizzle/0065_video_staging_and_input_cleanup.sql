-- 对象存储与视频任务准入无法共享事务。staging reservation 在上传前硬限制并发，
-- 持久清理队列保证竞争失败、终态清理失败或进程中断后最终删除临时视频输入。
ALTER TABLE "video_generation"
  ADD COLUMN IF NOT EXISTS "staged_input_objects" json;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "video_task_staging_reservation" (
  "task_id" text PRIMARY KEY NOT NULL,
  "reservation_token" text NOT NULL,
  "user_id" text NOT NULL,
  "principal_scope" text NOT NULL,
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "video_staging_reservation_identity_nonempty_check"
    CHECK (
      length(btrim("reservation_token")) > 0
      AND length(btrim("user_id")) > 0
      AND length(btrim("principal_scope")) > 0
    )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "video_staging_reservation_token_unique"
  ON "video_task_staging_reservation" ("reservation_token");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "video_staging_reservation_user_expiry_idx"
  ON "video_task_staging_reservation" ("user_id", "expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "video_staging_reservation_principal_expiry_idx"
  ON "video_task_staging_reservation" ("principal_scope", "expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "video_staging_reservation_expiry_idx"
  ON "video_task_staging_reservation" ("expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "video_input_cleanup" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "video_id" text NOT NULL,
  "attempt_id" text NOT NULL,
  "storage_key" text NOT NULL,
  "storage_bucket" text NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp DEFAULT now() NOT NULL,
  "claim_token" text,
  "claim_expires_at" timestamp,
  "last_error" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "video_input_cleanup_attempt_count_check"
    CHECK ("attempt_count" >= 0),
  CONSTRAINT "video_input_cleanup_identity_nonempty_check"
    CHECK (
      length(btrim("user_id")) > 0
      AND length(btrim("video_id")) > 0
      AND length(btrim("attempt_id")) > 0
      AND length(btrim("storage_key")) > 0
      AND length(btrim("storage_bucket")) > 0
    )
);
--> statement-breakpoint
ALTER TABLE "video_input_cleanup"
  ADD COLUMN IF NOT EXISTS "user_id" text;
--> statement-breakpoint
ALTER TABLE "video_input_cleanup"
  ADD COLUMN IF NOT EXISTS "video_id" text;
--> statement-breakpoint
ALTER TABLE "video_input_cleanup"
  ADD COLUMN IF NOT EXISTS "attempt_id" text;
--> statement-breakpoint
ALTER TABLE "video_input_cleanup"
  ALTER COLUMN "user_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "video_input_cleanup"
  ALTER COLUMN "video_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "video_input_cleanup"
  ALTER COLUMN "attempt_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "video_input_cleanup"
  DROP CONSTRAINT IF EXISTS "video_input_cleanup_identity_nonempty_check";
--> statement-breakpoint
ALTER TABLE "video_input_cleanup"
  ADD CONSTRAINT "video_input_cleanup_identity_nonempty_check"
  CHECK (
    length(btrim("user_id")) > 0
    AND length(btrim("video_id")) > 0
    AND length(btrim("attempt_id")) > 0
    AND length(btrim("storage_key")) > 0
    AND length(btrim("storage_bucket")) > 0
  );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "video_input_cleanup_recovery_idx"
  ON "video_input_cleanup" ("next_attempt_at", "claim_expires_at");
