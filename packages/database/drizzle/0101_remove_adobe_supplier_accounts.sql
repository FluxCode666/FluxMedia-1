-- 供应商账号统一为 API：清理历史 Adobe 成员、配置和凭据健康表。
-- 仅允许在 Adobe 成员没有活跃任务或租约时执行，避免删除仍需恢复的执行身份。
DO $$
DECLARE
  active_video_count bigint;
  active_lease_count bigint;
BEGIN
  SELECT count(*)
  INTO active_video_count
  FROM "video_generation" AS video
  INNER JOIN "image_backend_member" AS member
    ON member."id" = video."backend_member_id"
  WHERE member."type" = 'adobe'
    AND video."stage" NOT IN ('completed', 'failed');

  SELECT count(*)
  INTO active_lease_count
  FROM "image_backend_member_lease" AS lease
  INNER JOIN "image_backend_member" AS member
    ON member."id" = lease."member_id"
  WHERE member."type" = 'adobe'
    AND lease."expires_at" > now();

  IF active_video_count > 0 OR active_lease_count > 0 THEN
    RAISE EXCEPTION
      '0101 blocked: Adobe members still have % active videos and % active leases',
      active_video_count,
      active_lease_count;
  END IF;
END
$$;

DELETE FROM "image_backend_member"
WHERE "type" = 'adobe';

-- 调度指标保留历史事实，但不再保留已移除的供应商类型枚举值。
-- 归一化前先合并可能与 NULL 桶冲突的 Adobe 桶；唯一索引使用
-- NULLS NOT DISTINCT，直接 UPDATE 在这种历史数据上会失败。
UPDATE "image_backend_member_scheduler_metric" AS target
SET
  "event_count" = target."event_count" + legacy."event_count",
  "candidate_count_total" = target."candidate_count_total" + legacy."candidate_count_total",
  "latency_ms_total" = target."latency_ms_total" + legacy."latency_ms_total",
  "updated_at" = greatest(target."updated_at", legacy."updated_at")
FROM "image_backend_member_scheduler_metric" AS legacy
WHERE target."member_type" IS NULL
  AND legacy."member_type" = 'adobe'
  AND target."bucket_started_at" = legacy."bucket_started_at"
  AND target."request_kind" = legacy."request_kind"
  AND target."strategy" = legacy."strategy"
  AND target."outcome" = legacy."outcome"
  AND target."member_id" IS NOT DISTINCT FROM legacy."member_id"
  AND target."group_id" IS NOT DISTINCT FROM legacy."group_id";

DELETE FROM "image_backend_member_scheduler_metric" AS legacy
USING "image_backend_member_scheduler_metric" AS target
WHERE legacy."member_type" = 'adobe'
  AND target."member_type" IS NULL
  AND target."bucket_started_at" = legacy."bucket_started_at"
  AND target."request_kind" = legacy."request_kind"
  AND target."strategy" = legacy."strategy"
  AND target."outcome" = legacy."outcome"
  AND target."member_id" IS NOT DISTINCT FROM legacy."member_id"
  AND target."group_id" IS NOT DISTINCT FROM legacy."group_id";

UPDATE "image_backend_member_scheduler_metric"
SET "member_type" = NULL
WHERE "member_type" = 'adobe';

ALTER TABLE "image_backend_member"
  DROP CONSTRAINT IF EXISTS "image_backend_member_type_check";

ALTER TABLE "image_backend_member"
  ADD CONSTRAINT "image_backend_member_type_check"
  CHECK ("type" = 'api');

ALTER TABLE "image_backend_member_scheduler_metric"
  DROP CONSTRAINT IF EXISTS "image_backend_member_scheduler_metric_member_type_check";

ALTER TABLE "image_backend_member_scheduler_metric"
  ADD CONSTRAINT "image_backend_member_scheduler_metric_member_type_check"
  CHECK ("member_type" IS NULL OR "member_type" = 'api');

ALTER TABLE "video_generation"
  DROP CONSTRAINT IF EXISTS "video_generation_adobe_profile_check",
  DROP COLUMN IF EXISTS "adobe_request_profile",
  DROP COLUMN IF EXISTS "adobe_auth_profile";

DROP TABLE IF EXISTS "adobe_credential_notification_delivery";
DROP TABLE IF EXISTS "adobe_credential_evaluation";
DROP TABLE IF EXISTS "adobe_credential_incident";
DROP TABLE IF EXISTS "adobe_credential_health";
DROP TABLE IF EXISTS "image_backend_member_adobe_config";
