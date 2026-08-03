-- Adobe direct 凭据健康、事件与通知 outbox 迁移。
--
-- 职责：增加不含 Cookie/Token 的当前健康摘要、评估历史、单一开放事件和
-- 分渠道投递行。迁移只为既有 Adobe direct 成员建立待首次检查摘要，不修改
-- 任何 Adobe 配置字段；完整重跑幂等，检测到半迁移形态时 fail-closed。

DO $migration_shape$
DECLARE
  target_schema text := current_schema();
  existing_table_count integer;
  present_count integer;
BEGIN
  SELECT count(*)::integer
  INTO existing_table_count
  FROM information_schema.tables
  WHERE table_schema = target_schema
    AND table_name IN (
      'adobe_credential_health',
      'adobe_credential_evaluation',
      'adobe_credential_incident',
      'adobe_credential_notification_delivery'
    );

  IF existing_table_count = 0 THEN
    RETURN;
  END IF;

  IF existing_table_count <> 4 THEN
    RAISE EXCEPTION
      '0080 blocked: Adobe credential health tables have a partial shape';
  END IF;

  SELECT count(*)::integer
  INTO present_count
  FROM information_schema.columns
  WHERE table_schema = target_schema
    AND table_name = 'adobe_credential_health'
    AND column_name IN (
      'member_id', 'status', 'credential_revision', 'member_enable_revision',
      'consecutive_failures', 'failure_profiles', 'claim_token',
      'claim_expires_at', 'next_check_at', 'evaluation_deadline_at',
      'last_check_at', 'last_success_at', 'first_failure_at',
      'last_failure_at', 'isolated_at', 'diagnostic', 'created_at', 'updated_at'
    );
  IF present_count <> 18 THEN
    RAISE EXCEPTION
      '0080 blocked: adobe_credential_health has a partial column shape';
  END IF;

  SELECT count(*)::integer
  INTO present_count
  FROM information_schema.columns
  WHERE table_schema = target_schema
    AND table_name = 'adobe_credential_evaluation'
    AND column_name IN (
      'id', 'claim_token', 'member_id_snapshot', 'member_name_snapshot',
      'credential_revision', 'member_enable_revision', 'source', 'disposition',
      'outcome', 'failure_profiles', 'diagnostic', 'started_at', 'completed_at',
      'created_at'
    );
  IF present_count <> 14 THEN
    RAISE EXCEPTION
      '0080 blocked: adobe_credential_evaluation has a partial column shape';
  END IF;

  SELECT count(*)::integer
  INTO present_count
  FROM information_schema.columns
  WHERE table_schema = target_schema
    AND table_name = 'adobe_credential_incident'
    AND column_name IN (
      'id', 'member_id_snapshot', 'member_name_snapshot', 'status',
      'consecutive_failures', 'failure_profiles', 'diagnostic', 'opened_at',
      'last_failure_at', 'closed_at', 'close_reason', 'created_at', 'updated_at'
    );
  IF present_count <> 13 THEN
    RAISE EXCEPTION
      '0080 blocked: adobe_credential_incident has a partial column shape';
  END IF;

  SELECT count(*)::integer
  INTO present_count
  FROM information_schema.columns
  WHERE table_schema = target_schema
    AND table_name = 'adobe_credential_notification_delivery'
    AND column_name IN (
      'id', 'incident_id', 'event_type', 'channel', 'status', 'target_envelope',
      'payload', 'payload_hash', 'config_revision', 'secret_fingerprint',
      'attempt_count', 'next_attempt_at', 'claim_token', 'claim_expires_at',
      'last_error_code', 'provider_request_id', 'delivered_at', 'created_at',
      'updated_at'
    );
  IF present_count <> 19 THEN
    RAISE EXCEPTION
      '0080 blocked: adobe_credential_notification_delivery has a partial column shape';
  END IF;

  SELECT count(*)::integer
  INTO present_count
  FROM pg_constraint
  WHERE connamespace = target_schema::regnamespace
    AND conname IN (
      'adobe_credential_health_pkey',
      'adobe_credential_health_member_id_image_backend_member_id_fk',
      'adobe_credential_health_status_check',
      'adobe_credential_health_revisions_check',
      'adobe_credential_health_failure_count_check',
      'adobe_credential_health_claim_pair_check',
      'adobe_credential_health_isolation_check',
      'adobe_credential_evaluation_pkey',
      'adobe_credential_evaluation_claim_unique',
      'adobe_credential_evaluation_revisions_check',
      'adobe_credential_evaluation_source_check',
      'adobe_credential_evaluation_disposition_check',
      'adobe_credential_evaluation_outcome_check',
      'adobe_credential_incident_pkey',
      'adobe_credential_incident_status_check',
      'adobe_credential_incident_failure_count_check',
      'adobe_credential_incident_close_shape_check',
      'adobe_credential_notification_delivery_pkey',
      'adobe_credential_delivery_incident_fk',
      'adobe_credential_delivery_event_channel_unique',
      'adobe_credential_delivery_event_type_check',
      'adobe_credential_delivery_channel_check',
      'adobe_credential_delivery_status_check',
      'adobe_credential_delivery_attempt_count_check',
      'adobe_credential_delivery_claim_pair_check'
    );
  IF present_count <> 25 THEN
    RAISE EXCEPTION
      '0080 blocked: Adobe credential health constraints have a partial shape';
  END IF;

  SELECT count(*)::integer
  INTO present_count
  FROM pg_indexes
  WHERE schemaname = target_schema
    AND indexname IN (
      'adobe_credential_health_due_idx',
      'adobe_credential_health_isolated_idx',
      'adobe_credential_evaluation_member_created_idx',
      'adobe_credential_evaluation_retention_idx',
      'adobe_credential_incident_open_member_unique',
      'adobe_credential_incident_retention_idx',
      'adobe_credential_delivery_recovery_idx',
      'adobe_credential_delivery_retention_idx'
    );
  IF present_count <> 8 THEN
    RAISE EXCEPTION
      '0080 blocked: Adobe credential health indexes have a partial shape';
  END IF;
