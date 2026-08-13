-- 运营总览 epoch 与网页访问事实基础结构。
--
-- WHY：行为统计从显式生产 epoch 开始，不根据迁移时间猜测；网页访问事实使用
-- 数据库唯一约束抵抗同日重放与并发竞争。

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
