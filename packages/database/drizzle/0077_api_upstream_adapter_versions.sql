-- API 上游适配版本迁移。
--
-- 职责：把旧 API 账号的一份可变配置收敛为“当前密钥 + 当前版本指针”，并为租约、
-- 图片和视频任务预留成员/版本快照。版本永不保存 API Key，且 member_id_snapshot
-- 不级联引用成员表，以保留终态历史。迁移位于不可逆维护窗口：非终态 API 视频必须
-- 已排空，不能从历史 poll_url 推断其查询协议。

CREATE TABLE IF NOT EXISTS "image_backend_member_api_adapter_version" (
  "id" text PRIMARY KEY,
  "member_id_snapshot" text NOT NULL,
  "revision" integer NOT NULL,
  "credential_scope" text NOT NULL,
  "configuration" json NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "image_backend_member_api_adapter_version_member_revision_unique"
    UNIQUE ("member_id_snapshot", "revision"),
  CONSTRAINT "image_backend_member_api_adapter_version_member_id_unique"
    UNIQUE ("member_id_snapshot", "id"),
  CONSTRAINT "image_backend_member_api_adapter_version_revision_check"
    CHECK ("revision" >= 1),
  CONSTRAINT "image_backend_member_api_adapter_version_credential_scope_check"
    CHECK (char_length(btrim("credential_scope")) > 0),
  CONSTRAINT "image_backend_member_api_adapter_version_configuration_check"
    CHECK (
      json_typeof("configuration") = 'object'
      AND NOT ("configuration"::jsonb ? 'apiKey')
    )
);

CREATE INDEX IF NOT EXISTS
  "image_backend_member_api_adapter_version_member_created_idx"
  ON "image_backend_member_api_adapter_version" (
    "member_id_snapshot",
    "created_at"
  );

ALTER TABLE "image_backend_member_api_config"
  ADD COLUMN IF NOT EXISTS "current_adapter_version_id" text;

ALTER TABLE "image_backend_member_api_config"
  ADD COLUMN IF NOT EXISTS "credential_scope" text;

ALTER TABLE "image_backend_member_lease"
  ADD COLUMN IF NOT EXISTS "api_adapter_member_id" text;

ALTER TABLE "image_backend_member_lease"
  ADD COLUMN IF NOT EXISTS "api_adapter_version_id" text;

ALTER TABLE "generation"
  ADD COLUMN IF NOT EXISTS "api_adapter_member_id" text;

ALTER TABLE "generation"
  ADD COLUMN IF NOT EXISTS "api_adapter_version_id" text;

ALTER TABLE "video_generation"
  ADD COLUMN IF NOT EXISTS "api_adapter_member_id" text;

ALTER TABLE "video_generation"
  ADD COLUMN IF NOT EXISTS "api_adapter_version_id" text;

ALTER TABLE "video_generation"
  ADD COLUMN IF NOT EXISTS "api_adapter_query_failure_count" integer NOT NULL DEFAULT 0;

