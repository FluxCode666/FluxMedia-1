-- 兼容已应用旧版 0060 的数据库：把 Adobe direct 内部账号池提升为顶层统一成员。
-- 新版 0060 已直接生成最终结构，因此全新安装在确认结构完整后安全跳过。
DO $$
DECLARE
  adobe_account_present boolean;
  adobe_token_present boolean;
  required_column_count bigint;
  active_lease_count bigint;
  active_video_count bigint;
  invalid_direct_credential_count bigint;
  direct_member_id_collision_count bigint;
BEGIN
  adobe_account_present := to_regclass('adobe_account') IS NOT NULL;
  adobe_token_present := to_regclass('adobe_token') IS NOT NULL;

  IF NOT adobe_account_present AND NOT adobe_token_present THEN
    SELECT count(*)
    INTO required_column_count
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'image_backend_member_adobe_config'
      AND column_name IN (
        'cookie',
        'scope',
        'access_token',
        'account_user_id',
        'display_name',
        'email',
        'credential_status',
        'token_expires_at',
        'token_fails',
        'last_refresh_at',
        'last_refresh_error',
        'next_refresh_at',
        'consecutive_failures',
        'credits_total',
        'credits_used',
        'credits_available',
        'credits_updated_at',
        'credits_error'
      );

    IF required_column_count <> 18 THEN
      RAISE EXCEPTION
        '0066 blocked: legacy Adobe tables are absent but direct member columns are incomplete (%/18)',
        required_column_count;
    END IF;
    RETURN;
  END IF;

  IF NOT adobe_account_present OR NOT adobe_token_present THEN
    RAISE EXCEPTION
      '0066 blocked: legacy Adobe subpool is incomplete (adobe_account=%, adobe_token=%)',
      adobe_account_present,
      adobe_token_present;
  END IF;

  SELECT count(*)
  INTO required_column_count
  FROM information_schema.columns
  WHERE table_schema = current_schema()
    AND (
      (table_name = 'adobe_account' AND column_name = 'member_id')
      OR (table_name = 'adobe_token' AND column_name = 'member_id')
      OR (
        table_name = 'video_generation'
        AND column_name = 'adobe_token_id'
      )
    );
  IF required_column_count <> 3 THEN
    RAISE EXCEPTION
      '0066 blocked: legacy unified Adobe schema is incomplete (%/3 markers)',
      required_column_count;
  END IF;

  SELECT count(*)
  INTO active_lease_count
  FROM image_backend_member_lease AS lease
  INNER JOIN image_backend_member_adobe_config AS adobe
    ON adobe.member_id = lease.member_id
    AND adobe.mode = 'direct'
  WHERE lease.expires_at > now();

  SELECT count(*)
  INTO active_video_count
  FROM video_generation AS video
  INNER JOIN image_backend_member_adobe_config AS adobe
    ON adobe.member_id = video.backend_member_id
    AND adobe.mode = 'direct'
  WHERE video.stage NOT IN ('completed', 'failed');

  SELECT count(*)
  INTO invalid_direct_credential_count
  FROM image_backend_member_adobe_config AS adobe
  WHERE (
      adobe.mode = 'gateway'
      AND (
        EXISTS (
          SELECT 1
          FROM adobe_account AS account
          WHERE account.member_id = adobe.member_id
        )
        OR EXISTS (
          SELECT 1
          FROM adobe_token AS token
          WHERE token.member_id = adobe.member_id
        )
      )
    ) OR (
      adobe.mode = 'direct'
      AND (
        NOT EXISTS (
          SELECT 1
          FROM adobe_account AS account
          WHERE account.member_id = adobe.member_id
        )
        OR EXISTS (
          SELECT 1
          FROM adobe_account AS account
          WHERE account.member_id = adobe.member_id
            AND (
              account.status NOT IN ('active', 'error', 'disabled')
              OR char_length(btrim(account.cookie)) NOT BETWEEN 1 AND 64000
              OR (
                account.scope IS NOT NULL
                AND char_length(btrim(account.scope)) NOT BETWEEN 1 AND 4096
              )
              OR account.consecutive_failures < 0
              OR (
                SELECT count(*)
                FROM adobe_token AS token
                WHERE token.member_id = adobe.member_id
                  AND token.account_id = account.id
                  AND token.source = 'auto_refresh'
              ) <> 1
            )
        )
        OR EXISTS (
          SELECT 1
          FROM adobe_token AS token
          LEFT JOIN adobe_account AS account
            ON account.id = token.account_id
            AND account.member_id = adobe.member_id
          WHERE token.member_id = adobe.member_id
            AND (
              token.account_id IS NULL
              OR token.source <> 'auto_refresh'
              OR token.status NOT IN (
                'active',
                'error',
                'exhausted',
                'invalid'
              )
              OR char_length(btrim(token.value)) < 1
              OR token.fails < 0
              OR account.id IS NULL
            )
        )
      )
    );

  WITH ranked_direct_accounts AS (
    SELECT
      account.id,
      row_number() OVER (
        PARTITION BY account.member_id
        ORDER BY account.created_at, account.id
      ) AS ordinal
    FROM adobe_account AS account
    INNER JOIN image_backend_member_adobe_config AS adobe
      ON adobe.member_id = account.member_id
      AND adobe.mode = 'direct'
  )
  SELECT count(*)
  INTO direct_member_id_collision_count
  FROM ranked_direct_accounts AS account
  WHERE account.ordinal > 1
    AND (
      char_length('adobe-direct:' || account.id) > 128
      OR EXISTS (
        SELECT 1
        FROM image_backend_member AS member
        WHERE member.id = 'adobe-direct:' || account.id
      )
    );

  IF active_lease_count <> 0
    OR active_video_count <> 0
    OR invalid_direct_credential_count <> 0
    OR direct_member_id_collision_count <> 0
  THEN
    RAISE EXCEPTION
      '0066 blocked: Adobe subpool cannot be flattened safely (active_lease=%, active_video=%, invalid_direct_credential=%, direct_member_id_collision=%)',
      active_lease_count,
      active_video_count,
      invalid_direct_credential_count,
      direct_member_id_collision_count;
  END IF;

  ALTER TABLE image_backend_member_adobe_config
    ADD COLUMN IF NOT EXISTS cookie text,
    ADD COLUMN IF NOT EXISTS scope text,
    ADD COLUMN IF NOT EXISTS access_token text,
    ADD COLUMN IF NOT EXISTS account_user_id text,
    ADD COLUMN IF NOT EXISTS display_name text,
    ADD COLUMN IF NOT EXISTS email text,
    ADD COLUMN IF NOT EXISTS credential_status text,
    ADD COLUMN IF NOT EXISTS token_expires_at timestamp,
    ADD COLUMN IF NOT EXISTS token_fails integer DEFAULT 0 NOT NULL,
    ADD COLUMN IF NOT EXISTS last_refresh_at timestamp,
    ADD COLUMN IF NOT EXISTS last_refresh_error text,
    ADD COLUMN IF NOT EXISTS next_refresh_at timestamp,
    ADD COLUMN IF NOT EXISTS consecutive_failures integer DEFAULT 0 NOT NULL,
    ADD COLUMN IF NOT EXISTS credits_total integer,
    ADD COLUMN IF NOT EXISTS credits_used integer,
    ADD COLUMN IF NOT EXISTS credits_available integer,
    ADD COLUMN IF NOT EXISTS credits_updated_at timestamp,
    ADD COLUMN IF NOT EXISTS credits_error text;

  -- 第一个账号沿用旧成员 ID；其余账号成为独立顶层成员并继承公共调度配置。
  WITH ranked_direct_accounts AS (
    SELECT
      account.*,
      row_number() OVER (
        PARTITION BY account.member_id
        ORDER BY account.created_at, account.id
      ) AS ordinal
    FROM adobe_account AS account
    INNER JOIN image_backend_member_adobe_config AS adobe
      ON adobe.member_id = account.member_id
      AND adobe.mode = 'direct'
  )
  INSERT INTO image_backend_member (
    id,
    type,
    name,
    supported_model_ids,
    content_safety_enabled,
    is_enabled,
    always_active,
    failure_cooldown_enabled,
    priority,
    concurrency,
    lease_acquired_count,
    success_count,
    fail_count,
    status,
    health_status,
    error_ewma,
    duration_ms_ewma,
    success_streak,
    fail_streak,
    last_observed_at,
    last_used_at,
    last_acquired_at,
    cooldown_until,
    last_error,
    last_error_at,
    metadata,
    created_at,
    updated_at
  )
  SELECT
    'adobe-direct:' || account.id,
    'adobe',
    account.name,
    parent.supported_model_ids,
    parent.content_safety_enabled,
    parent.is_enabled AND account.is_enabled,
    parent.always_active,
    parent.failure_cooldown_enabled,
    parent.priority,
    parent.concurrency,
    0,
    0,
    0,
    CASE
      WHEN parent.status = 'error' OR account.status = 'error' THEN 'error'
      ELSE parent.status
    END,
    CASE
      WHEN parent.status = 'error' OR account.status = 'error'
        THEN 'unhealthy'
      WHEN parent.status = 'limited' THEN 'degraded'
      ELSE 'healthy'
    END,
    0,
    NULL,
    0,
    0,
    coalesce(account.last_refresh_at, parent.last_observed_at),
    token.last_used_at,
    NULL,
    parent.cooldown_until,
    coalesce(account.last_refresh_error, parent.last_error),
    CASE
      WHEN account.last_refresh_error IS NOT NULL THEN account.updated_at
      ELSE parent.last_error_at
    END,
    (
      coalesce(parent.metadata::jsonb, '{}'::jsonb)
      || jsonb_build_object(
        'legacyAdobeDirect',
        jsonb_build_object(
          'parentMemberId', account.member_id,
          'accountId', account.id,
          'promoted', true
        )
      )
    )::json,
    account.created_at,
    greatest(parent.updated_at, account.updated_at, token.updated_at)
  FROM ranked_direct_accounts AS account
  INNER JOIN image_backend_member AS parent
    ON parent.id = account.member_id
  INNER JOIN adobe_token AS token
    ON token.account_id = account.id
    AND token.source = 'auto_refresh'
  WHERE account.ordinal > 1;

  WITH ranked_direct_accounts AS (
    SELECT
      account.*,
      row_number() OVER (
        PARTITION BY account.member_id
        ORDER BY account.created_at, account.id
      ) AS ordinal
    FROM adobe_account AS account
    INNER JOIN image_backend_member_adobe_config AS adobe
      ON adobe.member_id = account.member_id
      AND adobe.mode = 'direct'
  )
  INSERT INTO image_backend_member_adobe_config (
    member_id,
    mode,
    base_url,
    api_key,
    cookie,
    scope,
    access_token,
    account_user_id,
    display_name,
    email,
    credential_status,
    token_expires_at,
    token_fails,
    last_refresh_at,
    last_refresh_error,
    next_refresh_at,
    consecutive_failures,
    credits_total,
    credits_used,
    credits_available,
    credits_updated_at,
    credits_error,
    default_ratio,
    default_resolution,
    gpt_image_quality,
    created_at,
    updated_at
  )
  SELECT
    'adobe-direct:' || account.id,
    'direct',
    NULL,
    NULL,
    account.cookie,
    account.scope,
    token.value,
    coalesce(token.account_user_id, account.account_user_id),
    account.display_name,
    account.email,
    CASE
      WHEN account.status = 'error' THEN 'error'
      ELSE token.status
    END,
    token.expires_at,
    token.fails,
    account.last_refresh_at,
    account.last_refresh_error,
    account.next_refresh_at,
    account.consecutive_failures,
    token.credits_total,
    token.credits_used,
    token.credits_available,
    token.credits_updated_at,
    token.credits_error,
    parent_config.default_ratio,
    parent_config.default_resolution,
    parent_config.gpt_image_quality,
    least(parent_config.created_at, account.created_at, token.created_at),
    greatest(parent_config.updated_at, account.updated_at, token.updated_at)
  FROM ranked_direct_accounts AS account
  INNER JOIN image_backend_member_adobe_config AS parent_config
    ON parent_config.member_id = account.member_id
  INNER JOIN adobe_token AS token
    ON token.account_id = account.id
    AND token.source = 'auto_refresh'
  WHERE account.ordinal > 1;

  WITH ranked_direct_accounts AS (
    SELECT
      account.id,
      account.member_id,
      row_number() OVER (
        PARTITION BY account.member_id
        ORDER BY account.created_at, account.id
      ) AS ordinal
    FROM adobe_account AS account
    INNER JOIN image_backend_member_adobe_config AS adobe
      ON adobe.member_id = account.member_id
      AND adobe.mode = 'direct'
  )
  INSERT INTO image_backend_member_group (id, member_id, group_id, created_at)
  SELECT
    'legacy-adobe-account:' || account.id || ':' || relation.group_id,
    'adobe-direct:' || account.id,
    relation.group_id,
    relation.created_at
  FROM ranked_direct_accounts AS account
  INNER JOIN image_backend_member_group AS relation
    ON relation.member_id = account.member_id
  WHERE account.ordinal > 1;

  -- 历史视频按持久化 token 还原到提升后的账号成员；已完结行不再依赖 token 表。
  WITH ranked_direct_accounts AS (
    SELECT
      account.id,
      account.member_id,
      row_number() OVER (
        PARTITION BY account.member_id
        ORDER BY account.created_at, account.id
      ) AS ordinal
    FROM adobe_account AS account
    INNER JOIN image_backend_member_adobe_config AS adobe
      ON adobe.member_id = account.member_id
      AND adobe.mode = 'direct'
  )
  UPDATE video_generation AS video
  SET backend_member_id = CASE
    WHEN account.ordinal = 1 THEN account.member_id
    ELSE 'adobe-direct:' || account.id
  END
  FROM adobe_token AS token
  INNER JOIN ranked_direct_accounts AS account
    ON account.id = token.account_id
  WHERE video.adobe_token_id = token.id;

  WITH first_direct_account AS (
    SELECT DISTINCT ON (account.member_id)
      account.*
    FROM adobe_account AS account
    INNER JOIN image_backend_member_adobe_config AS adobe
      ON adobe.member_id = account.member_id
      AND adobe.mode = 'direct'
    ORDER BY account.member_id, account.created_at, account.id
  ), first_direct_credential AS (
    SELECT
      account.*,
      token.value AS access_token,
      token.account_user_id AS token_account_user_id,
      token.status AS token_status,
      token.expires_at,
      token.fails,
      token.credits_total,
      token.credits_used,
      token.credits_available,
      token.credits_updated_at,
      token.credits_error,
      token.created_at AS token_created_at,
      token.updated_at AS token_updated_at
    FROM first_direct_account AS account
    INNER JOIN adobe_token AS token
      ON token.account_id = account.id
      AND token.source = 'auto_refresh'
  )
  UPDATE image_backend_member_adobe_config AS adobe
  SET
    cookie = credential.cookie,
    scope = credential.scope,
    access_token = credential.access_token,
    account_user_id = coalesce(
      credential.token_account_user_id,
      credential.account_user_id
    ),
    display_name = credential.display_name,
    email = credential.email,
    credential_status = CASE
      WHEN credential.status = 'error' THEN 'error'
      ELSE credential.token_status
    END,
    token_expires_at = credential.expires_at,
    token_fails = credential.fails,
    last_refresh_at = credential.last_refresh_at,
    last_refresh_error = credential.last_refresh_error,
    next_refresh_at = credential.next_refresh_at,
    consecutive_failures = credential.consecutive_failures,
    credits_total = credential.credits_total,
    credits_used = credential.credits_used,
    credits_available = credential.credits_available,
    credits_updated_at = credential.credits_updated_at,
    credits_error = credential.credits_error,
    created_at = least(
      adobe.created_at,
      credential.created_at,
      credential.token_created_at
    ),
    updated_at = greatest(
      adobe.updated_at,
      credential.updated_at,
      credential.token_updated_at
    )
  FROM first_direct_credential AS credential
  WHERE adobe.member_id = credential.member_id;

  WITH first_direct_account AS (
    SELECT DISTINCT ON (account.member_id)
      account.*
    FROM adobe_account AS account
    INNER JOIN image_backend_member_adobe_config AS adobe
      ON adobe.member_id = account.member_id
      AND adobe.mode = 'direct'
    ORDER BY account.member_id, account.created_at, account.id
  )
  UPDATE image_backend_member AS member
  SET
    name = account.name,
    is_enabled = member.is_enabled AND account.is_enabled,
    status = CASE
      WHEN member.status = 'error' OR account.status = 'error' THEN 'error'
      ELSE member.status
    END,
    health_status = CASE
      WHEN member.status = 'error' OR account.status = 'error'
        THEN 'unhealthy'
      WHEN member.status = 'limited' THEN 'degraded'
      ELSE 'healthy'
    END,
    last_observed_at = coalesce(account.last_refresh_at, member.last_observed_at),
    last_error = coalesce(account.last_refresh_error, member.last_error),
    last_error_at = CASE
      WHEN account.last_refresh_error IS NOT NULL THEN account.updated_at
      ELSE member.last_error_at
    END,
    updated_at = greatest(member.updated_at, account.updated_at)
  FROM first_direct_account AS account
  WHERE member.id = account.member_id;

  ALTER TABLE image_backend_member_adobe_config
    DROP CONSTRAINT IF EXISTS image_backend_member_adobe_config_shape_check,
    DROP CONSTRAINT IF EXISTS image_backend_member_adobe_config_credential_shape_check,
    DROP CONSTRAINT IF EXISTS image_backend_member_adobe_config_credential_status_check,
    DROP CONSTRAINT IF EXISTS image_backend_member_adobe_config_failure_counts_check;

  ALTER TABLE image_backend_member_adobe_config
    ADD CONSTRAINT image_backend_member_adobe_config_shape_check
      CHECK (
        (mode = 'gateway' AND base_url IS NOT NULL)
        OR (
          mode = 'direct'
          AND base_url IS NULL
          AND api_key IS NULL
        )
      ),
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
          AND (
            scope IS NULL
            OR char_length(btrim(scope)) BETWEEN 1 AND 4096
          )
          AND access_token IS NOT NULL
          AND char_length(btrim(access_token)) >= 1
          AND credential_status IS NOT NULL
        )
      ),
    ADD CONSTRAINT image_backend_member_adobe_config_credential_status_check
      CHECK (
        credential_status IS NULL
        OR credential_status IN ('active', 'error', 'exhausted', 'invalid')
      ),
    ADD CONSTRAINT image_backend_member_adobe_config_failure_counts_check
      CHECK (token_fails >= 0 AND consecutive_failures >= 0);

  DROP INDEX IF EXISTS video_generation_adobe_token_idx;
  ALTER TABLE video_generation
    DROP CONSTRAINT IF EXISTS video_generation_adobe_token_id_adobe_token_id_fk,
    DROP COLUMN adobe_token_id;

  DROP TABLE adobe_token;
  DROP TABLE adobe_account;
END $$;
