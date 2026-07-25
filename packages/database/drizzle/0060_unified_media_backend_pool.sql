-- 统一媒体后端数据模型的一次性破坏性切换。
-- 发布方必须先停止旧 Web/worker、排空数据库连接并创建受控备份。Drizzle 在单个
-- PostgreSQL 事务中执行本文件；任一预检、约束或 DDL 失败都会回滚全部变更。
DO $$
DECLARE
  old_account_count bigint;
  old_account_group_count bigint;
  old_api_count bigint;
  old_api_group_count bigint;
  old_adobe_count bigint;
  old_adobe_group_count bigint;
  adobe_account_count bigint;
  adobe_token_count bigint;
  old_inflight_lease_count bigint;
  old_sticky_binding_count bigint;
  old_scheduler_metric_count bigint;
  video_adobe_reference_count bigint;
BEGIN
  SELECT count(*) INTO old_account_count FROM "image_backend_account";
  SELECT count(*) INTO old_account_group_count FROM "image_backend_account_group";
  SELECT count(*) INTO old_api_count FROM "image_backend_api";
  SELECT count(*) INTO old_api_group_count FROM "image_backend_api_group";
  SELECT count(*) INTO old_adobe_count FROM "image_backend_adobe";
  SELECT count(*) INTO old_adobe_group_count FROM "image_backend_adobe_group";
  SELECT count(*) INTO adobe_account_count FROM "adobe_account";
  SELECT count(*) INTO adobe_token_count FROM "adobe_token";
  SELECT count(*) INTO old_inflight_lease_count FROM "image_backend_inflight_lease";
  SELECT count(*) INTO old_sticky_binding_count FROM "image_backend_sticky_binding";
  SELECT count(*) INTO old_scheduler_metric_count FROM "image_backend_scheduler_metric";
  SELECT count(*)
  INTO video_adobe_reference_count
  FROM "video_generation"
  WHERE "adobe_id" IS NOT NULL;

  IF old_account_count <> 0
    OR old_account_group_count <> 0
    OR old_api_count <> 0
    OR old_api_group_count <> 0
    OR old_adobe_count <> 0
    OR old_adobe_group_count <> 0
    OR adobe_account_count <> 0
    OR adobe_token_count <> 0
    OR old_inflight_lease_count <> 0
    OR old_sticky_binding_count <> 0
    OR old_scheduler_metric_count <> 0
    OR video_adobe_reference_count <> 0
  THEN
    RAISE EXCEPTION
      '0060 blocked: legacy media data remains (account=%, account_group=%, api=%, api_group=%, adobe=%, adobe_group=%, adobe_account=%, adobe_token=%, inflight_lease=%, sticky=%, scheduler_metric=%, video_adobe_ref=%)',
      old_account_count,
      old_account_group_count,
      old_api_count,
      old_api_group_count,
      old_adobe_count,
      old_adobe_group_count,
      adobe_account_count,
      adobe_token_count,
      old_inflight_lease_count,
      old_sticky_binding_count,
      old_scheduler_metric_count,
      video_adobe_reference_count;
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE "image_backend_member" (
  "id" text PRIMARY KEY NOT NULL,
  "type" text NOT NULL,
  "name" text NOT NULL,
  "supported_model_ids" json NOT NULL,
  "content_safety_enabled" boolean DEFAULT true NOT NULL,
  "is_enabled" boolean DEFAULT true NOT NULL,
  "always_active" boolean DEFAULT false NOT NULL,
  "failure_cooldown_enabled" boolean DEFAULT false NOT NULL,
  "priority" integer DEFAULT 50 NOT NULL,
  "concurrency" integer DEFAULT 10 NOT NULL,
  "lease_acquired_count" integer DEFAULT 0 NOT NULL,
  "success_count" integer DEFAULT 0 NOT NULL,
  "fail_count" integer DEFAULT 0 NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "health_status" text DEFAULT 'healthy' NOT NULL,
  "error_ewma" numeric(8, 7) DEFAULT 0 NOT NULL,
  "duration_ms_ewma" numeric(18, 2),
  "success_streak" integer DEFAULT 0 NOT NULL,
  "fail_streak" integer DEFAULT 0 NOT NULL,
  "last_observed_at" timestamp,
  "last_used_at" timestamp,
  "last_acquired_at" timestamp,
  "cooldown_until" timestamp,
  "last_error" text,
  "last_error_at" timestamp,
  "metadata" json,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "image_backend_member_type_check"
    CHECK ("type" IN ('api', 'adobe')),
  CONSTRAINT "image_backend_member_supported_models_check"
    CHECK (
      CASE
        WHEN json_typeof("supported_model_ids") = 'array'
          THEN json_array_length("supported_model_ids") > 0
        ELSE false
      END
    ),
  CONSTRAINT "image_backend_member_priority_check"
    CHECK ("priority" >= 0 AND "priority" <= 10000),
  CONSTRAINT "image_backend_member_concurrency_check"
    CHECK ("concurrency" >= 1 AND "concurrency" <= 10000),
  CONSTRAINT "image_backend_member_counts_check"
    CHECK (
      "lease_acquired_count" >= 0
      AND "success_count" >= 0
      AND "fail_count" >= 0
      AND "success_streak" >= 0
      AND "fail_streak" >= 0
    ),
  CONSTRAINT "image_backend_member_status_check"
    CHECK ("status" IN ('active', 'limited', 'error')),
  CONSTRAINT "image_backend_member_health_check"
    CHECK (
      "health_status" IN ('healthy', 'degraded', 'unhealthy')
      AND "error_ewma" >= 0
      AND "error_ewma" <= 1
      AND ("duration_ms_ewma" IS NULL OR "duration_ms_ewma" >= 0)
    )
);
--> statement-breakpoint
CREATE INDEX "image_backend_member_eligibility_idx"
  ON "image_backend_member" ("is_enabled", "status", "priority", "id");
