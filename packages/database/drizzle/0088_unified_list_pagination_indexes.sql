-- 全站数据型列表的稳定排序和精确计数索引。
-- 迁移仅增加可重建索引，不修改业务事实；IF NOT EXISTS 保持重复部署安全。

-- 本人历史与管理员历史都以 created_at/id 为唯一稳定边界；用户前缀同时支撑
-- 当前用户精确计数，status/model 后缀覆盖常用筛选，避免同毫秒记录重复或漏项。
CREATE INDEX IF NOT EXISTS "generation_history_user_created_id_status_model_idx"
  ON "generation" ("user_id", "created_at" DESC, "id" DESC, "status", "model");

CREATE INDEX IF NOT EXISTS "generation_history_admin_created_id_status_model_idx"
  ON "generation" ("created_at" DESC, "id" DESC, "status", "model", "user_id");

CREATE INDEX IF NOT EXISTS "video_generation_history_user_created_id_status_model_idx"
  ON "video_generation" ("user_id", "created_at" DESC, "id" DESC, "status", "model");

CREATE INDEX IF NOT EXISTS "video_generation_history_admin_created_id_status_model_idx"
  ON "video_generation" ("created_at" DESC, "id" DESC, "status", "model", "user_id");

-- 管理充值订单只读取充值用途；partial index 同时覆盖日期、状态、用户与稳定 ID，
-- 避免 count 与 keyset 行查询扫描订阅等无关订单。
CREATE INDEX IF NOT EXISTS "payment_order_admin_recharge_created_id_idx"
  ON "payment_order" ("created_at" DESC, "id" DESC, "status", "user_id")
  WHERE "purpose" IN ('credit_top_up', 'credit_package');

-- 工单列表、消息历史、推广关系和 API Key 均采用精确总数加 offset 页码；唯一 ID
-- 作为第二排序键，保证写入并发下相同时间戳仍有确定顺序。
CREATE INDEX IF NOT EXISTS "ticket_user_created_id_idx"
  ON "ticket" ("user_id", "created_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "ticket_admin_status_created_id_idx"
  ON "ticket" ("status", "created_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "ticket_message_ticket_created_id_idx"
  ON "ticket_message" ("ticket_id", "created_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "referral_relationship_inviter_created_id_idx"
  ON "referral_relationship" ("inviter_user_id", "created_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "external_api_key_user_created_id_idx"
  ON "external_api_key" ("user_id", "created_at" DESC, "id" DESC);

-- 公告的用户与管理排序均先按 pinned；管理筛选还需要 published 前缀。
CREATE INDEX IF NOT EXISTS "announcement_user_pinned_priority_published_created_id_idx"
  ON "announcement" (
    "is_pinned" DESC,
    "priority" DESC,
    "published_at" DESC,
    "created_at" DESC,
    "id" DESC
  );

CREATE INDEX IF NOT EXISTS "announcement_admin_published_pinned_updated_id_idx"
  ON "announcement" (
    "is_published",
    "is_pinned" DESC,
    "updated_at" DESC,
    "id" DESC
  );

-- 号池运行时继续使用完整快照；管理 UI 的独立分页按创建时间和 ID 稳定排序。
CREATE INDEX IF NOT EXISTS "image_backend_group_created_id_idx"
  ON "image_backend_group" ("created_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "image_backend_member_created_id_idx"
  ON "image_backend_member" ("created_at" DESC, "id" DESC);
