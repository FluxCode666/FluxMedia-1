-- 修复迁移顺序漂移导致 Gemini 视频字段未落库的问题。
--
-- 某些数据库已经登记了更晚的并行迁移，导致 0095 被 Drizzle 按时间戳跳过；
-- 所有语句保持幂等，确保这些数据库最终具备当前代码所需的可空字段和约束。

ALTER TABLE "video_generation"
  ADD COLUMN IF NOT EXISTS "upstream_operation_name" text;

ALTER TABLE "video_generation"
  ADD COLUMN IF NOT EXISTS "public_operation_id" text;

CREATE UNIQUE INDEX IF NOT EXISTS
  "video_generation_public_operation_id_unique"
  ON "video_generation" ("public_operation_id");

ALTER TABLE "video_generation"
  DROP CONSTRAINT IF EXISTS "video_generation_gemini_operation_identity_check";

ALTER TABLE "video_generation"
  ADD CONSTRAINT "video_generation_gemini_operation_identity_check"
  CHECK (
    "public_operation_id" IS NULL
    OR "public_operation_id" ~ '^[A-Za-z0-9_-]{16,128}$'
  );
