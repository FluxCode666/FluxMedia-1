-- 统一媒体后端数据模型的 expand 阶段。
-- 旧成员、租约和指标表继续保留，供尚未迁移的应用实例安全读取。
CREATE TABLE IF NOT EXISTS "image_backend_member" (
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
CREATE INDEX IF NOT EXISTS "image_backend_member_eligibility_idx"
  ON "image_backend_member" ("is_enabled", "status", "priority", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "image_backend_member_cooldown_idx"
  ON "image_backend_member" ("cooldown_until");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "image_backend_member_api_config" (
  "member_id" text PRIMARY KEY NOT NULL,
  "base_url" text NOT NULL,
  "api_key" text,
  "parameter_mappings" json DEFAULT '[]'::json NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "image_backend_member_api_config_mappings_check"
    CHECK (json_typeof("parameter_mappings") = 'array')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "image_backend_member_adobe_config" (
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
    CHECK ("gpt_image_quality" IN ('low', 'medium', 'high'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "image_backend_member_group" (
  "id" text PRIMARY KEY NOT NULL,
  "member_id" text NOT NULL,
  "group_id" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "image_backend_member_lease" (
  "id" text PRIMARY KEY NOT NULL,
  "member_id" text NOT NULL,
  "owner_token" text NOT NULL,
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "image_backend_member_scheduler_metric" (
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
DO $$ BEGIN
 ALTER TABLE "image_backend_member_api_config" ADD CONSTRAINT "image_backend_member_api_config_member_id_image_backend_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."image_backend_member"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "image_backend_member_adobe_config" ADD CONSTRAINT "image_backend_member_adobe_config_member_id_image_backend_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."image_backend_member"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "image_backend_member_group" ADD CONSTRAINT "image_backend_member_group_member_id_image_backend_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."image_backend_member"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "image_backend_member_group" ADD CONSTRAINT "image_backend_member_group_group_id_image_backend_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."image_backend_group"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "image_backend_member_lease" ADD CONSTRAINT "image_backend_member_lease_member_id_image_backend_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."image_backend_member"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "image_backend_member_group_member_group_unique"
  ON "image_backend_member_group" ("member_id", "group_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "image_backend_member_group_group_idx"
  ON "image_backend_member_group" ("group_id", "member_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "image_backend_member_lease_member_expires_idx"
  ON "image_backend_member_lease" ("member_id", "expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "image_backend_member_lease_expires_idx"
  ON "image_backend_member_lease" ("expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "image_backend_member_scheduler_metric_bucket_idx"
  ON "image_backend_member_scheduler_metric" (
    "bucket_started_at",
    "strategy",
    "outcome"
  );
--> statement-breakpoint
ALTER TABLE "adobe_account" ADD COLUMN IF NOT EXISTS "member_id" text;
--> statement-breakpoint
ALTER TABLE "adobe_token" ADD COLUMN IF NOT EXISTS "member_id" text;
--> statement-breakpoint
ALTER TABLE "video_generation" ADD COLUMN IF NOT EXISTS "backend_member_id" text;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "adobe_account" ADD CONSTRAINT "adobe_account_member_id_image_backend_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."image_backend_member"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "adobe_token" ADD CONSTRAINT "adobe_token_member_id_image_backend_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."image_backend_member"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "video_generation" ADD CONSTRAINT "video_generation_backend_member_id_image_backend_member_id_fk" FOREIGN KEY ("backend_member_id") REFERENCES "public"."image_backend_member"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "adobe_account" ADD CONSTRAINT "adobe_account_backend_owner_check" CHECK ("adobe_id" IS NOT NULL OR "member_id" IS NOT NULL);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "adobe_token" ADD CONSTRAINT "adobe_token_backend_owner_check" CHECK ("adobe_id" IS NOT NULL OR "member_id" IS NOT NULL);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "adobe_account" ALTER COLUMN "adobe_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "adobe_token" ALTER COLUMN "adobe_id" DROP NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "adobe_account_member_idx"
  ON "adobe_account" ("member_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "adobe_token_member_idx"
  ON "adobe_token" ("member_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "adobe_token_member_status_idx"
  ON "adobe_token" ("member_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "video_generation_backend_member_idx"
  ON "video_generation" ("backend_member_id");
