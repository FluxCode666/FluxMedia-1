-- 管理员 agent 令牌：供外部 agent 通过专用 API 读取和配置 API 供应商适配器。
-- 明文令牌只在签发时返回一次，数据库仅保存 SHA-256 哈希；令牌必须设置过期时间。

CREATE TABLE IF NOT EXISTS "admin_agent_token" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "token_prefix" text NOT NULL,
  "token_hash" text NOT NULL,
  "last_four" text NOT NULL,
  "can_write" boolean DEFAULT false NOT NULL,
  "created_by_user_id" text NOT NULL,
  "expires_at" timestamp NOT NULL,
  "last_used_at" timestamp,
  "revoked_at" timestamp,
  "revoked_by_user_id" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "admin_agent_token_token_hash_unique" UNIQUE("token_hash"),
  CONSTRAINT "admin_agent_token_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "admin_agent_token_revoked_by_user_id_user_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_agent_token_created_by_user_id_idx" ON "admin_agent_token" USING btree ("created_by_user_id","created_at");
