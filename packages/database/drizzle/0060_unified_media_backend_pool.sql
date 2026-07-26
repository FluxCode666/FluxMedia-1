-- 统一媒体后端数据模型的一次性切换。
-- 发布方必须先停止旧 Web/worker、排空数据库连接并创建受控备份。API、Adobe
-- 成员及其账号、token、分组和历史指标会在事务内迁移；只有已下线的 Web 账号、
-- 仍在运行的旧租约/粘性绑定和无法恢复的旧视频任务会阻断。任一失败都会回滚。
DO $$
DECLARE
  web_account_count bigint;
  web_account_group_count bigint;
  active_lease_count bigint;
  active_sticky_binding_count bigint;
  unrecoverable_video_count bigint;
  member_id_collision_count bigint;
  invalid_api_model_count bigint;
  incompatible_api_protocol_count bigint;
  invalid_adobe_config_count bigint;
  invalid_member_state_count bigint;
BEGIN
  SELECT count(*) INTO web_account_count FROM "image_backend_account";
  SELECT count(*)
  INTO web_account_group_count
  FROM "image_backend_account_group";
  SELECT count(*)
  INTO active_lease_count
  FROM "image_backend_inflight_lease"
  WHERE "expires_at" > now();
  SELECT count(*)
  INTO active_sticky_binding_count
  FROM "image_backend_sticky_binding"
  WHERE "expires_at" > now();
  SELECT count(*)
  INTO unrecoverable_video_count
  FROM "video_generation"
  WHERE "adobe_id" IS NOT NULL
    AND "status" NOT IN ('completed', 'failed');
  SELECT count(*)
  INTO member_id_collision_count
  FROM "image_backend_api" AS api
  INNER JOIN "image_backend_adobe" AS adobe ON adobe."id" = api."id";
  SELECT count(*)
  INTO invalid_api_model_count
  FROM "image_backend_api"
  WHERE CASE
    WHEN json_typeof("supported_model_ids") <> 'array' THEN true
    WHEN json_array_length("supported_model_ids") NOT BETWEEN 1 AND 200 THEN true
    ELSE EXISTS (
      SELECT 1
      FROM json_array_elements("supported_model_ids") AS model("value")
      WHERE json_typeof(model."value") <> 'string'
        OR char_length(btrim(model."value" #>> '{}')) NOT BETWEEN 1 AND 120
        OR lower(btrim(model."value" #>> '{}')) ~
          '^(firefly-sora2(-pro)?-(4|8|12)s-(9x16|16x9)|(firefly-)?veo31(-ref|-fast)?-(4|6|8)s-(16x9|9x16)-(1080p|720p)|(firefly-)?kling-o3-(5|15)s-(16x9|9x16)|(firefly-)?kling3-(5|10|15)s-(16x9|9x16))$'
    )
  END;
  SELECT count(*)
  INTO incompatible_api_protocol_count
  FROM "image_backend_api"
  WHERE "interface_mode" NOT IN ('images', 'mixed')
    OR "image_upstream_mode" <> 'images';
  SELECT count(*)
  INTO invalid_adobe_config_count
  FROM "image_backend_adobe"
  WHERE CASE
    WHEN "mode" NOT IN ('gateway', 'direct') THEN true
    WHEN "mode" = 'gateway' AND nullif(btrim("base_url"), '') IS NULL THEN true
    WHEN "enabled_models" IS NULL THEN false
    WHEN json_typeof("enabled_models") <> 'array' THEN true
    WHEN json_array_length("enabled_models") > 200 THEN true
    ELSE EXISTS (
      SELECT 1
      FROM json_array_elements("enabled_models") AS model("value")
      WHERE json_typeof(model."value") <> 'string'
        OR char_length(btrim(model."value" #>> '{}')) NOT BETWEEN 1 AND 120
        OR (
          "image_backend_adobe"."mode" = 'gateway'
          AND lower(btrim(model."value" #>> '{}')) ~
            '^(firefly-sora2(-pro)?-(4|8|12)s-(9x16|16x9)|(firefly-)?veo31(-ref|-fast)?-(4|6|8)s-(16x9|9x16)-(1080p|720p)|(firefly-)?kling-o3-(5|15)s-(16x9|9x16)|(firefly-)?kling3-(5|10|15)s-(16x9|9x16))$'
        )
    )
  END;
  SELECT sum(invalid_count)
  INTO invalid_member_state_count
  FROM (
    SELECT count(*) AS invalid_count
    FROM "image_backend_api"
    WHERE "status" NOT IN ('active', 'limited', 'error')
      OR "priority" < 0
      OR "priority" > 10000
      OR "concurrency" < 1
      OR "concurrency" > 10000
      OR "success_count" < 0
      OR "fail_count" < 0
      OR json_typeof("parameter_mappings") <> 'array'
    UNION ALL
    SELECT count(*) AS invalid_count
    FROM "image_backend_adobe"
    WHERE "status" NOT IN ('active', 'limited', 'error')
      OR "priority" < 0
      OR "priority" > 10000
      OR "concurrency" < 1
      OR "concurrency" > 10000
      OR "success_count" < 0
      OR "fail_count" < 0
      OR "gpt_image_quality" NOT IN ('low', 'medium', 'high')
  ) AS invalid_member_state;

  IF web_account_count <> 0
    OR web_account_group_count <> 0
    OR active_lease_count <> 0
    OR active_sticky_binding_count <> 0
    OR unrecoverable_video_count <> 0
    OR member_id_collision_count <> 0
    OR invalid_api_model_count <> 0
    OR incompatible_api_protocol_count <> 0
    OR invalid_adobe_config_count <> 0
    OR invalid_member_state_count <> 0
  THEN
    RAISE EXCEPTION
      '0060 blocked: non-migratable media state remains (web_account=%, web_account_group=%, active_lease=%, active_sticky=%, active_video=%, member_id_collision=%, invalid_api_models=%, incompatible_api_protocol=%, invalid_adobe_config=%, invalid_member_state=%)',
      web_account_count,
      web_account_group_count,
      active_lease_count,
      active_sticky_binding_count,
      unrecoverable_video_count,
      member_id_collision_count,
      invalid_api_model_count,
      incompatible_api_protocol_count,
      invalid_adobe_config_count,
      invalid_member_state_count;
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
  "use_stream" boolean DEFAULT false NOT NULL,
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
-- API 与 Adobe 使用原主键进入同一成员表，避免外部引用和审计记录失去身份连续性。
-- 旧调度器的 EWMA/连续成功失败值仍保留在 metadata.scheduler；新列从下一次调用开始
-- 重新采样，防止异常历史 JSON 通过强制类型转换中断整个迁移。
INSERT INTO "image_backend_member" (
  "id",
  "type",
  "name",
  "supported_model_ids",
  "content_safety_enabled",
  "is_enabled",
  "always_active",
  "failure_cooldown_enabled",
  "priority",
  "concurrency",
  "lease_acquired_count",
  "success_count",
  "fail_count",
  "status",
  "health_status",
  "last_observed_at",
  "last_used_at",
  "last_acquired_at",
  "cooldown_until",
  "last_error",
  "last_error_at",
  "metadata",
  "created_at",
  "updated_at"
)
SELECT
  "id",
  'api',
  "name",
  (
    SELECT jsonb_agg(
      CASE model."id"
        WHEN 'firefly-gpt-image-2' THEN 'gpt-image-2'
        WHEN 'firefly-gpt-image-1.5' THEN 'gpt-image-1.5'
        WHEN 'firefly-nano-banana' THEN 'nano-banana'
        WHEN 'firefly-nano-banana2' THEN 'nano-banana2'
        WHEN 'firefly-nano-banana-pro' THEN 'nano-banana-pro'
        ELSE model."id"
      END
      ORDER BY model."ordinality"
    )
    FROM jsonb_array_elements_text("supported_model_ids"::jsonb)
      WITH ORDINALITY AS model("id", "ordinality")
  ),
  "content_safety_enabled",
  "is_enabled",
  "always_active",
  "failure_cooldown_enabled",
  "priority",
  "concurrency",
  "success_count" + "fail_count",
  "success_count",
  "fail_count",
  "status",
  CASE "status"
    WHEN 'error' THEN 'unhealthy'
    WHEN 'limited' THEN 'degraded'
    ELSE 'healthy'
  END,
  coalesce("last_error_at", "last_used_at", "last_acquired_at"),
  "last_used_at",
  "last_acquired_at",
  "cooldown_until",
  "last_error",
  "last_error_at",
  jsonb_set(
    coalesce("metadata"::jsonb, '{}'::jsonb),
    '{legacyUnifiedPool}',
    jsonb_build_object(
      'model', "model",
      'interfaceMode', "interface_mode",
      'useStream', "use_stream",
      'chatCompletionsUpstreamMode', "chat_completions_upstream_mode",
      'imageUpstreamMode', "image_upstream_mode",
      'adobeSourced', "adobe_sourced",
      'billingMultiplier', "billing_multiplier"
    ),
    true
  )::json,
  "created_at",
  "updated_at"
FROM "image_backend_api";
--> statement-breakpoint
INSERT INTO "image_backend_member_api_config" (
  "member_id",
  "base_url",
  "api_key",
  "use_stream",
  "parameter_mappings",
  "created_at",
  "updated_at"
)
SELECT
  "id",
  "base_url",
  "api_key",
  "use_stream",
  "parameter_mappings",
  "created_at",
  "updated_at"
FROM "image_backend_api";
--> statement-breakpoint
INSERT INTO "image_backend_member" (
  "id",
  "type",
  "name",
  "supported_model_ids",
  "content_safety_enabled",
  "is_enabled",
  "always_active",
  "failure_cooldown_enabled",
  "priority",
  "concurrency",
  "lease_acquired_count",
  "success_count",
  "fail_count",
  "status",
  "health_status",
  "last_observed_at",
  "last_used_at",
  "last_acquired_at",
  "cooldown_until",
  "last_error",
  "last_error_at",
  "metadata",
  "created_at",
  "updated_at"
)
SELECT
  "id",
  'adobe',
  "name",
  (
    CASE
      WHEN "enabled_models" IS NOT NULL
        AND json_array_length("enabled_models") > 0
        THEN (
          SELECT jsonb_agg(
            CASE model."id"
              WHEN 'firefly-gpt-image-2' THEN 'gpt-image-2'
              WHEN 'firefly-gpt-image-1.5' THEN 'gpt-image-1.5'
              WHEN 'firefly-nano-banana' THEN 'nano-banana'
              WHEN 'firefly-nano-banana2' THEN 'nano-banana2'
              WHEN 'firefly-nano-banana-pro' THEN 'nano-banana-pro'
              ELSE model."id"
            END
            ORDER BY model."ordinality"
          )
          FROM jsonb_array_elements_text("enabled_models"::jsonb)
            WITH ORDINALITY AS model("id", "ordinality")
        )
      ELSE jsonb_build_array(
        'gpt-image-2',
        'gpt-image-1.5',
        'nano-banana',
        'nano-banana2',
        'nano-banana-pro'
      )
    END
    || CASE
      WHEN "supports_video" AND "mode" = 'direct' THEN jsonb_build_array(
        'firefly-sora2-4s-9x16',
        'firefly-sora2-4s-16x9',
        'firefly-sora2-8s-9x16',
        'firefly-sora2-8s-16x9',
        'firefly-sora2-12s-9x16',
        'firefly-sora2-12s-16x9',
        'firefly-sora2-pro-4s-9x16',
        'firefly-sora2-pro-4s-16x9',
        'firefly-sora2-pro-8s-9x16',
        'firefly-sora2-pro-8s-16x9',
        'firefly-sora2-pro-12s-9x16',
        'firefly-sora2-pro-12s-16x9',
        'firefly-veo31-4s-16x9-1080p',
        'firefly-veo31-4s-16x9-720p',
        'firefly-veo31-4s-9x16-1080p',
        'firefly-veo31-4s-9x16-720p',
        'firefly-veo31-6s-16x9-1080p',
        'firefly-veo31-6s-16x9-720p',
        'firefly-veo31-6s-9x16-1080p',
        'firefly-veo31-6s-9x16-720p',
        'firefly-veo31-8s-16x9-1080p',
        'firefly-veo31-8s-16x9-720p',
        'firefly-veo31-8s-9x16-1080p',
        'firefly-veo31-8s-9x16-720p',
        'firefly-veo31-ref-4s-16x9-1080p',
        'firefly-veo31-ref-4s-16x9-720p',
        'firefly-veo31-ref-4s-9x16-1080p',
        'firefly-veo31-ref-4s-9x16-720p',
        'firefly-veo31-ref-6s-16x9-1080p',
        'firefly-veo31-ref-6s-16x9-720p',
        'firefly-veo31-ref-6s-9x16-1080p',
        'firefly-veo31-ref-6s-9x16-720p',
        'firefly-veo31-ref-8s-16x9-1080p',
        'firefly-veo31-ref-8s-16x9-720p',
        'firefly-veo31-ref-8s-9x16-1080p',
        'firefly-veo31-ref-8s-9x16-720p',
        'firefly-veo31-fast-4s-16x9-1080p',
        'firefly-veo31-fast-4s-16x9-720p',
        'firefly-veo31-fast-4s-9x16-1080p',
        'firefly-veo31-fast-4s-9x16-720p',
        'firefly-veo31-fast-6s-16x9-1080p',
        'firefly-veo31-fast-6s-16x9-720p',
        'firefly-veo31-fast-6s-9x16-1080p',
        'firefly-veo31-fast-6s-9x16-720p',
        'firefly-veo31-fast-8s-16x9-1080p',
        'firefly-veo31-fast-8s-16x9-720p',
        'firefly-veo31-fast-8s-9x16-1080p',
        'firefly-veo31-fast-8s-9x16-720p',
        'firefly-kling-o3-5s-16x9',
        'firefly-kling-o3-5s-9x16',
        'firefly-kling-o3-15s-16x9',
        'firefly-kling-o3-15s-9x16',
        'firefly-kling3-5s-16x9',
        'firefly-kling3-5s-9x16',
        'firefly-kling3-10s-16x9',
        'firefly-kling3-10s-9x16',
        'firefly-kling3-15s-16x9',
        'firefly-kling3-15s-9x16'
      )
      ELSE '[]'::jsonb
    END
  )::json,
  "content_safety_enabled",
  "is_enabled",
  "always_active",
  "failure_cooldown_enabled",
  "priority",
  "concurrency",
  "success_count" + "fail_count",
  "success_count",
  "fail_count",
  "status",
  CASE "status"
    WHEN 'error' THEN 'unhealthy'
    WHEN 'limited' THEN 'degraded'
    ELSE 'healthy'
  END,
  coalesce("last_error_at", "last_used_at", "last_acquired_at"),
  "last_used_at",
  "last_acquired_at",
  "cooldown_until",
  "last_error",
  "last_error_at",
  jsonb_set(
    coalesce("metadata"::jsonb, '{}'::jsonb),
    '{legacyUnifiedPool}',
    jsonb_build_object(
      'enabledModels', "enabled_models",
      'supportsVideo', "supports_video",
      'billingMultiplier', "billing_multiplier"
    ),
    true
  )::json,
  "created_at",
  "updated_at"
FROM "image_backend_adobe";
--> statement-breakpoint
INSERT INTO "image_backend_member_adobe_config" (
  "member_id",
  "mode",
  "base_url",
  "api_key",
  "default_ratio",
  "default_resolution",
  "gpt_image_quality",
  "created_at",
  "updated_at"
)
SELECT
  "id",
  "mode",
  CASE WHEN "mode" = 'gateway' THEN "base_url" ELSE NULL END,
  CASE WHEN "mode" = 'gateway' THEN "api_key" ELSE NULL END,
  "default_ratio",
  "default_resolution",
  "gpt_image_quality",
  "created_at",
  "updated_at"
FROM "image_backend_adobe";
--> statement-breakpoint
-- 旧 API/Adobe 关系表拥有独立主键命名空间；加类型前缀后再合并，避免合法同名 ID
-- 在统一关系表产生主键冲突。旧单列 group_id 仅在关系表缺失时补齐。
INSERT INTO "image_backend_member_group" (
  "id",
  "member_id",
  "group_id",
  "created_at"
)
SELECT 'legacy-api-relation:' || "id", "api_id", "group_id", "created_at"
FROM "image_backend_api_group"
UNION ALL
SELECT 'legacy-adobe-relation:' || "id", "adobe_id", "group_id", "created_at"
FROM "image_backend_adobe_group";
--> statement-breakpoint
INSERT INTO "image_backend_member_group" (
  "id",
  "member_id",
  "group_id",
  "created_at"
)
SELECT
  'legacy-api:' || api."id" || ':' || api."group_id",
  api."id",
  api."group_id",
  api."created_at"
FROM "image_backend_api" AS api
WHERE api."group_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "image_backend_member_group" AS relation
    WHERE relation."member_id" = api."id"
      AND relation."group_id" = api."group_id"
  )
UNION ALL
SELECT
  'legacy-adobe:' || adobe."id" || ':' || adobe."group_id",
  adobe."id",
  adobe."group_id",
  adobe."created_at"
FROM "image_backend_adobe" AS adobe
WHERE adobe."group_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "image_backend_member_group" AS relation
    WHERE relation."member_id" = adobe."id"
      AND relation."group_id" = adobe."group_id"
  );
--> statement-breakpoint
-- 维护窗口拒绝未过期租约；已过期租约保留原 ID，等待统一清理器回收。
INSERT INTO "image_backend_member_lease" (
  "id",
  "member_id",
  "owner_token",
  "expires_at",
  "created_at",
  "updated_at"
)
SELECT
  lease."id",
  lease."member_id",
  'legacy-migration:' || lease."id",
  lease."expires_at",
  lease."created_at",
  lease."created_at"
FROM "image_backend_inflight_lease" AS lease
WHERE lease."member_type" IN ('api', 'adobe')
  AND EXISTS (
    SELECT 1
    FROM "image_backend_member" AS member
    WHERE member."id" = lease."member_id"
      AND member."type" = lease."member_type"
  );
--> statement-breakpoint
-- 新旧指标维度不同。顶层字段生成兼容聚合供新看板读取，原行及全部旧计数完整封装在
-- metadata.legacyRows，避免伪造逐次新策略事实或静默丢弃历史观测。
WITH normalized_legacy_metric AS (
  SELECT
    metric."id",
    metric."bucket_started_at",
    CASE
      WHEN metric."request_kind" LIKE '%video%' THEN 'video'
      ELSE 'image'
    END AS "request_kind",
    'least_load' AS "strategy",
    CASE
      WHEN metric."selected_layer" = 'switch'
        OR metric."switch_count" > 0
        THEN 'switched'
      ELSE 'acquired'
    END AS "outcome",
    CASE
      WHEN metric."member_type" IN ('api', 'adobe')
        THEN metric."member_type"
      ELSE NULL
    END AS "member_type",
    metric."member_id",
    metric."group_id",
    greatest(metric."select_count", 0)
      + greatest(metric."switch_count", 0) AS "event_count",
    greatest(metric."candidate_count_total", 0) AS "candidate_count_total",
    greatest(metric."latency_ms_total", 0) AS "latency_ms_total",
    jsonb_build_object(
      'id', metric."id",
      'selectedLayer', metric."selected_layer",
      'requestKind', metric."request_kind",
      'memberType', metric."member_type",
      'memberId', metric."member_id",
      'groupId', metric."group_id",
      'selectCount', metric."select_count",
      'stickyPreviousHitCount', metric."sticky_previous_hit_count",
      'stickySessionHitCount', metric."sticky_session_hit_count",
      'loadBalanceCount', metric."load_balance_count",
      'switchCount', metric."switch_count",
      'candidateCountTotal', metric."candidate_count_total",
      'latencyMsTotal', metric."latency_ms_total",
      'metadata', metric."metadata"
    ) AS "legacy_row",
    metric."created_at",
    metric."updated_at"
  FROM "image_backend_scheduler_metric" AS metric
), aggregated_legacy_metric AS (
  SELECT
    min("id") AS "id",
    "bucket_started_at",
    "request_kind",
    "strategy",
    "outcome",
    "member_type",
    "member_id",
    "group_id",
    sum("event_count")::integer AS "event_count",
    sum("candidate_count_total")::integer AS "candidate_count_total",
    sum("latency_ms_total")::integer AS "latency_ms_total",
    jsonb_build_object(
      'source', 'legacy_scheduler_metric',
      'legacyRows', jsonb_agg("legacy_row" ORDER BY "id")
    )::json AS "metadata",
    min("created_at") AS "created_at",
    max("updated_at") AS "updated_at"
  FROM normalized_legacy_metric
  GROUP BY
    "bucket_started_at",
    "request_kind",
    "strategy",
    "outcome",
    "member_type",
    "member_id",
    "group_id"
)
INSERT INTO "image_backend_member_scheduler_metric" (
  "id",
  "bucket_started_at",
  "request_kind",
  "strategy",
  "outcome",
  "member_type",
  "member_id",
  "group_id",
  "event_count",
  "candidate_count_total",
  "latency_ms_total",
  "metadata",
  "created_at",
  "updated_at"
)
SELECT
  "id",
  "bucket_started_at",
  "request_kind",
  "strategy",
  "outcome",
  "member_type",
  "member_id",
  "group_id",
  "event_count",
  "candidate_count_total",
  "latency_ms_total",
  "metadata",
  "created_at",
  "updated_at"
FROM aggregated_legacy_metric;
--> statement-breakpoint
ALTER TABLE "adobe_account"
  DROP CONSTRAINT IF EXISTS "adobe_account_backend_owner_check",
  ADD COLUMN "member_id" text;
--> statement-breakpoint
UPDATE "adobe_account"
SET "member_id" = "adobe_id";
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
UPDATE "adobe_token"
SET "member_id" = "adobe_id";
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
SET
  "backend_member_id" = "adobe_id",
  "stage" = CASE "status"
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
