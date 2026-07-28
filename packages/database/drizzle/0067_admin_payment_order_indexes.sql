-- 支付概览按 fulfilled_at 自然月聚合；订单管理按 created_at + id 稳定 keyset 浏览。
-- IF NOT EXISTS 允许运维在大表维护窗口预建同名索引后安全汇合应用迁移。
CREATE INDEX IF NOT EXISTS "payment_order_admin_created_id_idx"
  ON "payment_order" ("created_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "payment_order_admin_status_created_id_idx"
  ON "payment_order" ("status", "created_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "payment_order_admin_fulfilled_at_idx"
  ON "payment_order" ("fulfilled_at" DESC)
  WHERE "status" = 'fulfilled'
    AND "purpose" IN ('credit_top_up', 'credit_package')
    AND "fulfilled_at" IS NOT NULL;
