-- 为外部 API Key 增加可恢复密文。
--
-- 职责：允许新创建的 Key 在登录用户刷新管理页面后再次复制；列只保存应用层
-- AES-256-GCM 密文。历史 Key 只有不可逆哈希，无法回填，保持 NULL 并继续正常鉴权。

ALTER TABLE "external_api_key"
  ADD COLUMN IF NOT EXISTS "encrypted_key" text;
