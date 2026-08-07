-- 推广关系、推广码与首充双方奖励。
-- 奖励仍写入 credits_transaction/credits_batch；本表只保存归因与履约投影。
ALTER TYPE "credits_batch_source" ADD VALUE IF NOT EXISTS 'referral';
ALTER TYPE "credits_transaction_type" ADD VALUE IF NOT EXISTS 'referral_reward';

CREATE TABLE IF NOT EXISTS "referral_profile" (
  "user_id" text PRIMARY KEY NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "code" text NOT NULL UNIQUE,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "referral_relationship" (
  "id" text PRIMARY KEY NOT NULL,
  "inviter_user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "invitee_user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "referral_code" text NOT NULL,
  "first_payment_order_id" text,
  "status" text NOT NULL DEFAULT 'pending',
  "inviter_reward_credits" numeric(18, 2) NOT NULL DEFAULT 0,
  "invitee_reward_credits" numeric(18, 2) NOT NULL DEFAULT 0,
  "reward_config_snapshot" json NOT NULL,
  "rewarded_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "referral_relationship_users_distinct_check"
    CHECK ("inviter_user_id" <> "invitee_user_id"),
  CONSTRAINT "referral_relationship_status_check"
    CHECK ("status" IN ('pending', 'rewarded', 'skipped')),
  CONSTRAINT "referral_relationship_reward_amounts_nonnegative_check"
    CHECK ("inviter_reward_credits" >= 0 AND "invitee_reward_credits" >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "referral_relationship_invitee_unique"
  ON "referral_relationship" ("invitee_user_id");

CREATE INDEX IF NOT EXISTS "referral_relationship_inviter_created_at_idx"
  ON "referral_relationship" ("inviter_user_id", "created_at");

CREATE INDEX IF NOT EXISTS "referral_relationship_status_created_at_idx"
  ON "referral_relationship" ("status", "created_at");
