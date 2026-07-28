-- 为同一 Adobe 账号保留 Express 与 Firefly 两套独立 IMS Token。
-- 旧 access_token 字段继续代表 Express；Firefly Token 首次使用时按 Cookie 延迟刷新，
-- 绝不复制现有 Express Token，因为 IMS Token 与 client_id 绑定。
ALTER TABLE image_backend_member_adobe_config
  ADD COLUMN IF NOT EXISTS firefly_access_token text,
  ADD COLUMN IF NOT EXISTS firefly_token_expires_at timestamp,
  ADD COLUMN IF NOT EXISTS firefly_credential_status text,
  ADD COLUMN IF NOT EXISTS firefly_token_fails integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS firefly_last_refresh_at timestamp,
  ADD COLUMN IF NOT EXISTS firefly_last_refresh_error text,
  ADD COLUMN IF NOT EXISTS firefly_next_refresh_at timestamp,
  ADD COLUMN IF NOT EXISTS firefly_consecutive_failures integer NOT NULL DEFAULT 0;

ALTER TABLE image_backend_member_adobe_config
  DROP CONSTRAINT IF EXISTS image_backend_member_adobe_config_credential_shape_check,
  DROP CONSTRAINT IF EXISTS image_backend_member_adobe_config_credential_status_check,
  DROP CONSTRAINT IF EXISTS image_backend_member_adobe_config_failure_counts_check,
  DROP CONSTRAINT IF EXISTS image_backend_member_adobe_config_firefly_credential_status_check;

ALTER TABLE image_backend_member_adobe_config
  ADD CONSTRAINT image_backend_member_adobe_config_credential_shape_check
    CHECK (
      (
        mode = 'gateway'
        AND cookie IS NULL
        AND scope IS NULL
        AND access_token IS NULL
        AND account_user_id IS NULL
        AND display_name IS NULL
        AND email IS NULL
        AND credential_status IS NULL
        AND token_expires_at IS NULL
        AND token_fails = 0
        AND last_refresh_at IS NULL
        AND last_refresh_error IS NULL
        AND next_refresh_at IS NULL
        AND consecutive_failures = 0
        AND firefly_access_token IS NULL
        AND firefly_token_expires_at IS NULL
        AND firefly_credential_status IS NULL
        AND firefly_token_fails = 0
        AND firefly_last_refresh_at IS NULL
        AND firefly_last_refresh_error IS NULL
        AND firefly_next_refresh_at IS NULL
        AND firefly_consecutive_failures = 0
        AND credits_total IS NULL
        AND credits_used IS NULL
        AND credits_available IS NULL
        AND credits_updated_at IS NULL
        AND credits_error IS NULL
      )
      OR (
        mode = 'direct'
        AND cookie IS NOT NULL
        AND char_length(btrim(cookie)) BETWEEN 1 AND 64000
        AND (scope IS NULL OR char_length(btrim(scope)) BETWEEN 1 AND 4096)
        AND access_token IS NOT NULL
        AND char_length(btrim(access_token)) >= 1
        AND credential_status IS NOT NULL
        AND (
          firefly_access_token IS NULL
          OR char_length(btrim(firefly_access_token)) >= 1
        )
        AND (
          firefly_access_token IS NULL
          OR firefly_credential_status IS NOT NULL
        )
        AND (
          firefly_credential_status IS NULL
          OR firefly_access_token IS NOT NULL
          OR firefly_credential_status = 'error'
        )
      )
    ),
  ADD CONSTRAINT image_backend_member_adobe_config_credential_status_check
    CHECK (
      credential_status IS NULL
      OR credential_status IN ('active', 'error', 'exhausted', 'invalid')
    ),
  ADD CONSTRAINT image_backend_member_adobe_config_firefly_credential_status_check
    CHECK (
      firefly_credential_status IS NULL
      OR firefly_credential_status IN ('active', 'error', 'exhausted', 'invalid')
    ),
  ADD CONSTRAINT image_backend_member_adobe_config_failure_counts_check
    CHECK (
      token_fails >= 0
      AND consecutive_failures >= 0
      AND firefly_token_fails >= 0
      AND firefly_consecutive_failures >= 0
    );