END
$migration_shape$;

CREATE TABLE IF NOT EXISTS "adobe_credential_health" (
  "member_id" text PRIMARY KEY,
  "status" text NOT NULL DEFAULT 'pending',
  "credential_revision" integer NOT NULL DEFAULT 1,
  "member_enable_revision" integer NOT NULL DEFAULT 1,
  "consecutive_failures" integer NOT NULL DEFAULT 0,
  "failure_profiles" json NOT NULL DEFAULT '[]'::json,
  "claim_token" text,
  "claim_expires_at" timestamp,
  "next_check_at" timestamp NOT NULL DEFAULT now(),
  "evaluation_deadline_at" timestamp,
  "last_check_at" timestamp,
  "last_success_at" timestamp,
  "first_failure_at" timestamp,
  "last_failure_at" timestamp,
  "isolated_at" timestamp,
  "diagnostic" json,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "adobe_credential_health_member_id_image_backend_member_id_fk"
    FOREIGN KEY ("member_id") REFERENCES "image_backend_member"("id")
    ON DELETE CASCADE,
  CONSTRAINT "adobe_credential_health_status_check"
    CHECK ("status" IN ('pending', 'healthy', 'degraded', 'isolated', 'overdue')),
  CONSTRAINT "adobe_credential_health_revisions_check"
    CHECK ("credential_revision" >= 1 AND "member_enable_revision" >= 1),
  CONSTRAINT "adobe_credential_health_failure_count_check"
    CHECK ("consecutive_failures" >= 0),
  CONSTRAINT "adobe_credential_health_claim_pair_check"
    CHECK (
      ("claim_token" IS NULL AND "claim_expires_at" IS NULL)
      OR ("claim_token" IS NOT NULL AND "claim_expires_at" IS NOT NULL)
    ),
  CONSTRAINT "adobe_credential_health_isolation_check"
    CHECK (
      ("status" = 'isolated' AND "isolated_at" IS NOT NULL)
      OR "status" <> 'isolated'
    )
);

CREATE INDEX IF NOT EXISTS "adobe_credential_health_due_idx"
  ON "adobe_credential_health" ("status", "next_check_at", "claim_expires_at");
CREATE INDEX IF NOT EXISTS "adobe_credential_health_isolated_idx"
  ON "adobe_credential_health" ("isolated_at");

CREATE TABLE IF NOT EXISTS "adobe_credential_evaluation" (
  "id" text PRIMARY KEY,
  "claim_token" text NOT NULL,
  "member_id_snapshot" text NOT NULL,
  "member_name_snapshot" text NOT NULL,
  "credential_revision" integer NOT NULL,
  "member_enable_revision" integer NOT NULL,
  "source" text NOT NULL,
  "disposition" text NOT NULL,
  "outcome" text NOT NULL,
  "failure_profiles" json NOT NULL DEFAULT '[]'::json,
  "diagnostic" json,
  "started_at" timestamp NOT NULL,
  "completed_at" timestamp NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "adobe_credential_evaluation_claim_unique" UNIQUE ("claim_token"),
  CONSTRAINT "adobe_credential_evaluation_revisions_check"
    CHECK ("credential_revision" >= 1 AND "member_enable_revision" >= 1),
  CONSTRAINT "adobe_credential_evaluation_source_check"
    CHECK ("source" IN ('scheduled', 'passive', 'manual', 'reauthorization')),
  CONSTRAINT "adobe_credential_evaluation_disposition_check"
    CHECK ("disposition" IN ('accepted', 'stale', 'discarded')),
  CONSTRAINT "adobe_credential_evaluation_outcome_check"
    CHECK ("outcome" IN ('success', 'member_failure', 'platform_failure'))
);