DO $migration$
DECLARE
  target_schema text := current_schema();
  legacy_config_exists boolean;
  invalid_member_ids text[];
  nonterminal_api_video_count integer;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = target_schema
      AND table_name = 'image_backend_member_api_config'
      AND column_name = 'base_url'
  )
  INTO legacy_config_exists;

  -- 已完成迁移的 schema 不读取已删除的旧列；后续约束语句会验证其完整性。
  IF NOT legacy_config_exists THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = target_schema
      AND table_name = 'image_backend_member_api_config'
      AND column_name IN (
        'api_key',
        'base_url',
        'use_stream',
        'model_mappings',
        'request_transform_script'
      )
    GROUP BY table_schema, table_name
    HAVING count(*) = 5
  ) THEN
    RAISE EXCEPTION
      '0077 blocked: API adapter configuration has a partial legacy shape';
  END IF;

  -- 当前实现只能从完整、可验证的 API 成员配置创建 revision 1。错误只包含成员 ID，
  -- 绝不回显 URL、模型映射、脚本或密钥正文。
  SELECT array_agg(member_id ORDER BY member_id)
  INTO invalid_member_ids
  FROM (
    SELECT config.member_id
    FROM image_backend_member_api_config AS config
    LEFT JOIN image_backend_member AS member
      ON member.id = config.member_id
    WHERE member.id IS NULL
      OR member.type <> 'api'
      OR btrim(config.base_url) !~* '^https?://[^[:space:]/?#]+([/:?#]|$)'
      OR config.base_url ~ '[[:space:]]'
      OR json_typeof(config.model_mappings) <> 'array'
      OR char_length(config.request_transform_script) > 32768
      OR (
        btrim(config.request_transform_script) <> ''
        AND char_length(
          'const legacyBody = ((request) => {' || E'\n' ||
          config.request_transform_script || E'\n})(request.body);\n' ||
          'return { body: legacyBody };'
        ) > 32768
      )
      OR CASE
        WHEN json_typeof(config.model_mappings) <> 'array' THEN false
        ELSE EXISTS (
          SELECT 1
          FROM json_array_elements(config.model_mappings) AS mapping(value)
          WHERE json_typeof(mapping.value) <> 'object'
            OR btrim(coalesce(mapping.value->>'modelId', '')) = ''
            OR btrim(coalesce(mapping.value->>'upstreamModelId', '')) = ''
            OR char_length(btrim(mapping.value->>'modelId')) > 120
            OR char_length(btrim(mapping.value->>'upstreamModelId')) > 240
            OR (mapping.value::jsonb - 'modelId' - 'upstreamModelId') <> '{}'::jsonb
        )
      END
      OR CASE
        WHEN json_typeof(config.model_mappings) <> 'array' THEN false
        ELSE EXISTS (
          SELECT 1
          FROM json_array_elements(config.model_mappings) AS mapping(value)
          GROUP BY lower(btrim(mapping.value->>'modelId'))
          HAVING count(*) > 1
        )
      END
  ) AS invalid_config;

  IF invalid_member_ids IS NOT NULL THEN
    RAISE EXCEPTION
      '0077 blocked: invalid API adapter config for member(s) %',
      array_to_string(invalid_member_ids, ', ');
  END IF;

  SELECT array_agg(member.id ORDER BY member.id)
  INTO invalid_member_ids
  FROM image_backend_member AS member
  LEFT JOIN image_backend_member_api_config AS config
    ON config.member_id = member.id
  WHERE member.type = 'api'
    AND config.member_id IS NULL;

  IF invalid_member_ids IS NOT NULL THEN
    RAISE EXCEPTION
      '0077 blocked: API member(s) lack adapter config: %',
      array_to_string(invalid_member_ids, ', ');
  END IF;

  -- 已接受或提交中的 API 视频不能可靠地从 poll_url 逆向构造版本化查询路径；
  -- 即使 URL 同源、默认路径或任务处于 submit_uncertain，也必须在维护窗口前排空。
  SELECT count(*)::integer
  INTO nonterminal_api_video_count
  FROM video_generation AS video
  INNER JOIN image_backend_member AS member
    ON member.id = video.backend_member_id
  WHERE member.type = 'api'
    AND video.stage NOT IN ('completed', 'failed');

  IF nonterminal_api_video_count > 0 THEN
    RAISE EXCEPTION
      '0077 blocked: % nonterminal API video task(s) must be drained before upgrade',
      nonterminal_api_video_count;
  END IF;

  WITH legacy_config AS (
    SELECT
      config.member_id,
      config.base_url,
      config.use_stream,
      config.model_mappings,
      config.request_transform_script,
      CASE
        WHEN nullif(btrim(config.api_key), '') IS NULL THEN 'none'
        ELSE 'bearer'
      END AS authentication_mode,
      lower(
        regexp_replace(
          regexp_replace(
            btrim(config.base_url),
            '^(https?://[^/?#]+).*$',
            E'\\1',
            'i'
          ),
          '/+$',
          ''
        )
      ) || '|' || CASE
        WHEN nullif(btrim(config.api_key), '') IS NULL THEN 'none'
        ELSE 'bearer'
      END AS credential_scope
    FROM image_backend_member_api_config AS config
  ), prepared_config AS (
    SELECT
      legacy_config.*,
      CASE
        WHEN btrim(request_transform_script) = '' THEN ''
        ELSE
          'const legacyBody = ((request) => {' || E'\n' ||
          request_transform_script || E'\n})(request.body);\n' ||
          'return { body: legacyBody };'
      END AS wrapped_request_script
    FROM legacy_config
  )
  INSERT INTO image_backend_member_api_adapter_version (
    id,
    member_id_snapshot,
    revision,
    credential_scope,
    configuration,
    created_at
  )
  SELECT
    'legacy-api-adapter-v1:' || member_id,
    member_id,
    1,
    credential_scope,
    json_build_object(
      'baseUrl', base_url,
      'useStream', use_stream,
      'modelMappings', model_mappings,
      'authentication', json_build_object('mode', authentication_mode),
      'credentialScope', credential_scope,
      'operations', json_build_object(
        'images.generate', json_build_object(
          'path', '',
          'requestScript', wrapped_request_script,
          'responseScript', ''
        ),
        'images.generate.query', json_build_object(
          'path', '',
          'requestScript', '',
          'responseScript', ''
        ),
        'images.edit', json_build_object(
          'path', '',
          'requestScript', wrapped_request_script,
          'responseScript', ''
        ),
        'images.edit.query', json_build_object(
          'path', '',
          'requestScript', '',
          'responseScript', ''
        ),
        'videos.generate', json_build_object(
          'path', '',
          'requestScript', wrapped_request_script,
          'responseScript', ''
        ),
        'videos.query', json_build_object(
          'path', '',
          'requestScript', '',
          'responseScript', ''
        )
      )
    ),
    now()
  FROM prepared_config
  ON CONFLICT (member_id_snapshot, revision) DO NOTHING;

  UPDATE image_backend_member_api_config AS config
  SET
    api_key = nullif(btrim(config.api_key), ''),
    current_adapter_version_id = 'legacy-api-adapter-v1:' || config.member_id,
    credential_scope = version.credential_scope
  FROM image_backend_member_api_adapter_version AS version
  WHERE version.member_id_snapshot = config.member_id
    AND version.revision = 1;

  UPDATE image_backend_member_lease AS lease
  SET
    api_adapter_member_id = lease.member_id,
    api_adapter_version_id = config.current_adapter_version_id
  FROM image_backend_member AS member
  INNER JOIN image_backend_member_api_config AS config
    ON config.member_id = member.id
  WHERE member.id = lease.member_id
    AND member.type = 'api'
    AND lease.api_adapter_member_id IS NULL
    AND lease.api_adapter_version_id IS NULL;
