-- 运营总览 epoch 与网页访问事实基础结构。
--
-- WHY：行为统计从显式生产 epoch 开始，不根据迁移时间猜测；网页访问事实使用
-- 数据库唯一约束抵抗同日重放与并发竞争。

-- 生产已有用户数据时，必须先按运行手册在迁移事务外并发预建同名索引：
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS "user_created_at_id_idx"
--   ON public."user" ("created_at", "id");
-- WHY：drizzle-kit migrate 在事务内执行，CONCURRENTLY 在事务块中非法；生产预建后
-- 下列普通 CREATE INDEX 为 no-op，新建或重置库的 user 表为空，普通建索引锁定瞬时。
CREATE INDEX IF NOT EXISTS "user_created_at_id_idx"
  ON "user" ("created_at", "id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "operations_analytics_epoch" (
  "id" integer PRIMARY KEY NOT NULL,
  "app_date" text NOT NULL,
  "starts_at" timestamp NOT NULL,
  "initialized_by" text,
  "initialization_request_id" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "operations_analytics_epoch_singleton_check" CHECK ("id" = 1),
  CONSTRAINT "operations_analytics_epoch_app_date_check"
    CHECK ("app_date" ~ '^\d{4}-\d{2}-\d{2}$')
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "operations_analytics_epoch_request_unique"
  ON "operations_analytics_epoch" ("initialization_request_id");
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "reject_operations_analytics_epoch_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'operations analytics epoch is immutable';
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "operations_analytics_epoch_immutable_trigger"
  ON "operations_analytics_epoch";
--> statement-breakpoint

CREATE TRIGGER "operations_analytics_epoch_immutable_trigger"
  BEFORE UPDATE OR DELETE ON "operations_analytics_epoch"
  FOR EACH ROW EXECUTE FUNCTION "reject_operations_analytics_epoch_mutation"();
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "user_web_visit" (
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "app_date" text NOT NULL,
  "first_visited_at" timestamp NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "user_web_visit_user_app_date_pk" PRIMARY KEY ("user_id", "app_date"),
  CONSTRAINT "user_web_visit_app_date_check"
    CHECK ("app_date" ~ '^\d{4}-\d{2}-\d{2}$')
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "user_web_visit_app_date_user_idx"
  ON "user_web_visit" ("app_date", "user_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "user_web_visit_first_visited_user_idx"
  ON "user_web_visit" ("first_visited_at", "user_id");
--> statement-breakpoint

-- 异步 CSV 导出任务冻结范围、时区、epoch 与事实高水位；陈旧 worker 只能持有
-- 已失效 lease_token，不能提交完成结果或覆盖新 attempt。
CREATE TABLE IF NOT EXISTS "operations_export_task" (
  "id" text PRIMARY KEY NOT NULL,
  "created_by" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "client_request_id" text NOT NULL,
  "export_type" text NOT NULL,
  "status" text NOT NULL DEFAULT 'queued',
  "query" json NOT NULL,
  "time_zone" text NOT NULL,
  "epoch_app_date" text NOT NULL,
  "epoch_starts_at" timestamp NOT NULL,
  "schema_version" integer NOT NULL DEFAULT 1,
  "snapshot_at" timestamp NOT NULL,
  "high_watermarks" json NOT NULL,
  "retry_of_task_id" text,
  "attempt_count" integer NOT NULL DEFAULT 0,
  "lease_owner" text,
  "lease_token" text,
  "lease_expires_at" timestamp,
  "object_bucket" text,
  "object_key" text,
  "checksum_sha256" text,
  "row_count" bigint,
  "byte_count" bigint,
  "error_code" text,
  "completed_at" timestamp,
  "expires_at" timestamp,
  "object_deleted_at" timestamp,
  "cleanup_error_code" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "operations_export_task_retry_fk"
    FOREIGN KEY ("retry_of_task_id")
    REFERENCES "operations_export_task"("id") ON DELETE SET NULL,
  CONSTRAINT "operations_export_task_type_check" CHECK (
    "export_type" IN ('user_growth', 'commercialization', 'content_production')
  ),
  CONSTRAINT "operations_export_task_status_check" CHECK (
    "status" IN ('queued', 'running', 'completed', 'failed', 'expired')
  ),
  CONSTRAINT "operations_export_task_epoch_app_date_check"
    CHECK ("epoch_app_date" ~ '^\d{4}-\d{2}-\d{2}$'),
  CONSTRAINT "operations_export_task_attempt_count_check"
    CHECK ("attempt_count" >= 0),
  CONSTRAINT "operations_export_task_lease_shape_check" CHECK (
    (
      "status" = 'running'
      AND "lease_owner" IS NOT NULL
      AND "lease_token" IS NOT NULL
      AND "lease_expires_at" IS NOT NULL
    ) OR (
      "status" <> 'running'
      AND "lease_owner" IS NULL
      AND "lease_token" IS NULL
      AND "lease_expires_at" IS NULL
    )
  ),
  CONSTRAINT "operations_export_task_object_shape_check" CHECK (
    (
      "status" IN ('completed', 'expired')
      AND "object_bucket" IS NOT NULL
      AND "object_key" IS NOT NULL
      AND "checksum_sha256" IS NOT NULL
      AND "row_count" IS NOT NULL
      AND "byte_count" IS NOT NULL
      AND "completed_at" IS NOT NULL
      AND "expires_at" IS NOT NULL
    ) OR "status" IN ('queued', 'running', 'failed')
  )
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "operations_export_task_creator_request_unique"
  ON "operations_export_task" ("created_by", "client_request_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "operations_export_task_creator_created_idx"
  ON "operations_export_task" ("created_by", "created_at" DESC, "id" DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "operations_export_task_claim_idx"
  ON "operations_export_task" ("status", "lease_expires_at", "created_at", "id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "operations_export_task_expire_idx"
  ON "operations_export_task" ("status", "expires_at", "id");
--> statement-breakpoint

-- 支付生命周期事件只从本迁移上线后在线写入，不根据历史 updated_at 回造阶段时间。
CREATE TABLE IF NOT EXISTS "payment_lifecycle_event" (
  "id" text PRIMARY KEY NOT NULL,
  "payment_order_id" text NOT NULL REFERENCES "payment_order"("id") ON DELETE CASCADE,
  "event_type" text NOT NULL,
  "source_ref" text NOT NULL,
  "occurred_at" timestamp NOT NULL,
  "recorded_at" timestamp NOT NULL DEFAULT now(),
  "timestamp_source" text NOT NULL,
  "provider" text NOT NULL,
  CONSTRAINT "payment_lifecycle_event_type_check" CHECK (
    "event_type" IN (
      'order_created', 'checkout_ready', 'payment_confirmed',
      'fulfillment_succeeded', 'checkout_failed',
      'fulfillment_attempt_failed', 'fulfillment_failed_terminal', 'expired'
    )
  ),
  CONSTRAINT "payment_lifecycle_event_timestamp_source_check" CHECK (
    "timestamp_source" IN ('provider', 'server_received', 'server_generated')
  )
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "payment_lifecycle_event_order_type_source_unique"
  ON "payment_lifecycle_event" ("payment_order_id", "event_type", "source_ref");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "payment_lifecycle_event_type_occurred_order_idx"
  ON "payment_lifecycle_event" ("event_type", "occurred_at", "payment_order_id");
--> statement-breakpoint

-- 已验签支付确认与工作项同事务落库；冻结字段防止恢复时读取已变化的包配置。
CREATE TABLE IF NOT EXISTS "payment_fulfillment_work_item" (
  "id" text PRIMARY KEY NOT NULL,
  "payment_order_id" text NOT NULL UNIQUE REFERENCES "payment_order"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "provider_trade_no" text NOT NULL,
  "credit_source_ref" text NOT NULL UNIQUE,
  "credits_amount" numeric(18, 2) NOT NULL,
  "credits_expires_at" timestamp,
  "debit_account" text NOT NULL,
  "description" text NOT NULL,
  "metadata" json NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "attempt_count" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamp NOT NULL DEFAULT now(),
  "lease_token" text,
  "lease_expires_at" timestamp,
  "last_error_code" text,
  "credits_batch_id" text,
  "completed_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "payment_fulfillment_work_item_provider_check"
    CHECK ("provider" IN ('alipay_f2f', 'creem', 'epay')),
  CONSTRAINT "payment_fulfillment_work_item_status_check"
    CHECK ("status" IN ('pending', 'processing', 'retry', 'succeeded', 'failed')),
  CONSTRAINT "payment_fulfillment_work_item_attempt_count_check"
    CHECK ("attempt_count" >= 0),
  CONSTRAINT "payment_fulfillment_work_item_lease_shape_check" CHECK (
    ("status" = 'processing' AND "lease_token" IS NOT NULL AND "lease_expires_at" IS NOT NULL)
    OR
    ("status" <> 'processing' AND "lease_token" IS NULL AND "lease_expires_at" IS NULL)
  )
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "payment_fulfillment_work_item_due_idx"
  ON "payment_fulfillment_work_item" ("status", "next_attempt_at", "created_at", "id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "payment_fulfillment_work_item_lease_idx"
  ON "payment_fulfillment_work_item" ("status", "lease_expires_at");
--> statement-breakpoint
