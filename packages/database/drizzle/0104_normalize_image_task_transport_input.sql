-- 归一化 Go writer 曾误写进 generation input 的 HTTP 投递字段。
-- requestDigest、response_format 与 callback_url 独立保存，因此此转换不改变幂等或交付语义。

CREATE OR REPLACE FUNCTION fluxmedia_u6_normalize_image_task_transport_input(
  input jsonb
) RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  normalized jsonb;
  legacy_output_format jsonb;
BEGIN
  IF input IS NULL OR jsonb_typeof(input) <> 'object' THEN
    RETURN NULL;
  END IF;

  normalized := input - ARRAY[
    'taskId', 'task_id',
    'responseFormat', 'response_format',
    'callbackUrl', 'callback_url',
    'async', 'stream'
  ];

  IF input ? 'output_format' THEN
    legacy_output_format := input->'output_format';
    IF jsonb_typeof(legacy_output_format) <> 'string'
      OR (
        input ? 'outputFormat'
        AND input->'outputFormat' <> legacy_output_format
      )
    THEN
      RETURN NULL;
    END IF;
    normalized := (normalized - 'output_format')
      || jsonb_build_object('outputFormat', legacy_output_format);
  END IF;

  RETURN normalized;
END;
$function$;
--> statement-breakpoint
DO $migration_preflight$
DECLARE
  invalid_count bigint;
BEGIN
  SELECT count(*)
  INTO invalid_count
  FROM image_async_task AS task
  WHERE task.generation_input IS NULL
    OR json_typeof(task.generation_inputs) <> 'array'
    OR json_array_length(task.generation_inputs) <> 1
    OR fluxmedia_u6_normalize_image_task_transport_input(
      task.generation_input::jsonb
    ) IS NULL
    OR fluxmedia_u6_normalize_image_task_transport_input(
      (task.generation_inputs->0)::jsonb
    ) IS NULL
    OR fluxmedia_u6_normalize_image_task_transport_input(
      task.generation_input::jsonb
    ) <> fluxmedia_u6_normalize_image_task_transport_input(
      (task.generation_inputs->0)::jsonb
    );

  IF invalid_count <> 0 THEN
    RAISE EXCEPTION
      '0104 blocked: image task transport input normalization is not lossless (invalid=%)',
      invalid_count;
  END IF;
END;
$migration_preflight$;
--> statement-breakpoint
WITH normalized AS (
  SELECT
    id,
    fluxmedia_u6_normalize_image_task_transport_input(
      generation_input::jsonb
    ) AS generation_input
  FROM image_async_task
)
UPDATE image_async_task AS task
SET
  generation_input = normalized.generation_input::json,
  generation_inputs = jsonb_build_array(normalized.generation_input)::json,
  input_digest = 'md5:' || md5(normalized.generation_input::text)
FROM normalized
WHERE task.id = normalized.id
  AND (
    task.generation_input::jsonb <> normalized.generation_input
    OR (task.generation_inputs->0)::jsonb <> normalized.generation_input
  );
--> statement-breakpoint
ALTER TABLE image_async_task
  DROP CONSTRAINT IF EXISTS image_async_task_generation_input_transport_retired_check;
--> statement-breakpoint
ALTER TABLE image_async_task
  ADD CONSTRAINT image_async_task_generation_input_transport_retired_check
  CHECK (
    NOT (
      COALESCE(generation_input::jsonb, '{}'::jsonb) ?| ARRAY[
        'taskId', 'task_id',
        'responseFormat', 'response_format',
        'callbackUrl', 'callback_url',
        'async', 'stream', 'output_format'
      ]
    )
    AND NOT (
      COALESCE((generation_inputs->0)::jsonb, '{}'::jsonb) ?| ARRAY[
        'taskId', 'task_id',
        'responseFormat', 'response_format',
        'callbackUrl', 'callback_url',
        'async', 'stream', 'output_format'
      ]
    )
  );
--> statement-breakpoint
DROP FUNCTION IF EXISTS fluxmedia_u6_normalize_image_task_transport_input(jsonb);
