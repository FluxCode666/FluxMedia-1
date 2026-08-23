-- 扩展视频任务持久化清单，允许参考视频与参考音频并保持数据库层 fail-closed。
-- 参考媒体已经在应用层完成真实媒体元数据校验；本函数负责清单结构、对象归属、
-- MIME、单文件大小、数量和总量的最终约束，防止绕过 UOL 直接写入非法 JSON。
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
  has_reference_media boolean := false;
BEGIN
  IF jsonb_typeof(manifest) <> 'object'
    OR manifest = '{}'::jsonb
    OR manifest - ARRAY[
      'firstFrame', 'lastFrame', 'referenceImages',
      'referenceVideos', 'referenceAudios'
    ]::text[] <> '{}'::jsonb
  THEN
    RETURN false;
  END IF;
  IF manifest ? 'lastFrame' AND NOT manifest ? 'firstFrame' THEN
    RETURN false;
  END IF;
  IF (manifest ? 'firstFrame' OR manifest ? 'lastFrame')
    AND (manifest ? 'referenceImages' OR manifest ? 'referenceVideos'
      OR manifest ? 'referenceAudios')
  THEN
    RETURN false;
  END IF;
  IF manifest ? 'firstFrame' THEN
    IF manifest->'firstFrame'->>'mimeType' NOT IN
      ('image/png', 'image/jpeg', 'image/webp') THEN RETURN false; END IF;
    frame_count := frame_count + 1;
    manifest_references := manifest_references ||
      jsonb_build_array(manifest->'firstFrame');
  END IF;
  IF manifest ? 'lastFrame' THEN
    IF manifest->'lastFrame'->>'mimeType' NOT IN
      ('image/png', 'image/jpeg', 'image/webp') THEN RETURN false; END IF;
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
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(manifest->'referenceImages') AS item
      WHERE item->>'mimeType' NOT IN ('image/png', 'image/jpeg', 'image/webp')
    ) THEN RETURN false; END IF;
    manifest_references := manifest_references || (manifest->'referenceImages');
    has_reference_media := true;
  END IF;
  IF manifest ? 'referenceVideos' THEN
    IF jsonb_typeof(manifest->'referenceVideos') <> 'array'
      OR jsonb_array_length(manifest->'referenceVideos') NOT BETWEEN 1 AND 3
    THEN
      RETURN false;
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(manifest->'referenceVideos') AS item
      WHERE item->>'mimeType' NOT IN ('video/mp4', 'video/quicktime')
    ) THEN RETURN false; END IF;
    manifest_references := manifest_references || (manifest->'referenceVideos');
    has_reference_media := true;
  END IF;
  IF manifest ? 'referenceAudios' THEN
    IF jsonb_typeof(manifest->'referenceAudios') <> 'array'
      OR jsonb_array_length(manifest->'referenceAudios') <> 1
    THEN
      RETURN false;
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(manifest->'referenceAudios') AS item
      WHERE item->>'mimeType' NOT IN ('audio/mpeg', 'audio/wav', 'audio/x-wav')
    ) THEN RETURN false; END IF;
    manifest_references := manifest_references || (manifest->'referenceAudios');
    has_reference_media := true;
  END IF;
  reference_count := jsonb_array_length(manifest_references);
  IF reference_count NOT BETWEEN 1 AND 256 THEN
    RETURN false;
  END IF;
  IF real_model IN ('runway-gen45', 'ray314', 'ray314-hdr') THEN
    RETURN false;
  ELSIF real_model IN ('sora2', 'sora2-pro') THEN
    IF frame_count <> 1 OR has_reference_media THEN RETURN false; END IF;
  ELSIF real_model IN ('veo31', 'veo31-fast', 'kling-o3', 'kling3') THEN
    IF frame_count NOT BETWEEN 1 AND 2 AND NOT has_reference_media THEN
      RETURN false;
    END IF;
  ELSIF real_model = 'veo31-ref' THEN
    IF frame_count <> 0 OR NOT has_reference_media OR reference_count NOT BETWEEN 1 AND 3 THEN
      RETURN false;
    END IF;
  ELSIF real_model = 'kling3-omni' THEN
    IF NOT ((frame_count BETWEEN 1 AND 2 AND NOT has_reference_media)
      OR (frame_count = 0 AND has_reference_media AND reference_count BETWEEN 1 AND 3)) THEN
      RETURN false;
    END IF;
  ELSIF real_model IN ('seedance2', 'seedance2-fast') THEN
    IF NOT ((frame_count BETWEEN 1 AND 2 AND NOT has_reference_media)
      OR (frame_count = 0 AND has_reference_media AND reference_count BETWEEN 1 AND 256)) THEN
      RETURN false;
    END IF;
  ELSE
    RETURN false;
  END IF;
  FOR reference IN SELECT value FROM jsonb_array_elements(manifest_references) LOOP
    IF jsonb_typeof(reference) <> 'object'
      OR reference - ARRAY[
        'source', 'mimeType', 'storageKey', 'storageBucket', 'byteLength'
      ]::text[] <> '{}'::jsonb
      OR jsonb_typeof(reference->'source') <> 'string'
      OR reference->>'source' <> 'storage'
      OR jsonb_typeof(reference->'mimeType') <> 'string'
      OR reference->>'mimeType' NOT IN (
        'image/png', 'image/jpeg', 'image/webp', 'video/mp4',
        'video/quicktime', 'audio/mpeg', 'audio/wav', 'audio/x-wav'
      )
      OR jsonb_typeof(reference->'storageKey') <> 'string'
      OR jsonb_typeof(reference->'storageBucket') <> 'string'
      OR jsonb_typeof(reference->'byteLength') <> 'number'
    THEN RETURN false; END IF;
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
    THEN RETURN false; END IF;
    object_suffix := substr(storage_key, char_length(object_prefix) + 1);
    IF object_suffix !~ '^[^/]+/[^/]+$'
      OR split_part(object_suffix, '/', 1) IN ('.', '..')
      OR split_part(object_suffix, '/', 2) IN ('.', '..')
    THEN RETURN false; END IF;
    byte_count := byte_text::bigint;
    IF byte_count > 209715200
      OR ((reference->>'mimeType') LIKE 'audio/%' AND byte_count > 15728640)
    THEN RETURN false; END IF;
    total_bytes := total_bytes + byte_count;
    IF total_bytes > 536870912 THEN RETURN false; END IF;
    seen_storage_keys := array_append(seen_storage_keys, storage_key);
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$function_body$;

ALTER TABLE video_generation
  DROP CONSTRAINT IF EXISTS video_generation_input_manifest_check;

ALTER TABLE video_generation
  ADD CONSTRAINT video_generation_input_manifest_check
  CHECK (
    input_manifest IS NULL
    OR video_input_manifest_is_valid(input_manifest, user_id, id, model)
  );
