-- 管理端全站数据看板按业务创建时间查询，不具备用户 ID 前缀。
-- 单独索引避免复用本人看板索引时退化为全表扫描；IF NOT EXISTS 保持迁移幂等。
CREATE INDEX IF NOT EXISTS "user_output_usage_event_created_kind_idx"
  ON "user_output_usage_event" USING btree ("operation_created_at", "output_kind");
