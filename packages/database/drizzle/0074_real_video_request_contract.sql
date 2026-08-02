-- 视频真实模型请求契约的一次性阻断迁移。
--
-- 使用方：停机窗口中的 Drizzle migrator。该文件在一个 DO 事务语句内冻结 0073 后
-- 573 个规范复合 ID、6 个 Kling 历史别名和 13 个真实 ID；先证明成员、任务与输入
-- 均可唯一转换，再同时更新数据、删除旧列并收紧约束。任何异常都会回滚全部变化。
DO $migration$
DECLARE
  target_schema text := current_schema();
  legacy_column_count integer;
  canonical_mapping_count integer;
  alias_mapping_count integer;
  real_model_count integer;
  invalid_member_ids text[];
  invalid_video_member_ids text[];
  invalid_task_details text[];
  invalid_input_ids text[];
  required_constraint_count integer;
  required_function_count integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = target_schema
      AND table_name = 'image_backend_member'
  ) OR NOT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = target_schema
      AND table_name = 'image_backend_member_adobe_config'
  ) OR NOT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = target_schema
      AND table_name = 'video_generation'
  ) THEN
    RAISE EXCEPTION
      '0074 blocked: required post-0073 media tables are missing';
  END IF;

  SELECT count(*)::integer
  INTO legacy_column_count
  FROM information_schema.columns
  WHERE table_schema = target_schema
    AND table_name = 'video_generation'
    AND column_name IN (
      'family',
      'input_image_refs',
      'staged_input_objects'
    );

  -- 已切换的 schema 只验证迁移标记，不触碰数据或更新时间，保证人工复跑幂等。
  IF legacy_column_count = 0 THEN
    SELECT count(*)::integer
    INTO required_constraint_count
    FROM pg_constraint AS constraint_record
    INNER JOIN pg_class AS relation
      ON relation.oid = constraint_record.conrelid
    INNER JOIN pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = target_schema
      AND constraint_record.contype = 'c'
      AND constraint_record.convalidated
      AND (
        (
          relation.relname = 'image_backend_member'
          AND constraint_record.conname =
            'image_backend_member_supported_models_check'
          AND pg_get_constraintdef(constraint_record.oid, true) =
            'CHECK (media_supported_model_ids_are_valid(supported_model_ids))'
        )
        OR (
          relation.relname = 'video_generation'
          AND (
            (
              constraint_record.conname =
                'video_generation_input_manifest_check'
              AND pg_get_constraintdef(constraint_record.oid, true) =
                'CHECK (input_manifest IS NULL OR video_input_manifest_is_valid(input_manifest, user_id, id, model))'
            )
            OR (
              constraint_record.conname = 'video_generation_real_model_check'
              AND pg_get_constraintdef(constraint_record.oid, true) =
                'CHECK (model = ANY (ARRAY[''sora2''::text, ''sora2-pro''::text, ''veo31''::text, ''veo31-fast''::text, ''veo31-ref''::text, ''kling-o3''::text, ''kling3''::text, ''kling3-omni''::text, ''runway-gen45''::text, ''ray314''::text, ''ray314-hdr''::text, ''seedance2''::text, ''seedance2-fast''::text]))'
            )
          )
        )
      );
    SELECT count(*)::integer
    INTO required_function_count
    FROM pg_proc AS procedure_record
    INNER JOIN pg_namespace AS namespace
      ON namespace.oid = procedure_record.pronamespace
    WHERE namespace.nspname = target_schema
      AND procedure_record.prorettype = 'boolean'::regtype
      AND procedure_record.provolatile = 'i'
      AND procedure_record.proisstrict
      AND NOT procedure_record.prosecdef
      AND procedure_record.proconfig = ARRAY['search_path=pg_catalog']::text[]
      AND (
        (
          procedure_record.proname = 'media_supported_model_ids_are_valid'
          AND procedure_record.pronargs = 1
          AND procedure_record.proargtypes[0] = 'json'::regtype
        )
        OR (
          procedure_record.proname = 'video_input_manifest_is_valid'
          AND procedure_record.pronargs = 4
          AND procedure_record.proargtypes[0] = 'json'::regtype
          AND procedure_record.proargtypes[1] = 'text'::regtype
          AND procedure_record.proargtypes[2] = 'text'::regtype
          AND procedure_record.proargtypes[3] = 'text'::regtype
        )
      );
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = target_schema
        AND table_name = 'video_generation'
        AND column_name = 'input_manifest'
    ) OR required_constraint_count <> 3
      OR required_function_count <> 2
    THEN
      RAISE EXCEPTION
        '0074 blocked: partially migrated real video request schema';
    END IF;
    IF NOT media_supported_model_ids_are_valid(
        '["seedance2","image-model"]'::json
      )
      OR media_supported_model_ids_are_valid(
        '["seedance2-4s-16x9-1080p"]'::json
      )
      OR media_supported_model_ids_are_valid('["image","IMAGE"]'::json)
      OR NOT video_input_manifest_is_valid(
        '{"firstFrame":{"source":"storage","mimeType":"image/png","storageKey":"u/video-inputs/t/a/f.png","storageBucket":"b","byteLength":1}}'::json,
        'u',
        't',
        'seedance2'
      )
      OR video_input_manifest_is_valid(
        '{"firstFrame":{"source":"storage","mimeType":"image/png","storageKey":"u/video-inputs/t/a/f.png","storageBucket":"b","byteLength":1},"referenceImages":[{"source":"storage","mimeType":"image/png","storageKey":"u/video-inputs/t/a/r.png","storageBucket":"b","byteLength":1}]}'::json,
        'u',
        't',
        'seedance2'
      )
    THEN
      RAISE EXCEPTION
        '0074 blocked: real video request validators have drifted';
    END IF;
    RETURN;
  END IF;

  IF legacy_column_count <> 3 THEN
    RAISE EXCEPTION
      '0074 blocked: partial legacy video columns remain (%)',
      legacy_column_count;
  END IF;

  CREATE TEMP TABLE _0074_video_model_mapping (
    legacy_model text PRIMARY KEY,
    real_model text NOT NULL,
    duration_seconds integer NOT NULL,
    aspect_ratio text NOT NULL,
    resolution text NOT NULL,
    is_alias boolean NOT NULL
  ) ON COMMIT DROP;

  -- WHY：迁移不能读取会继续演进的运行时目录。下列数组是 0073 发布后目录的冻结副本。
  INSERT INTO _0074_video_model_mapping (
    legacy_model,
    real_model,
    duration_seconds,
    aspect_ratio,
    resolution,
    is_alias
  )
  WITH frozen_families AS (
    SELECT *
    FROM (VALUES
      (
        'sora2',
        ARRAY[4, 8, 12]::integer[],
        ARRAY['9:16', '16:9']::text[],
        ARRAY['720p']::text[],
        false
      ),
      (
        'sora2-pro',
        ARRAY[4, 8, 12]::integer[],
        ARRAY['9:16', '16:9']::text[],
        ARRAY['720p']::text[],
        false
      ),
      (
        'veo31',
        ARRAY[4, 6, 8]::integer[],
        ARRAY['16:9', '9:16']::text[],
        ARRAY['1080p', '720p']::text[],
        true
      ),
      (
        'veo31-fast',
        ARRAY[4, 6, 8]::integer[],
        ARRAY['16:9', '9:16']::text[],
        ARRAY['1080p', '720p']::text[],
        true
      ),
      (
        'veo31-ref',
        ARRAY[4, 6, 8]::integer[],
        ARRAY['16:9', '9:16']::text[],
        ARRAY['1080p', '720p']::text[],
        true
      ),
      (
        'kling-o3',
        ARRAY[5, 15]::integer[],
        ARRAY['16:9', '9:16']::text[],
        ARRAY['1080p']::text[],
        false
      ),
      (
        'kling3',
        ARRAY[3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]::integer[],
        ARRAY['16:9', '9:16']::text[],
        ARRAY['1080p', '720p']::text[],
        true
      ),
      (
        'kling3-omni',
        ARRAY[3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]::integer[],
        ARRAY['16:9', '9:16']::text[],
        ARRAY['1080p', '720p']::text[],
        true
      ),
      (
        'runway-gen45',
        ARRAY[5, 8, 10]::integer[],
        ARRAY['16:9']::text[],
        ARRAY['720p']::text[],
        false
      ),
      (
        'ray314',
        ARRAY[5, 10]::integer[],
        ARRAY['1:1', '4:3', '3:4', '16:9', '9:16', '21:9']::text[],
        ARRAY['4k', '1080p', '720p']::text[],
        true
      ),
      (
        'ray314-hdr',
        ARRAY[5]::integer[],
        ARRAY['1:1', '4:3', '3:4', '16:9', '9:16', '21:9']::text[],
        ARRAY['4k', '1080p', '720p']::text[],
        true
      ),
      (
        'seedance2',
        ARRAY[4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]::integer[],
        ARRAY['1:1', '4:3', '3:4', '16:9', '9:16', '21:9']::text[],
        ARRAY['1080p', '720p', '480p']::text[],
        true
      ),
      (
        'seedance2-fast',
        ARRAY[4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]::integer[],
        ARRAY['1:1', '4:3', '3:4', '16:9', '9:16', '21:9']::text[],
        ARRAY['720p', '480p']::text[],
        true
      )
    ) AS family(
      real_model,
      durations,
      aspect_ratios,
      resolutions,
      resolution_in_id
    )
  )
  SELECT
    format(
      '%s-%ss-%s%s',
      family.real_model,
      duration.value,
      replace(aspect_ratio.value, ':', 'x'),
      CASE
        WHEN family.resolution_in_id THEN '-' || resolution.value
        ELSE ''
      END
    ),
    family.real_model,
    duration.value,
    aspect_ratio.value,
    resolution.value,
    false
  FROM frozen_families AS family
  CROSS JOIN LATERAL unnest(family.durations) AS duration(value)
  CROSS JOIN LATERAL unnest(family.aspect_ratios) AS aspect_ratio(value)
  CROSS JOIN LATERAL unnest(family.resolutions) AS resolution(value);

  -- Kling 3.0 在 0072 前曾持久化不含分辨率的 5/10/15 秒 ID；它们唯一对应 720p。
  INSERT INTO _0074_video_model_mapping (
    legacy_model,
    real_model,
    duration_seconds,
    aspect_ratio,
    resolution,
    is_alias
  )
  SELECT
    format(
      'kling3-%ss-%s',
      duration.value,
      replace(aspect_ratio.value, ':', 'x')
    ),
    'kling3',
    duration.value,
    aspect_ratio.value,
    '720p',
    true
  FROM unnest(ARRAY[5, 10, 15]::integer[]) AS duration(value)
  CROSS JOIN unnest(ARRAY['16:9', '9:16']::text[]) AS aspect_ratio(value);

  SELECT count(*) FILTER (WHERE NOT is_alias)::integer,
         count(*) FILTER (WHERE is_alias)::integer,
         count(DISTINCT real_model)::integer
  INTO canonical_mapping_count, alias_mapping_count, real_model_count
  FROM _0074_video_model_mapping;
  IF canonical_mapping_count <> 573
    OR alias_mapping_count <> 6
    OR real_model_count <> 13
  THEN
    RAISE EXCEPTION
      '0074 blocked: frozen video mapping is incomplete (canonical=%, alias=%, real=%)',
      canonical_mapping_count,
      alias_mapping_count,
      real_model_count;
  END IF;

  -- JSON 基础形状必须先可靠，再调用元素展开函数，避免脏 JSON 触发非定位性异常。
  WITH invalid AS (
    SELECT member.id
    FROM image_backend_member AS member
    LEFT JOIN LATERAL json_array_elements(
      CASE
        WHEN json_typeof(member.supported_model_ids) = 'array'
          THEN member.supported_model_ids
        ELSE '[]'::json
      END
    ) AS model(value) ON true
    WHERE json_typeof(member.supported_model_ids) <> 'array'
      OR json_array_length(
        CASE
          WHEN json_typeof(member.supported_model_ids) = 'array'
            THEN member.supported_model_ids
          ELSE '[]'::json
        END
      ) NOT BETWEEN 1 AND 1000
      OR (
        model.value IS NOT NULL
        AND (
          json_typeof(model.value) <> 'string'
          OR char_length(btrim(model.value #>> '{}')) NOT BETWEEN 1 AND 120
        )
      )
    GROUP BY member.id
    ORDER BY member.id
    LIMIT 20
  )
  SELECT array_agg(id ORDER BY id)
  INTO invalid_member_ids
  FROM invalid;
  IF invalid_member_ids IS NOT NULL THEN
    RAISE EXCEPTION
      '0074 blocked: invalid member model arrays (%)',
      array_to_string(invalid_member_ids, ',');
  END IF;

  -- 只把冻结映射或真实 ID 视为视频；同家族的目录外变体和残留 firefly 前缀一律阻断。
  WITH expanded AS (
    SELECT
      member.id,
      member.type,
      lower(btrim(model.value #>> '{}')) AS normalized_model,
      adobe.mode AS adobe_mode
    FROM image_backend_member AS member
    LEFT JOIN image_backend_member_adobe_config AS adobe
      ON adobe.member_id = member.id
    CROSS JOIN LATERAL json_array_elements(
      member.supported_model_ids
    ) AS model(value)
  ), classified AS (
    SELECT
      expanded.*,
      mapping.real_model AS mapped_real_model,
      expanded.normalized_model = ANY (
        ARRAY[
          'sora2', 'sora2-pro', 'veo31', 'veo31-fast', 'veo31-ref',
          'kling-o3', 'kling3', 'kling3-omni', 'runway-gen45',
          'ray314', 'ray314-hdr', 'seedance2', 'seedance2-fast'
        ]::text[]
      ) AS is_real_video,
      expanded.normalized_model LIKE 'firefly-%'
        OR EXISTS (
          SELECT 1
          FROM unnest(ARRAY[
            'sora2', 'sora2-pro', 'veo31', 'veo31-fast', 'veo31-ref',
            'kling-o3', 'kling3', 'kling3-omni', 'runway-gen45',
            'ray314', 'ray314-hdr', 'seedance2', 'seedance2-fast'
          ]::text[]) AS real_model(value)
          WHERE expanded.normalized_model LIKE real_model.value || '-%'
        ) AS looks_like_video
    FROM expanded
    LEFT JOIN _0074_video_model_mapping AS mapping
      ON mapping.legacy_model = expanded.normalized_model
  ), invalid AS (
    SELECT DISTINCT id
    FROM classified
    WHERE (
        looks_like_video
        AND mapped_real_model IS NULL
        AND NOT is_real_video
      )
      OR (
        (mapped_real_model IS NOT NULL OR is_real_video)
        AND (type <> 'adobe' OR adobe_mode IS DISTINCT FROM 'direct')
      )
    ORDER BY id
    LIMIT 20
  )
  SELECT array_agg(id ORDER BY id)
  INTO invalid_video_member_ids
  FROM invalid;
  IF invalid_video_member_ids IS NOT NULL THEN
    RAISE EXCEPTION
      '0074 blocked: unknown or unauthorized video member models (%)',
      array_to_string(invalid_video_member_ids, ',');
  END IF;

  CREATE TEMP TABLE _0074_video_task_projection (
    video_id text PRIMARY KEY,
    real_model text,
    failure_reason text
  ) ON COMMIT DROP;
  INSERT INTO _0074_video_task_projection (
    video_id,
    real_model,
    failure_reason
  )
  WITH normalized AS (
    SELECT
      video.*,
      lower(btrim(video.model)) AS normalized_model,
      lower(btrim(video.family)) AS normalized_family,
      btrim(video.aspect_ratio) AS normalized_aspect_ratio,
      lower(btrim(video.resolution)) AS normalized_resolution
    FROM video_generation AS video
  ), resolved AS (
    SELECT
      normalized.*,
      mapping.real_model AS mapped_real_model,
      mapping.duration_seconds AS mapped_duration,
      mapping.aspect_ratio AS mapped_aspect_ratio,
      mapping.resolution AS mapped_resolution,
      CASE
        WHEN normalized.normalized_model = ANY (
          ARRAY[
            'sora2', 'sora2-pro', 'veo31', 'veo31-fast', 'veo31-ref',
            'kling-o3', 'kling3', 'kling3-omni', 'runway-gen45',
            'ray314', 'ray314-hdr', 'seedance2', 'seedance2-fast'
          ]::text[]
        ) THEN normalized.normalized_model
        ELSE NULL
      END AS existing_real_model
    FROM normalized
    LEFT JOIN _0074_video_model_mapping AS mapping
      ON mapping.legacy_model = normalized.normalized_model
  )
  SELECT
    resolved.id,
    coalesce(resolved.mapped_real_model, resolved.existing_real_model),
    CASE
      WHEN resolved.mapped_real_model IS NULL
        AND resolved.existing_real_model IS NULL
        THEN 'unknown_model'
      WHEN resolved.normalized_family IS DISTINCT FROM coalesce(
        resolved.mapped_real_model,
        resolved.existing_real_model
      ) THEN 'family_conflict'
      WHEN resolved.mapped_real_model IS NOT NULL
        AND (
          resolved.duration_seconds IS DISTINCT FROM resolved.mapped_duration
          OR resolved.normalized_aspect_ratio IS DISTINCT FROM
            resolved.mapped_aspect_ratio
          OR resolved.normalized_resolution IS DISTINCT FROM
            resolved.mapped_resolution
        ) THEN 'parameter_conflict'
      WHEN resolved.existing_real_model IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM _0074_video_model_mapping AS allowed
          WHERE allowed.real_model = resolved.existing_real_model
            AND allowed.duration_seconds = resolved.duration_seconds
            AND allowed.aspect_ratio = resolved.normalized_aspect_ratio
            AND allowed.resolution = resolved.normalized_resolution
        ) THEN 'parameter_conflict'
      WHEN resolved.adobe_request_profile NOT IN ('express', 'firefly')
        OR resolved.adobe_auth_profile NOT IN ('express', 'firefly')
        OR CASE resolved.stage
          WHEN 'created' THEN resolved.status <> 'pending'
          WHEN 'charged' THEN resolved.status <> 'running'
            OR btrim(coalesce(resolved.backend_member_id, '')) = ''
            OR btrim(coalesce(resolved.member_lease_id, '')) = ''
            OR btrim(coalesce(resolved.member_lease_owner_token, '')) = ''
          WHEN 'submitting' THEN resolved.status <> 'running'
            OR btrim(coalesce(resolved.backend_member_id, '')) = ''
            OR btrim(coalesce(resolved.member_lease_id, '')) = ''
            OR btrim(coalesce(resolved.member_lease_owner_token, '')) = ''
            OR resolved.submit_started_at IS NULL
          WHEN 'submit_uncertain' THEN resolved.status <> 'running'
            OR btrim(coalesce(resolved.backend_member_id, '')) = ''
          WHEN 'polling' THEN resolved.status <> 'running'
            OR btrim(coalesce(resolved.backend_member_id, '')) = ''
            OR btrim(coalesce(resolved.member_lease_id, '')) = ''
            OR btrim(coalesce(resolved.member_lease_owner_token, '')) = ''
            OR btrim(coalesce(resolved.poll_url, '')) = ''
            OR resolved.upstream_accepted_at IS NULL
          WHEN 'downloading' THEN resolved.status <> 'running'
            OR btrim(coalesce(resolved.backend_member_id, '')) = ''
            OR btrim(coalesce(resolved.member_lease_id, '')) = ''
            OR btrim(coalesce(resolved.member_lease_owner_token, '')) = ''
            OR btrim(coalesce(resolved.video_url, '')) = ''
            OR btrim(coalesce(resolved.storage_key, '')) = ''
          WHEN 'refunding' THEN resolved.status <> 'running'
          WHEN 'completed' THEN resolved.status <> 'completed'
          WHEN 'failed' THEN resolved.status <> 'failed'
          ELSE true
        END THEN 'recovery_identity'
      ELSE NULL
    END
  FROM resolved;

  WITH invalid AS (
    SELECT video_id, failure_reason
    FROM _0074_video_task_projection
    WHERE failure_reason IS NOT NULL
    ORDER BY video_id
    LIMIT 20
  )
  SELECT array_agg(
    format('%s:%s', video_id, failure_reason)
    ORDER BY video_id
  )
  INTO invalid_task_details
  FROM invalid;
  IF invalid_task_details IS NOT NULL THEN
    RAISE EXCEPTION
      '0074 blocked: video tasks cannot be uniquely mapped (%)',
      array_to_string(invalid_task_details, ',');
  END IF;

  ALTER TABLE video_generation
    ADD COLUMN IF NOT EXISTS input_manifest json;

  -- 约束函数不访问表和运行时目录；它只验证冻结的真实 ID 边界与清单物理形状。
  EXECUTE $function_ddl$
    CREATE OR REPLACE FUNCTION media_supported_model_ids_are_valid(
      model_ids json
    ) RETURNS boolean
    LANGUAGE plpgsql
    IMMUTABLE
    STRICT
    SET search_path = pg_catalog
    AS $function_body$
    DECLARE
      model_value json;
      model_id text;
      normalized_model text;
      seen_models text[] := ARRAY[]::text[];
      real_models constant text[] := ARRAY[
        'sora2', 'sora2-pro', 'veo31', 'veo31-fast', 'veo31-ref',
        'kling-o3', 'kling3', 'kling3-omni', 'runway-gen45',
        'ray314', 'ray314-hdr', 'seedance2', 'seedance2-fast'
      ]::text[];
      real_model text;
    BEGIN
      IF json_typeof(model_ids) <> 'array'
        OR json_array_length(model_ids) NOT BETWEEN 1 AND 1000
      THEN
        RETURN false;
      END IF;
      FOR model_value IN SELECT value FROM json_array_elements(model_ids)
      LOOP
        IF json_typeof(model_value) <> 'string' THEN
          RETURN false;
        END IF;
        model_id := model_value #>> '{}';
        normalized_model := lower(btrim(model_id));
        IF model_id <> btrim(model_id)
          OR char_length(model_id) NOT BETWEEN 1 AND 120
          OR normalized_model = ANY(seen_models)
        THEN
          RETURN false;
        END IF;
        seen_models := array_append(seen_models, normalized_model);
        IF normalized_model = ANY(real_models) THEN
          IF model_id <> normalized_model THEN
            RETURN false;
          END IF;
          CONTINUE;
        END IF;
        IF normalized_model LIKE 'firefly-%' THEN
          RETURN false;
        END IF;
        FOREACH real_model IN ARRAY real_models
        LOOP
          IF normalized_model LIKE real_model || '-%' THEN
            RETURN false;
          END IF;
        END LOOP;
      END LOOP;
      RETURN true;
    EXCEPTION WHEN OTHERS THEN
      RETURN false;
    END;
    $function_body$
  $function_ddl$;

  EXECUTE $function_ddl$
    CREATE OR REPLACE FUNCTION video_input_manifest_is_valid(
      input_manifest json,
      owner_user_id text,
      task_id text,
      real_model text
    ) RETURNS boolean
    LANGUAGE plpgsql
    IMMUTABLE
    STRICT
    SET search_path = pg_catalog
    AS $function_body$
    DECLARE
      manifest jsonb := input_manifest::jsonb;
      manifest_references jsonb := '[]'::jsonb;
      reference jsonb;
      reference_count integer := 0;
      frame_count integer := 0;
      total_bytes bigint := 0;
      byte_text text;
      byte_count bigint;
      storage_key text;
      storage_bucket text;
      object_prefix text := owner_user_id || '/video-inputs/' || task_id || '/';
      object_suffix text;
      seen_storage_keys text[] := ARRAY[]::text[];
    BEGIN
      IF jsonb_typeof(manifest) <> 'object'
        OR manifest = '{}'::jsonb
        OR manifest - ARRAY[
          'firstFrame', 'lastFrame', 'referenceImages'
        ]::text[] <> '{}'::jsonb
      THEN
        RETURN false;
      END IF;
      IF manifest ? 'lastFrame' AND NOT manifest ? 'firstFrame' THEN
        RETURN false;
      END IF;
      IF (manifest ? 'firstFrame' OR manifest ? 'lastFrame')
        AND manifest ? 'referenceImages'
      THEN
        RETURN false;
      END IF;
      IF manifest ? 'firstFrame' THEN
        frame_count := frame_count + 1;
        manifest_references := manifest_references ||
          jsonb_build_array(manifest->'firstFrame');
      END IF;
      IF manifest ? 'lastFrame' THEN
        frame_count := frame_count + 1;
        manifest_references := manifest_references ||
          jsonb_build_array(manifest->'lastFrame');
      END IF;
      IF manifest ? 'referenceImages' THEN
        IF jsonb_typeof(manifest->'referenceImages') <> 'array'
          OR jsonb_array_length(manifest->'referenceImages') < 1
        THEN
          RETURN false;
        END IF;
        manifest_references := manifest_references ||
          (manifest->'referenceImages');
      END IF;
      reference_count := jsonb_array_length(manifest_references);
      IF reference_count NOT BETWEEN 1 AND 256 THEN
        RETURN false;
      END IF;
      -- WHY：数据库直写也不能绕过真实模型输入能力；Seedance 动态管理上限无法从
      -- 历史任务证明，因此这里只固定模式和 256 张基础设施硬上限。
      IF real_model IN ('runway-gen45', 'ray314', 'ray314-hdr') THEN
        RETURN false;
      ELSIF real_model IN ('sora2', 'sora2-pro') THEN
        IF frame_count <> 1 OR manifest ? 'referenceImages' THEN
          RETURN false;
        END IF;
      ELSIF real_model IN (
        'veo31', 'veo31-fast', 'kling-o3', 'kling3'
      ) THEN
        IF frame_count NOT BETWEEN 1 AND 2
          OR manifest ? 'referenceImages'
        THEN
          RETURN false;
        END IF;
      ELSIF real_model = 'veo31-ref' THEN
        IF frame_count <> 0
          OR NOT manifest ? 'referenceImages'
          OR reference_count NOT BETWEEN 1 AND 3
        THEN
          RETURN false;
        END IF;
      ELSIF real_model = 'kling3-omni' THEN
        IF NOT (
          (frame_count BETWEEN 1 AND 2 AND NOT manifest ? 'referenceImages')
          OR (
            frame_count = 0
            AND manifest ? 'referenceImages'
            AND reference_count BETWEEN 1 AND 3
          )
        ) THEN
          RETURN false;
        END IF;
      ELSIF real_model IN ('seedance2', 'seedance2-fast') THEN
        IF NOT (
          (frame_count BETWEEN 1 AND 2 AND NOT manifest ? 'referenceImages')
          OR (
            frame_count = 0
            AND manifest ? 'referenceImages'
            AND reference_count BETWEEN 1 AND 256
          )
        ) THEN
          RETURN false;
        END IF;
      ELSE
        RETURN false;
      END IF;
      FOR reference IN
        SELECT value FROM jsonb_array_elements(manifest_references)
      LOOP
        IF jsonb_typeof(reference) <> 'object'
          OR reference - ARRAY[
            'source', 'mimeType', 'storageKey', 'storageBucket', 'byteLength'
          ]::text[] <> '{}'::jsonb
          OR jsonb_typeof(reference->'source') <> 'string'
          OR reference->>'source' <> 'storage'
          OR jsonb_typeof(reference->'mimeType') <> 'string'
          OR reference->>'mimeType' NOT IN (
            'image/png', 'image/jpeg', 'image/webp'
          )
          OR jsonb_typeof(reference->'storageKey') <> 'string'
          OR jsonb_typeof(reference->'storageBucket') <> 'string'
          OR jsonb_typeof(reference->'byteLength') <> 'number'
        THEN
          RETURN false;
        END IF;
        storage_key := reference->>'storageKey';
        storage_bucket := reference->>'storageBucket';
        byte_text := reference->>'byteLength';
        IF byte_text !~ '^[1-9][0-9]*$'
          OR storage_key <> btrim(storage_key)
          OR char_length(storage_key) NOT BETWEEN 1 AND 1024
          OR storage_bucket <> btrim(storage_bucket)
          OR char_length(storage_bucket) NOT BETWEEN 1 AND 128
          OR position('/' IN storage_bucket) > 0
          OR position(chr(92) IN storage_bucket) > 0
          OR position('..' IN storage_bucket) > 0
          OR left(storage_key, char_length(object_prefix)) <> object_prefix
          OR storage_key = ANY(seen_storage_keys)
        THEN
          RETURN false;
        END IF;
        object_suffix := substr(
          storage_key,
          char_length(object_prefix) + 1
        );
        IF object_suffix !~ '^[^/]+/[^/]+$'
          OR split_part(object_suffix, '/', 1) IN ('.', '..')
          OR split_part(object_suffix, '/', 2) IN ('.', '..')
        THEN
          RETURN false;
        END IF;
        byte_count := byte_text::bigint;
        total_bytes := total_bytes + byte_count;
        IF total_bytes > 209715200 THEN
          RETURN false;
        END IF;
        seen_storage_keys := array_append(seen_storage_keys, storage_key);
      END LOOP;
      RETURN true;
    EXCEPTION WHEN OTHERS THEN
      RETURN false;
    END;
    $function_body$
  $function_ddl$;

  -- 旧数组必须已经由资产收编程序转换为任务自有 storage 对象，且角色不能靠默认值猜测。
  WITH invalid AS (
    SELECT video.id
    FROM video_generation AS video
    WHERE (video.metadata IS NOT NULL AND json_typeof(video.metadata) <> 'object')
      OR (
        video.staged_input_objects IS NOT NULL
        AND (
          json_typeof(video.staged_input_objects) <> 'array'
          OR json_array_length(
            CASE
              WHEN json_typeof(video.staged_input_objects) = 'array'
                THEN video.staged_input_objects
              ELSE '[]'::json
            END
          ) <> 0
        )
      )
      OR (
        video.input_image_refs IS NOT NULL
        AND (
          json_typeof(video.input_image_refs) <> 'array'
          OR json_array_length(
            CASE
              WHEN json_typeof(video.input_image_refs) = 'array'
                THEN video.input_image_refs
              ELSE '[]'::json
            END
          ) < 1
        )
      )
      OR (video.input_manifest IS NOT NULL AND video.input_image_refs IS NOT NULL)
      OR (
        video.input_image_refs IS NOT NULL
        AND coalesce(video.metadata->>'inputImageRole', '') NOT IN (
          'frame', 'reference'
        )
      )
      OR (
        video.input_image_refs IS NULL
        AND video.metadata::jsonb ? 'inputImageRole'
      )
    ORDER BY video.id
    LIMIT 20
  )
  SELECT array_agg(id ORDER BY id)
  INTO invalid_input_ids
  FROM invalid;
  IF invalid_input_ids IS NOT NULL THEN
    RAISE EXCEPTION
      '0074 blocked: video input role or staging state is not provable (%)',
      array_to_string(invalid_input_ids, ',');
  END IF;

  CREATE TEMP TABLE _0074_video_input_projection (
    video_id text PRIMARY KEY,
    input_manifest json
  ) ON COMMIT DROP;
  INSERT INTO _0074_video_input_projection (video_id, input_manifest)
  SELECT
    video.id,
    CASE
      WHEN video.input_manifest IS NOT NULL THEN video.input_manifest
      WHEN video.input_image_refs IS NULL THEN NULL
      WHEN video.metadata->>'inputImageRole' = 'reference' THEN
        json_build_object('referenceImages', video.input_image_refs)
      WHEN json_array_length(video.input_image_refs) = 1 THEN
        json_build_object('firstFrame', video.input_image_refs->0)
      WHEN json_array_length(video.input_image_refs) = 2 THEN
        json_build_object(
          'firstFrame', video.input_image_refs->0,
          'lastFrame', video.input_image_refs->1
        )
      ELSE NULL
    END
  FROM video_generation AS video;

  WITH invalid AS (
    SELECT projection.video_id AS id
    FROM _0074_video_input_projection AS projection
    INNER JOIN video_generation AS video ON video.id = projection.video_id
    INNER JOIN _0074_video_task_projection AS task
      ON task.video_id = projection.video_id
    WHERE (
        video.input_image_refs IS NOT NULL
        AND projection.input_manifest IS NULL
      )
      OR (
        projection.input_manifest IS NOT NULL
        AND NOT video_input_manifest_is_valid(
          projection.input_manifest,
          video.user_id,
          video.id,
          task.real_model
        )
      )
    ORDER BY projection.video_id
    LIMIT 20
  )
  SELECT array_agg(id ORDER BY id)
  INTO invalid_input_ids
  FROM invalid;
  IF invalid_input_ids IS NOT NULL THEN
    RAISE EXCEPTION
      '0074 blocked: video input manifest or object ownership is invalid (%)',
      array_to_string(invalid_input_ids, ',');
  END IF;

  CREATE TEMP TABLE _0074_member_model_projection (
    member_id text PRIMARY KEY,
    model_ids json NOT NULL
  ) ON COMMIT DROP;
  WITH expanded AS (
    SELECT
      member.id,
      model.value #>> '{}' AS original_model,
      lower(btrim(model.value #>> '{}')) AS normalized_model,
      model.ordinality,
      mapping.real_model AS mapped_real_model,
      lower(btrim(model.value #>> '{}')) = ANY (
        ARRAY[
          'sora2', 'sora2-pro', 'veo31', 'veo31-fast', 'veo31-ref',
          'kling-o3', 'kling3', 'kling3-omni', 'runway-gen45',
          'ray314', 'ray314-hdr', 'seedance2', 'seedance2-fast'
        ]::text[]
      ) AS is_real_video
    FROM image_backend_member AS member
    CROSS JOIN LATERAL json_array_elements(member.supported_model_ids)
      WITH ORDINALITY AS model(value, ordinality)
    LEFT JOIN _0074_video_model_mapping AS mapping
      ON mapping.legacy_model = lower(btrim(model.value #>> '{}'))
  ), projected AS (
    SELECT
      expanded.id,
      CASE
        WHEN expanded.mapped_real_model IS NOT NULL
          THEN expanded.mapped_real_model
        WHEN expanded.is_real_video THEN expanded.normalized_model
        ELSE expanded.original_model
      END AS model_id,
      expanded.ordinality,
      CASE
        WHEN expanded.mapped_real_model IS NOT NULL OR expanded.is_real_video
          THEN row_number() OVER (
            PARTITION BY expanded.id, coalesce(
              expanded.mapped_real_model,
              expanded.normalized_model
            )
            ORDER BY expanded.ordinality
          )
        ELSE 1
      END AS duplicate_rank
    FROM expanded
  )
  INSERT INTO _0074_member_model_projection (member_id, model_ids)
    SELECT
      projected.id,
      json_agg(projected.model_id ORDER BY projected.ordinality) AS model_ids
    FROM projected
    WHERE projected.duplicate_rank = 1
    GROUP BY projected.id;

  WITH invalid AS (
    SELECT projection.member_id AS id
    FROM _0074_member_model_projection AS projection
    WHERE NOT media_supported_model_ids_are_valid(projection.model_ids)
    ORDER BY projection.member_id
    LIMIT 20
  )
  SELECT array_agg(id ORDER BY id)
  INTO invalid_member_ids
  FROM invalid;
  IF invalid_member_ids IS NOT NULL THEN
    RAISE EXCEPTION
      '0074 blocked: projected member model arrays are invalid (%)',
      array_to_string(invalid_member_ids, ',');
  END IF;

  -- 到这里所有门禁均已通过；后续任何 DML、DDL 或约束错误仍由同一 DO 事务回滚。
  UPDATE image_backend_member AS member
  SET supported_model_ids = projection.model_ids,
      updated_at = now()
  FROM _0074_member_model_projection AS projection
  WHERE member.id = projection.member_id
    AND member.supported_model_ids::jsonb IS DISTINCT FROM
      projection.model_ids::jsonb;

  UPDATE video_generation AS video
  SET model = task.real_model,
      input_manifest = input_projection.input_manifest,
      metadata = CASE
        WHEN video.metadata IS NULL THEN NULL
        ELSE (video.metadata::jsonb - 'inputImageRole')::json
      END,
      updated_at = now()
  FROM _0074_video_task_projection AS task
  INNER JOIN _0074_video_input_projection AS input_projection
    ON input_projection.video_id = task.video_id
  WHERE video.id = task.video_id
    AND (
      video.model IS DISTINCT FROM task.real_model
      OR video.input_manifest::jsonb IS DISTINCT FROM
        input_projection.input_manifest::jsonb
      OR video.metadata::jsonb IS DISTINCT FROM
        (video.metadata::jsonb - 'inputImageRole')
    );

  ALTER TABLE image_backend_member
    DROP CONSTRAINT IF EXISTS image_backend_member_supported_models_check;
  ALTER TABLE image_backend_member
    ADD CONSTRAINT image_backend_member_supported_models_check
      CHECK (media_supported_model_ids_are_valid(supported_model_ids));

  ALTER TABLE video_generation
    DROP CONSTRAINT IF EXISTS video_generation_real_model_check,
    DROP CONSTRAINT IF EXISTS video_generation_input_manifest_check;
  ALTER TABLE video_generation
    ADD CONSTRAINT video_generation_real_model_check
      CHECK (
        model IN (
          'sora2', 'sora2-pro', 'veo31', 'veo31-fast', 'veo31-ref',
          'kling-o3', 'kling3', 'kling3-omni', 'runway-gen45',
          'ray314', 'ray314-hdr', 'seedance2', 'seedance2-fast'
        )
      ),
    ADD CONSTRAINT video_generation_input_manifest_check
      CHECK (
        input_manifest IS NULL
        OR video_input_manifest_is_valid(input_manifest, user_id, id, model)
      );

  ALTER TABLE video_generation
    DROP COLUMN family,
    DROP COLUMN input_image_refs,
    DROP COLUMN staged_input_objects;

  -- 同一事务内的 postcheck：约束之外再证明旧列与转换投影都已完全收敛。
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = target_schema
      AND table_name = 'video_generation'
      AND column_name IN (
        'family', 'input_image_refs', 'staged_input_objects'
      )
  ) OR EXISTS (
    SELECT 1
    FROM video_generation AS video
    INNER JOIN _0074_video_task_projection AS task
      ON task.video_id = video.id
    WHERE video.model IS DISTINCT FROM task.real_model
  ) OR EXISTS (
    SELECT 1
    FROM image_backend_member AS member
    WHERE NOT media_supported_model_ids_are_valid(
      member.supported_model_ids
    )
  ) OR EXISTS (
    SELECT 1
    FROM video_generation AS video
    WHERE video.input_manifest IS NOT NULL
      AND NOT video_input_manifest_is_valid(
        video.input_manifest,
        video.user_id,
        video.id,
        video.model
      )
  ) THEN
    RAISE EXCEPTION
      '0074 blocked: postcheck detected an incomplete schema switch';
  END IF;
END
$migration$;