END
$migration$;

ALTER TABLE "image_backend_member_api_config"
  ALTER COLUMN "current_adapter_version_id" SET NOT NULL;

ALTER TABLE "image_backend_member_api_config"
  ALTER COLUMN "credential_scope" SET NOT NULL;

ALTER TABLE "image_backend_member_api_config"
  DROP CONSTRAINT IF EXISTS "image_backend_member_api_config_model_mappings_check";

ALTER TABLE "image_backend_member_api_config"
  DROP COLUMN IF EXISTS "base_url";

ALTER TABLE "image_backend_member_api_config"
  DROP COLUMN IF EXISTS "use_stream";

ALTER TABLE "image_backend_member_api_config"
  DROP COLUMN IF EXISTS "model_mappings";

ALTER TABLE "image_backend_member_api_config"
  DROP COLUMN IF EXISTS "request_transform_script";

DO $constraints$
DECLARE
  target_schema text := current_schema();
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint AS constraint_record
    INNER JOIN pg_class AS relation
      ON relation.oid = constraint_record.conrelid
    INNER JOIN pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = target_schema
      AND relation.relname = 'image_backend_member_api_config'
      AND constraint_record.conname =
        'image_backend_member_api_config_credential_scope_check'
  ) THEN
    ALTER TABLE image_backend_member_api_config
      ADD CONSTRAINT image_backend_member_api_config_credential_scope_check
      CHECK (char_length(btrim(credential_scope)) > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint AS constraint_record
    INNER JOIN pg_class AS relation
      ON relation.oid = constraint_record.conrelid
    INNER JOIN pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = target_schema
      AND relation.relname = 'image_backend_member_api_config'
      AND constraint_record.conname =
        'image_backend_member_api_config_current_adapter_version_fk'
  ) THEN
    ALTER TABLE image_backend_member_api_config
      ADD CONSTRAINT image_backend_member_api_config_current_adapter_version_fk
      FOREIGN KEY (member_id, current_adapter_version_id)
      REFERENCES image_backend_member_api_adapter_version
        (member_id_snapshot, id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint AS constraint_record
    INNER JOIN pg_class AS relation
      ON relation.oid = constraint_record.conrelid
    INNER JOIN pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = target_schema
      AND relation.relname = 'image_backend_member_lease'
      AND constraint_record.conname =
        'image_backend_member_lease_api_adapter_pair_check'
  ) THEN
    ALTER TABLE image_backend_member_lease
      ADD CONSTRAINT image_backend_member_lease_api_adapter_pair_check
      CHECK (
        (api_adapter_member_id IS NULL) =
        (api_adapter_version_id IS NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint AS constraint_record
    INNER JOIN pg_class AS relation
      ON relation.oid = constraint_record.conrelid
    INNER JOIN pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = target_schema
      AND relation.relname = 'image_backend_member_lease'
      AND constraint_record.conname =
        'image_backend_member_lease_api_adapter_version_fk'
  ) THEN
    ALTER TABLE image_backend_member_lease
      ADD CONSTRAINT image_backend_member_lease_api_adapter_version_fk
      FOREIGN KEY (api_adapter_member_id, api_adapter_version_id)
      REFERENCES image_backend_member_api_adapter_version
        (member_id_snapshot, id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint AS constraint_record
    INNER JOIN pg_class AS relation
      ON relation.oid = constraint_record.conrelid
    INNER JOIN pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = target_schema
      AND relation.relname = 'generation'
      AND constraint_record.conname = 'generation_api_adapter_pair_check'
  ) THEN
    ALTER TABLE generation
      ADD CONSTRAINT generation_api_adapter_pair_check
      CHECK (
        (api_adapter_member_id IS NULL) =
        (api_adapter_version_id IS NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint AS constraint_record
    INNER JOIN pg_class AS relation
      ON relation.oid = constraint_record.conrelid
    INNER JOIN pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = target_schema
      AND relation.relname = 'generation'
      AND constraint_record.conname = 'generation_api_adapter_version_fk'
  ) THEN
    ALTER TABLE generation
      ADD CONSTRAINT generation_api_adapter_version_fk
      FOREIGN KEY (api_adapter_member_id, api_adapter_version_id)
      REFERENCES image_backend_member_api_adapter_version
        (member_id_snapshot, id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint AS constraint_record
    INNER JOIN pg_class AS relation
      ON relation.oid = constraint_record.conrelid
    INNER JOIN pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = target_schema
      AND relation.relname = 'video_generation'
      AND constraint_record.conname =
        'video_generation_api_adapter_pair_check'
  ) THEN
    ALTER TABLE video_generation
      ADD CONSTRAINT video_generation_api_adapter_pair_check
      CHECK (
        (api_adapter_member_id IS NULL) =
        (api_adapter_version_id IS NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint AS constraint_record
    INNER JOIN pg_class AS relation
      ON relation.oid = constraint_record.conrelid
    INNER JOIN pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = target_schema
      AND relation.relname = 'video_generation'
      AND constraint_record.conname =
        'video_generation_api_adapter_version_fk'
  ) THEN
    ALTER TABLE video_generation
      ADD CONSTRAINT video_generation_api_adapter_version_fk
      FOREIGN KEY (api_adapter_member_id, api_adapter_version_id)
      REFERENCES image_backend_member_api_adapter_version
        (member_id_snapshot, id)
      ON DELETE RESTRICT;
  END IF;
END
$constraints$;