CREATE INDEX IF NOT EXISTS "adobe_credential_evaluation_member_created_idx"
  ON "adobe_credential_evaluation" ("member_id_snapshot", "created_at");
CREATE INDEX IF NOT EXISTS "adobe_credential_evaluation_retention_idx"
  ON "adobe_credential_evaluation" ("completed_at");

CREATE TABLE IF NOT EXISTS "adobe_credential_incident" (
  "id" text PRIMARY KEY,
  "member_id_snapshot" text NOT NULL,
  "member_name_snapshot" text NOT NULL,
  "status" text NOT NULL DEFAULT 'open',
  "consecutive_failures" integer NOT NULL,
  "failure_profiles" json NOT NULL DEFAULT '[]'::json,
  "diagnostic" json,
  "opened_at" timestamp NOT NULL DEFAULT now(),
  "last_failure_at" timestamp NOT NULL,
  "closed_at" timestamp,
  "close_reason" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "adobe_credential_incident_status_check"
    CHECK ("status" IN ('open', 'closed')),
  CONSTRAINT "adobe_credential_incident_failure_count_check"
    CHECK ("consecutive_failures" >= 1),
  CONSTRAINT "adobe_credential_incident_close_shape_check"
    CHECK (
      ("status" = 'open' AND "closed_at" IS NULL AND "close_reason" IS NULL)
      OR (
        "status" = 'closed'
        AND "closed_at" IS NOT NULL
        AND "close_reason" IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS "adobe_credential_incident_open_member_unique"
  ON "adobe_credential_incident" ("member_id_snapshot")
  WHERE "status" = 'open';
CREATE INDEX IF NOT EXISTS "adobe_credential_incident_retention_idx"
  ON "adobe_credential_incident" ("status", "closed_at");

CREATE TABLE IF NOT EXISTS "adobe_credential_notification_delivery" (
  "id" text PRIMARY KEY,
  "incident_id" text NOT NULL,
  "event_type" text NOT NULL,
  "channel" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "target_envelope" json NOT NULL,
  "payload" json NOT NULL,
  "payload_hash" text NOT NULL,
  "config_revision" text NOT NULL,
  "secret_fingerprint" text,
  "attempt_count" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamp NOT NULL DEFAULT now(),
  "claim_token" text,
  "claim_expires_at" timestamp,
  "last_error_code" text,
  "provider_request_id" text,
  "delivered_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "adobe_credential_delivery_incident_fk"
    FOREIGN KEY ("incident_id") REFERENCES "adobe_credential_incident"("id")
    ON DELETE RESTRICT,
  CONSTRAINT "adobe_credential_delivery_event_channel_unique"
    UNIQUE ("incident_id", "event_type", "channel"),
  CONSTRAINT "adobe_credential_delivery_event_type_check"
    CHECK ("event_type" IN ('failure', 'recovery')),
  CONSTRAINT "adobe_credential_delivery_channel_check"
    CHECK ("channel" IN ('email', 'webhook')),
  CONSTRAINT "adobe_credential_delivery_status_check"
    CHECK (
      "status" IN (
        'pending', 'delivering', 'retry', 'delivered', 'dead',
        'configuration_superseded', 'cancelled'
      )
    ),
  CONSTRAINT "adobe_credential_delivery_attempt_count_check"
    CHECK ("attempt_count" >= 0 AND "attempt_count" <= 8),
  CONSTRAINT "adobe_credential_delivery_claim_pair_check"
    CHECK (
      ("claim_token" IS NULL AND "claim_expires_at" IS NULL)
      OR ("claim_token" IS NOT NULL AND "claim_expires_at" IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS "adobe_credential_delivery_recovery_idx"
  ON "adobe_credential_notification_delivery" (
    "status", "next_attempt_at", "claim_expires_at"
  );
CREATE INDEX IF NOT EXISTS "adobe_credential_delivery_retention_idx"
  ON "adobe_credential_notification_delivery" ("status", "delivered_at");

INSERT INTO "adobe_credential_health" (
  "member_id",
  "status",
  "credential_revision",
  "member_enable_revision",
  "consecutive_failures",
  "failure_profiles",
  "next_check_at"
)
SELECT
  member.id,
  'pending',
  1,
  1,
  0,
  '[]'::json,
  now()
FROM "image_backend_member" AS member
INNER JOIN "image_backend_member_adobe_config" AS config
  ON config.member_id = member.id
WHERE member.type = 'adobe'
  AND config.mode = 'direct'
ON CONFLICT ("member_id") DO NOTHING;
