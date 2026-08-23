-- Gemini 兼容视频 Operation 的持久身份。
--
-- 只新增可空字段，历史任务保持原有 taskId/上游 job 语义；公开 opaque ID 由平台生成，
-- 真实 upstream operation.name 仅供固定成员恢复使用，两个值都不进入客户端响应。

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