--> statement-breakpoint
CREATE INDEX "image_backend_member_cooldown_idx"
  ON "image_backend_member" ("cooldown_until");
--> statement-breakpoint
CREATE TABLE "image_backend_member_api_config" (
  "member_id" text PRIMARY KEY NOT NULL,
  "base_url" text NOT NULL,
  "api_key" text,
  "parameter_mappings" json DEFAULT '[]'::json NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "image_backend_member_api_config_mappings_check"
    CHECK (json_typeof("parameter_mappings") = 'array'),
  CONSTRAINT "image_backend_member_api_config_member_id_image_backend_member_id_fk"
    FOREIGN KEY ("member_id") REFERENCES "image_backend_member"("id")
    ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "image_backend_member_adobe_config" (
  "member_id" text PRIMARY KEY NOT NULL,
  "mode" text NOT NULL,
  "base_url" text,
  "api_key" text,
  "default_ratio" text DEFAULT '1x1' NOT NULL,
  "default_resolution" text DEFAULT '2k' NOT NULL,
  "gpt_image_quality" text DEFAULT 'high' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "image_backend_member_adobe_config_mode_check"
    CHECK ("mode" IN ('gateway', 'direct')),
  CONSTRAINT "image_backend_member_adobe_config_shape_check"
    CHECK (
      ("mode" = 'gateway' AND "base_url" IS NOT NULL)
      OR (
        "mode" = 'direct'
        AND "base_url" IS NULL
        AND "api_key" IS NULL
      )
    ),
  CONSTRAINT "image_backend_member_adobe_config_quality_check"
    CHECK ("gpt_image_quality" IN ('low', 'medium', 'high')),
  CONSTRAINT "image_backend_member_adobe_config_member_id_image_backend_member_id_fk"
    FOREIGN KEY ("member_id") REFERENCES "image_backend_member"("id")
    ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "image_backend_member_group" (
  "id" text PRIMARY KEY NOT NULL,
  "member_id" text NOT NULL,
  "group_id" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "image_backend_member_group_member_id_image_backend_member_id_fk"
    FOREIGN KEY ("member_id") REFERENCES "image_backend_member"("id")
    ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "image_backend_member_group_group_id_image_backend_group_id_fk"
    FOREIGN KEY ("group_id") REFERENCES "image_backend_group"("id")
    ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "image_backend_member_group_member_group_unique"
  ON "image_backend_member_group" ("member_id", "group_id");
--> statement-breakpoint
CREATE INDEX "image_backend_member_group_group_idx"
  ON "image_backend_member_group" ("group_id", "member_id");
--> statement-breakpoint
CREATE TABLE "image_backend_member_lease" (
  "id" text PRIMARY KEY NOT NULL,
  "member_id" text NOT NULL,
  "owner_token" text NOT NULL,
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "image_backend_member_lease_member_id_image_backend_member_id_fk"
    FOREIGN KEY ("member_id") REFERENCES "image_backend_member"("id")
    ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "image_backend_member_lease_member_expires_idx"
  ON "image_backend_member_lease" ("member_id", "expires_at");
--> statement-breakpoint
CREATE INDEX "image_backend_member_lease_expires_idx"
  ON "image_backend_member_lease" ("expires_at");
--> statement-breakpoint
CREATE TABLE "image_backend_member_scheduler_metric" (
  "id" text PRIMARY KEY NOT NULL,
  "bucket_started_at" timestamp NOT NULL,
  "request_kind" text NOT NULL,
  "strategy" text NOT NULL,
  "outcome" text NOT NULL,
  "member_type" text,
  "member_id" text,
  "group_id" text,
  "event_count" integer DEFAULT 0 NOT NULL,
  "candidate_count_total" integer DEFAULT 0 NOT NULL,
  "latency_ms_total" integer DEFAULT 0 NOT NULL,
  "metadata" json,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "image_backend_member_scheduler_metric_request_kind_check"
    CHECK ("request_kind" IN ('image', 'video')),
  CONSTRAINT "image_backend_member_scheduler_metric_strategy_check"
    CHECK ("strategy" IN ('priority', 'least_acquired', 'least_load')),
  CONSTRAINT "image_backend_member_scheduler_metric_outcome_check"
    CHECK (
      "outcome" IN (
        'acquired',
        'capacity_rejected',
        'switched',
        'terminal_failure',
        'no_candidate'
      )
    ),
  CONSTRAINT "image_backend_member_scheduler_metric_member_type_check"
    CHECK ("member_type" IS NULL OR "member_type" IN ('api', 'adobe')),
  CONSTRAINT "image_backend_member_scheduler_metric_counts_check"
    CHECK (
      "event_count" >= 0
      AND "candidate_count_total" >= 0
      AND "latency_ms_total" >= 0
    ),
  CONSTRAINT "image_backend_member_scheduler_metric_bucket_unique"
    UNIQUE NULLS NOT DISTINCT (
      "bucket_started_at",
      "request_kind",
      "strategy",
      "outcome",
      "member_type",
      "member_id",
      "group_id"
    )
);
--> statement-breakpoint
CREATE INDEX "image_backend_member_scheduler_metric_bucket_idx"
  ON "image_backend_member_scheduler_metric" (
    "bucket_started_at",
    "strategy",
    "outcome"
  );
--> statement-breakpoint
ALTER TABLE "adobe_account"
  DROP CONSTRAINT IF EXISTS "adobe_account_backend_owner_check",
  ADD COLUMN "member_id" text;
--> statement-breakpoint
ALTER TABLE "adobe_account"
  ALTER COLUMN "member_id" SET NOT NULL,
  ADD CONSTRAINT "adobe_account_member_id_image_backend_member_id_fk"
    FOREIGN KEY ("member_id") REFERENCES "image_backend_member"("id")
    ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "adobe_token"
  DROP CONSTRAINT IF EXISTS "adobe_token_backend_owner_check",
  ADD COLUMN "member_id" text;
--> statement-breakpoint
ALTER TABLE "adobe_token"
  ALTER COLUMN "member_id" SET NOT NULL,
  ADD CONSTRAINT "adobe_token_member_id_image_backend_member_id_fk"
    FOREIGN KEY ("member_id") REFERENCES "image_backend_member"("id")
    ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
DROP INDEX "adobe_account_adobe_idx";
--> statement-breakpoint
DROP INDEX "adobe_token_adobe_idx";
--> statement-breakpoint
DROP INDEX "adobe_token_adobe_status_idx";
--> statement-breakpoint
ALTER TABLE "adobe_account"
  DROP CONSTRAINT "adobe_account_adobe_id_image_backend_adobe_id_fk",
  DROP COLUMN "adobe_id";
--> statement-breakpoint
ALTER TABLE "adobe_token"
  DROP CONSTRAINT "adobe_token_adobe_id_image_backend_adobe_id_fk",
  DROP COLUMN "adobe_id";
--> statement-breakpoint
CREATE INDEX "adobe_account_member_idx" ON "adobe_account" ("member_id");
--> statement-breakpoint
CREATE INDEX "adobe_token_member_idx" ON "adobe_token" ("member_id");
--> statement-breakpoint
CREATE INDEX "adobe_token_member_status_idx"
  ON "adobe_token" ("member_id", "status");
--> statement-breakpoint
ALTER TABLE "video_generation"
  ADD COLUMN "backend_member_id" text,
  ADD COLUMN "stage" text DEFAULT 'created' NOT NULL,
  ADD COLUMN "adobe_token_id" text,
  ADD COLUMN "member_lease_id" text,
  ADD COLUMN "member_lease_owner_token" text,
  ADD COLUMN "state_version" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "next_poll_at" timestamp,
  ADD COLUMN "claim_token" text,
  ADD COLUMN "claim_expires_at" timestamp,
  ADD COLUMN "submit_started_at" timestamp,
  ADD COLUMN "upstream_accepted_at" timestamp,
  ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE "video_generation"
SET "stage" = CASE "status"
  WHEN 'completed' THEN 'completed'
  WHEN 'failed' THEN 'failed'
  WHEN 'running' THEN 'polling'
  ELSE 'created'
END;
--> statement-breakpoint
ALTER TABLE "video_generation"
  ADD CONSTRAINT "video_generation_backend_member_id_image_backend_member_id_fk"
    FOREIGN KEY ("backend_member_id") REFERENCES "image_backend_member"("id")
    ON DELETE set null ON UPDATE no action,
  ADD CONSTRAINT "video_generation_adobe_token_id_adobe_token_id_fk"
    FOREIGN KEY ("adobe_token_id") REFERENCES "adobe_token"("id")
    ON DELETE set null ON UPDATE no action,
  ADD CONSTRAINT "video_generation_member_lease_id_image_backend_member_lease_id_fk"
    FOREIGN KEY ("member_lease_id") REFERENCES "image_backend_member_lease"("id")
    ON DELETE set null ON UPDATE no action,
  ADD CONSTRAINT "video_generation_stage_check"
    CHECK (
      "stage" IN (
        'created',
        'charged',
        'submitting',
        'submit_uncertain',
        'polling',
        'downloading',
        'refunding',
        'completed',
        'failed'
      )
    ),
  ADD CONSTRAINT "video_generation_recovery_counts_check"
    CHECK ("state_version" >= 0 AND "attempt_count" >= 0);
--> statement-breakpoint
ALTER TABLE "video_generation"
  DROP CONSTRAINT "video_generation_adobe_id_image_backend_adobe_id_fk",
  DROP COLUMN "adobe_id";
--> statement-breakpoint
CREATE INDEX "video_generation_backend_member_idx"
  ON "video_generation" ("backend_member_id");
--> statement-breakpoint
CREATE INDEX "video_generation_adobe_token_idx"
  ON "video_generation" ("adobe_token_id");
--> statement-breakpoint
CREATE INDEX "video_generation_member_lease_idx"
  ON "video_generation" ("member_lease_id");
--> statement-breakpoint
CREATE INDEX "video_generation_recovery_idx"
  ON "video_generation" ("stage", "next_poll_at", "claim_expires_at");
--> statement-breakpoint
DROP TABLE "image_backend_account_group";
--> statement-breakpoint
DROP TABLE "image_backend_api_group";
--> statement-breakpoint
DROP TABLE "image_backend_adobe_group";
--> statement-breakpoint
DROP TABLE "image_backend_account";
--> statement-breakpoint
DROP TABLE "image_backend_api";
--> statement-breakpoint
DROP TABLE "image_backend_adobe";
--> statement-breakpoint
DROP TABLE "image_backend_inflight_lease";
--> statement-breakpoint
DROP TABLE "image_backend_sticky_binding";
--> statement-breakpoint
DROP TABLE "image_backend_scheduler_metric";
--> statement-breakpoint
DELETE FROM "system_setting"
WHERE "key" IN (
  'IMAGE_MODERATION_PROMPT_REPAIR_ENABLED',
  'IMAGE_MODERATION_PROMPT_REPAIR_MAX_RETRIES',
  'PLATFORM_RESPONSES_MODEL',
  'PLATFORM_CHAT_MODEL',
  'IMAGE_AGENT_MAX_ROUNDS',
  'IMAGE_AGENT_FORCE_MAX_ROUNDS',
  'IMAGE_RESPONSES_PREVIOUS_RESPONSE_ENABLED',
  'IMAGE_FORCE_WEB_MIN_PIXELS',
  'IMAGE_FORCE_WEB_MAX_PIXELS',
  'CHATGPT_WEB_PROXY_URL',
  'CHATGPT_WEB_PROXY_SECRET',
  'CHATGPT_WEB_ACCOUNT_REFRESH_STALE_MINUTES',
  'CHATGPT_WEB_ACCOUNT_REFRESH_LIMIT',
  'SUB2API_POSTGRES_URL',
  'SUB2API_POSTGRES_SYNC_LIMIT',
  'SUB2API_AUTO_SYNC_TASKS',
  'EDITABLE_FILE_PPT_CREDITS',
  'EDITABLE_FILE_PSD_CREDITS',
  'INTERNAL_JOB_WEB_ACCOUNTS_REFRESH_INTERVAL_MINUTES',
  'INTERNAL_JOB_WEB_ACCOUNTS_REPLENISH_INTERVAL_MINUTES',
  'INTERNAL_JOB_SUB2API_SYNC_INTERVAL_MINUTES',
  'CHATGPT_REGISTER_MOEMAIL_API_KEY',
  'CHATGPT_REGISTER_MOEMAIL_BASE_URL',
  'CHATGPT_REGISTER_MOEMAIL_DOMAIN',
  'CHATGPT_REGISTER_DOMAINS',
  'CHATGPT_REGISTER_DOMAIN_ROTATION_ENABLED',
  'CHATGPT_REGISTER_PROXY',
  'CHATGPT_REGISTER_PROXY_DISABLED',
  'CHATGPT_REGISTER_REFRESH_URL',
  'CHATGPT_REGISTER_REFRESH_MIN_INTERVAL_SECONDS',
  'CHATGPT_REGISTER_REFRESH_MIN_ATTEMPTS',
  'CHATGPT_REGISTER_POOL_MAINTAIN_ENABLED',
  'CHATGPT_REGISTER_POOL_MAINTAIN_GROUP_ID',
  'CHATGPT_REGISTER_POOL_MAINTAIN_TARGET',
  'CHATGPT_REGISTER_POOL_MAINTAIN_MAX_PER_RUN',
  'CHATGPT_REGISTER_POOL_MAINTAIN_CONCURRENCY'
);
--> statement-breakpoint
UPDATE "system_setting"
SET
  "value" = (
    "value"::jsonb
      - 'billing'
      #- ARRAY['features', 'imageGeneration.chat']
      #- ARRAY['features', 'imageGeneration.agent']
      #- ARRAY['features', 'imageGeneration.waterfall']
      #- ARRAY['features', 'export.ppt']
      #- ARRAY['features', 'export.psd']
      #- ARRAY['features', 'models.gpt55']
      #- ARRAY['features', 'externalApi.chat.completions']
      #- ARRAY['features', 'externalApi.responses']
      #- ARRAY['features', 'externalApi.agent']
      #- ARRAY['limits', 'free', 'maxChatImages']
      #- ARRAY['limits', 'free', 'maxChatContextChars']
      #- ARRAY['limits', 'starter', 'maxChatImages']
      #- ARRAY['limits', 'starter', 'maxChatContextChars']
      #- ARRAY['limits', 'pro', 'maxChatImages']
      #- ARRAY['limits', 'pro', 'maxChatContextChars']
      #- ARRAY['limits', 'ultra', 'maxChatImages']
      #- ARRAY['limits', 'ultra', 'maxChatContextChars']
      #- ARRAY['limits', 'enterprise', 'maxChatImages']
      #- ARRAY['limits', 'enterprise', 'maxChatContextChars']
  )::json,
  "updated_at" = now()
WHERE "key" = 'PLAN_CAPABILITY_MATRIX'
  AND json_typeof("value") = 'object';
