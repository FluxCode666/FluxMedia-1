-- 图片异步 Redis MQ 持久任务。
--
-- Redis 只保存 task ID 并允许丢失后由 PostgreSQL 补投；完整 UOL 输入、Principal
-- 最小快照、claim 与终态均在本表，generation 和 credits_transaction 继续作为产物
-- 与财务真相。迁移幂等，便于发布维护窗口重复执行。

CREATE TABLE IF NOT EXISTS "image_async_task" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "api_key_id" text NOT NULL,
  "plan" text NOT NULL,
  "operation" text NOT NULL,
  "generation_inputs" json NOT NULL,
  "generation_ids" json NOT NULL,
  "response_format" text NOT NULL,
  "callback_url" text,
  "status" text NOT NULL DEFAULT 'queued',
  "attempt_count" integer NOT NULL DEFAULT 0,
  "claim_token" text,
  "claim_expires_at" timestamp,
  "error" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "started_at" timestamp,
  "completed_at" timestamp,
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "image_async_task_operation_check"
    CHECK ("operation" IN ('generate', 'edit', 'mask')),
  CONSTRAINT "image_async_task_response_format_check"
    CHECK ("response_format" IN ('url', 'b64_json')),
  CONSTRAINT "image_async_task_status_check"
    CHECK ("status" IN ('queued', 'running', 'completed', 'failed')),
  CONSTRAINT "image_async_task_attempt_count_check"
    CHECK ("attempt_count" >= 0),
  CONSTRAINT "image_async_task_identity_nonempty_check"
    CHECK (
      length(btrim("user_id")) > 0
      AND length(btrim("api_key_id")) > 0
      AND length(btrim("plan")) > 0
    )
);

CREATE INDEX IF NOT EXISTS "image_async_task_owner_created_idx"
  ON "image_async_task" ("user_id", "api_key_id", "created_at");

CREATE INDEX IF NOT EXISTS "image_async_task_recovery_idx"
  ON "image_async_task" ("status", "claim_expires_at", "created_at");
