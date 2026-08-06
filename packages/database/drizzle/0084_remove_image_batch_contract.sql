-- 退役图片批量请求字段并规范历史单项任务。
--
-- 职责：只允许终态历史任务把 count=1 无损归一化为新单项输入；任何活跃任务、
-- count>1、非法数字或新旧单项列不一致都会使迁移整体回滚，绝不截断批量历史。

CREATE OR REPLACE FUNCTION fluxmedia_u5_image_batch_state(
  generation_input json,
  generation_inputs json
) RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  direct_has_count boolean := false;
  legacy_has_count boolean := false;
  direct_count numeric;
  legacy_count numeric;
BEGIN
  IF generation_input IS NOT NULL
    AND json_typeof(generation_input) = 'object'
  THEN
    direct_has_count := generation_input::jsonb ? 'count';
  END IF;

  IF generation_inputs IS NOT NULL
    AND json_typeof(generation_inputs) = 'array'
    AND json_array_length(generation_inputs) = 1
    AND json_typeof(generation_inputs->0) = 'object'
  THEN
    legacy_has_count := (generation_inputs->0)::jsonb ? 'count';
  END IF;

  IF NOT direct_has_count AND NOT legacy_has_count THEN
    RETURN 'none';
  END IF;
  IF NOT direct_has_count OR NOT legacy_has_count THEN
    RETURN 'invalid';
  END IF;
  IF json_typeof(generation_input->'count') <> 'number'
    OR json_typeof(generation_inputs->0->'count') <> 'number'
  THEN
    RETURN 'invalid';
  END IF;

  direct_count := (generation_input->>'count')::numeric;
  legacy_count := (generation_inputs->0->>'count')::numeric;
  IF direct_count <> trunc(direct_count)
    OR legacy_count <> trunc(legacy_count)
    OR direct_count <> 1
    OR legacy_count <> 1
  THEN
    RETURN 'invalid';
  END IF;
  RETURN 'single';
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RETURN 'invalid';
END;
$function$;
--> statement-breakpoint
DO $migration_preflight$
DECLARE
  invalid_count bigint;
  active_count bigint;
BEGIN
  SELECT
    count(*) FILTER (
      WHERE fluxmedia_u5_image_batch_state(
        generation_input,
        generation_inputs
      ) = 'invalid'
    ),
    count(*) FILTER (
      WHERE fluxmedia_u5_image_batch_state(
        generation_input,
        generation_inputs
      ) = 'single'
        AND status NOT IN ('completed', 'failed')
    )
  INTO invalid_count, active_count
  FROM image_async_task;

  IF invalid_count <> 0 OR active_count <> 0 THEN
    RAISE EXCEPTION
      '0084 blocked: image batch retirement is not lossless (invalid=%, active=%)',
      invalid_count,
      active_count;
  END IF;
END;
$migration_preflight$;
--> statement-breakpoint
WITH normalized AS (
  SELECT
    id,
    (generation_input::jsonb - 'count')::json AS generation_input
  FROM image_async_task
  WHERE fluxmedia_u5_image_batch_state(
    generation_input,
    generation_inputs
  ) = 'single'
)
UPDATE image_async_task AS task
SET
  generation_input = normalized.generation_input,
  generation_inputs = json_build_array(normalized.generation_input),
  input_digest = 'md5:' || md5(normalized.generation_input::text)
FROM normalized
WHERE task.id = normalized.id;
--> statement-breakpoint
ALTER TABLE image_async_task
  DROP CONSTRAINT IF EXISTS image_async_task_batch_count_retired_check;
--> statement-breakpoint
ALTER TABLE image_async_task
  ADD CONSTRAINT image_async_task_batch_count_retired_check
  CHECK (
    (
      generation_input IS NULL
      OR NOT (generation_input::jsonb ? 'count')
    )
    AND (
      json_typeof(generation_inputs) <> 'array'
      OR json_array_length(generation_inputs) <> 1
      OR json_typeof(generation_inputs->0) <> 'object'
      OR NOT ((generation_inputs->0)::jsonb ? 'count')
    )
  );
--> statement-breakpoint
DROP FUNCTION IF EXISTS fluxmedia_u5_image_batch_state(json, json);
