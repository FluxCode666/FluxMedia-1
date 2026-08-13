-- API 视频创建自动重试和逐次尝试账本。
--
-- 职责：新增 retrying 阶段、稳定终局失败事实、容量等待截止及不可变创建尝试表；
-- 同时为 0087 前适配版本补齐账号级默认额外重试次数 2。账本不保存 prompt、URL、
-- 凭据、上游 task ID 或原始响应正文。

ALTER TABLE "video_generation"
  ADD COLUMN IF NOT EXISTS "failure_code" text;

ALTER TABLE "video_generation"
  ADD COLUMN IF NOT EXISTS "capacity_wait_deadline_at" timestamp;

ALTER TABLE "video_generation"
  DROP CONSTRAINT IF EXISTS "video_generation_stage_check";

ALTER TABLE "video_generation"
  ADD CONSTRAINT "video_generation_stage_check"
  CHECK (
    "stage" IN (
      'created',
      'charged',
      'submitting',
      'submit_uncertain',
      'retrying',
      'polling',
      'downloading',
      'refunding',
      'completed',
      'failed'
    )
  );

-- 历史不可变适配版本按本次产品默认补齐；已显式保存的值保持不变。
UPDATE "image_backend_member_api_adapter_version"
SET "configuration" = (
  "configuration"::jsonb ||
  jsonb_build_object('videoSubmissionRetryCount', 2)
)::json
WHERE NOT ("configuration"::jsonb ? 'videoSubmissionRetryCount');

ALTER TABLE "image_backend_member_api_adapter_version"
  DROP CONSTRAINT IF EXISTS
    "image_backend_member_api_adapter_version_configuration_check";

ALTER TABLE "image_backend_member_api_adapter_version"
  ADD CONSTRAINT
    "image_backend_member_api_adapter_version_configuration_check"
  CHECK (
    json_typeof("configuration") = 'object'
    AND NOT ("configuration"::jsonb ? 'apiKey')
    AND jsonb_typeof(
      "configuration"::jsonb->'videoSubmissionRetryCount'
    ) = 'number'
    AND ("configuration"->>'videoSubmissionRetryCount')::numeric >= 0
    AND ("configuration"->>'videoSubmissionRetryCount')::numeric <= 10
    AND trunc(
      ("configuration"->>'videoSubmissionRetryCount')::numeric
    ) = ("configuration"->>'videoSubmissionRetryCount')::numeric
  );

CREATE TABLE IF NOT EXISTS "video_generation_submission_attempt" (
  "id" text PRIMARY KEY,
  "video_generation_id" text NOT NULL
    REFERENCES "video_generation"("id") ON DELETE CASCADE,
  "backend_member_id" text NOT NULL,
  "member_attempt_number" integer NOT NULL,
  "global_attempt_number" integer NOT NULL,
  "request_id" text NOT NULL,
  "retry_count_snapshot" integer NOT NULL,
  "max_attempts_snapshot" integer NOT NULL,
  "supplier_name_snapshot" text NOT NULL,
  "api_adapter_member_id" text NOT NULL,
  "api_adapter_version_id" text NOT NULL,
  "failure_code" text,
  "failure_reason" text,
  "operations_reason" text,
  "failed_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "video_generation_submission_attempt_member_number_unique"
    UNIQUE (
      "video_generation_id",
      "backend_member_id",
      "member_attempt_number"
    ),
  CONSTRAINT "video_generation_submission_attempt_global_number_unique"
    UNIQUE ("video_generation_id", "global_attempt_number"),
  CONSTRAINT "video_generation_submission_attempt_counts_check"
    CHECK (
      "member_attempt_number" >= 1
      AND "global_attempt_number" >= 1
      AND "retry_count_snapshot" BETWEEN 0 AND 10
      AND "max_attempts_snapshot" = "retry_count_snapshot" + 1
      AND "member_attempt_number" <= "max_attempts_snapshot"
    ),
  CONSTRAINT "video_generation_submission_attempt_supplier_check"
    CHECK (
      char_length(btrim("supplier_name_snapshot")) BETWEEN 1 AND 120
    ),
  CONSTRAINT "video_generation_submission_attempt_failure_pair_check"
    CHECK (
      (
        "failure_code" IS NULL
        AND "failure_reason" IS NULL
        AND "operations_reason" IS NULL
        AND "failed_at" IS NULL
      ) OR (
        "failure_code" IS NOT NULL
        AND "failure_reason" IS NOT NULL
        AND "operations_reason" IS NOT NULL
        AND "failed_at" IS NOT NULL
        AND char_length("failure_code") BETWEEN 1 AND 64
        AND char_length("failure_reason") BETWEEN 1 AND 1000
        AND char_length("operations_reason") BETWEEN 1 AND 1000
      )
    ),
  CONSTRAINT "video_generation_submission_attempt_failure_code_check"
    CHECK (
      "failure_code" IS NULL OR "failure_code" IN (
        'submission_timeout',
        'network_error',
        'response_read_failed',
        'response_parse_failed',
        'missing_upstream_task_id',
        'rate_limited',
        'upstream_unavailable',
        'authentication_failed',
        'permission_denied',
        'invalid_request',
        'moderation_rejected',
        'submission_conflict',
        'capacity_wait_timeout',
        'no_eligible_api_account',
        'unknown_submission_failure'
      )
    )
  )
);

CREATE INDEX IF NOT EXISTS
  "video_generation_submission_attempt_task_created_idx"
  ON "video_generation_submission_attempt" (
    "video_generation_id",
    "created_at"
  );
