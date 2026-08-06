-- 订阅退役 Phase A 的 additive 数据基础与财务写入守门。
--
-- 职责：增加用户并发覆盖、图片异步单项输入与恢复游标；仅回填可严格证明的
-- 历史终态单项任务。旧 NOT NULL 数组与 plan 在兼容窗口继续保留，任何活跃旧任务、
-- 非法输入或 generation 冲突都会使迁移整体回滚，绝不截断或猜测历史数据。

ALTER TABLE "user"
  ADD COLUMN IF NOT EXISTS "image_generation_concurrency_override" integer;
--> statement-breakpoint
ALTER TABLE "user"
  DROP CONSTRAINT IF EXISTS "user_image_generation_concurrency_override_check";
--> statement-breakpoint
ALTER TABLE "user"
  ADD CONSTRAINT "user_image_generation_concurrency_override_check"
  CHECK (
    "image_generation_concurrency_override" IS NULL
    OR "image_generation_concurrency_override" BETWEEN 1 AND 10000
  );
--> statement-breakpoint
ALTER TABLE "image_async_task"
  ADD COLUMN IF NOT EXISTS "generation_input" json,
  ADD COLUMN IF NOT EXISTS "input_digest" text,
  ADD COLUMN IF NOT EXISTS "generation_id" text,
  ADD COLUMN IF NOT EXISTS "effective_user_concurrency" integer,
  ADD COLUMN IF NOT EXISTS "group_id_snapshot" text,
  ADD COLUMN IF NOT EXISTS "group_priority_snapshot" integer,
  ADD COLUMN IF NOT EXISTS "admission_lease_token" text,
  ADD COLUMN IF NOT EXISTS "admission_lease_expires_at" timestamp,
  ADD COLUMN IF NOT EXISTS "admission_lease_released_at" timestamp,
  ADD COLUMN IF NOT EXISTS "mq_delivery_due_at" timestamp,
  ADD COLUMN IF NOT EXISTS "claim_recovery_due_at" timestamp,
  ADD COLUMN IF NOT EXISTS "admission_renewal_due_at" timestamp,
  ADD COLUMN IF NOT EXISTS "terminal_release_due_at" timestamp;
--> statement-breakpoint
-- 临时校验一个持久媒体引用是否为严格、相对路径的 storage-only 图片对象。
CREATE OR REPLACE FUNCTION fluxmedia_u1_storage_image_reference_is_valid(
  reference json
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  byte_length numeric;
  storage_key text;
BEGIN
  IF reference IS NULL OR json_typeof(reference) <> 'object' THEN
    RETURN false;
  END IF;
  IF json_typeof(reference->'source') <> 'string'
    OR reference->>'source' <> 'storage'
    OR json_typeof(reference->'mimeType') <> 'string'
    OR reference->>'mimeType' NOT IN ('image/png', 'image/jpeg', 'image/webp')
    OR json_typeof(reference->'storageKey') <> 'string'
    OR json_typeof(reference->'byteLength') <> 'number'
  THEN
    RETURN false;
  END IF;

  storage_key := btrim(reference->>'storageKey');
  IF char_length(storage_key) NOT BETWEEN 1 AND 1024
    OR left(storage_key, 1) = '/'
    OR '..' = ANY(string_to_array(storage_key, '/'))
  THEN
    RETURN false;
  END IF;

  BEGIN
    byte_length := (reference->>'byteLength')::numeric;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RETURN false;
  END;
  IF byte_length <> trunc(byte_length)
    OR byte_length NOT BETWEEN 1 AND 209715200
  THEN
    RETURN false;
  END IF;

  IF reference::jsonb ? 'storageBucket' THEN
    IF json_typeof(reference->'storageBucket') <> 'string'
      OR char_length(btrim(reference->>'storageBucket')) NOT BETWEEN 1 AND 128
    THEN
      RETURN false;
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM json_object_keys(reference) AS field(name)
    WHERE field.name NOT IN (
      'source', 'mimeType', 'storageKey', 'storageBucket', 'byteLength'
    )
  ) THEN
    RETURN false;
  END IF;
  RETURN true;
END;
$function$;
--> statement-breakpoint
-- 临时校验历史单项输入的身份、动作、最小 schema 与 storage-only 媒体约束。
CREATE OR REPLACE FUNCTION fluxmedia_u1_image_generation_input_is_valid(
  generation_input json,
  expected_operation text,
  expected_generation_id text
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  reference json;
  image_total_bytes numeric := 0;
BEGIN
  IF generation_input IS NULL OR json_typeof(generation_input) <> 'object' THEN
    RETURN false;
  END IF;
  IF expected_operation NOT IN ('generate', 'edit', 'mask')
    OR json_typeof(generation_input->'operation') <> 'string'
    OR generation_input->>'operation' <> expected_operation
    OR json_typeof(generation_input->'generationId') <> 'string'
    OR generation_input->>'generationId' <> expected_generation_id
    OR char_length(btrim(expected_generation_id)) NOT BETWEEN 1 AND 128
    OR json_typeof(generation_input->'prompt') <> 'string'
    OR char_length(btrim(generation_input->>'prompt')) NOT BETWEEN 1 AND 100000
    OR json_typeof(generation_input->'model') <> 'string'
    OR char_length(btrim(generation_input->>'model')) NOT BETWEEN 1 AND 120
  THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM json_object_keys(generation_input) AS field(name)
    WHERE field.name NOT IN (
      'operation', 'prompt', 'negativePrompt', 'apiPrompt',
      'promptOptimization', 'model', 'size', 'quality', 'style', 'thinking',
      'moderation', 'outputFormat', 'outputCompression', 'background',
      'transparentMatte', 'moderationPromptRepair', 'hdRepair', 'blockRepair',
      'repairPrompt', 'count', 'generationId', 'backendGroupId'
    )
      AND NOT (expected_operation IN ('edit', 'mask') AND field.name = 'images')
      AND NOT (expected_operation = 'mask' AND field.name = 'mask')
  ) THEN
    RETURN false;
  END IF;

  IF generation_input::jsonb ? 'negativePrompt' AND (
    json_typeof(generation_input->'negativePrompt') <> 'string'
    OR char_length(generation_input->>'negativePrompt') > 100000
  ) THEN
    RETURN false;
  END IF;
  IF generation_input::jsonb ? 'apiPrompt' AND (
    json_typeof(generation_input->'apiPrompt') <> 'string'
    OR char_length(btrim(generation_input->>'apiPrompt')) NOT BETWEEN 1 AND 8000
  ) THEN
    RETURN false;
  END IF;
  IF generation_input::jsonb ? 'size' AND (
    json_typeof(generation_input->'size') <> 'string'
    OR char_length(btrim(generation_input->>'size')) NOT BETWEEN 1 AND 40
  ) THEN
    RETURN false;
  END IF;
  IF generation_input::jsonb ? 'quality' AND (
    json_typeof(generation_input->'quality') <> 'string'
    OR char_length(btrim(generation_input->>'quality')) NOT BETWEEN 1 AND 40
  ) THEN
    RETURN false;
  END IF;
  IF generation_input::jsonb ? 'style' AND (
    json_typeof(generation_input->'style') <> 'string'
    OR char_length(btrim(generation_input->>'style')) NOT BETWEEN 1 AND 80
  ) THEN
    RETURN false;
  END IF;
  IF generation_input::jsonb ? 'repairPrompt' AND (
    json_typeof(generation_input->'repairPrompt') <> 'string'
    OR char_length(generation_input->>'repairPrompt') > 8000
  ) THEN
    RETURN false;
  END IF;
  IF generation_input::jsonb ? 'thinking' AND (
    json_typeof(generation_input->'thinking') <> 'string'
    OR generation_input->>'thinking' NOT IN (
      'minimal', 'none', 'low', 'medium', 'high', 'xhigh'
    )
  ) THEN
    RETURN false;
  END IF;
  IF generation_input::jsonb ? 'moderation' AND (
    json_typeof(generation_input->'moderation') <> 'string'
    OR generation_input->>'moderation' NOT IN ('auto', 'low')
  ) THEN
    RETURN false;
  END IF;
  IF generation_input::jsonb ? 'outputFormat' AND (
    json_typeof(generation_input->'outputFormat') <> 'string'
    OR generation_input->>'outputFormat' NOT IN ('png', 'jpeg', 'webp')
  ) THEN
    RETURN false;
  END IF;
  IF generation_input::jsonb ? 'background' AND (
    json_typeof(generation_input->'background') <> 'string'
    OR generation_input->>'background' NOT IN ('transparent', 'opaque', 'auto')
  ) THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM unnest(ARRAY[
      'promptOptimization', 'transparentMatte', 'moderationPromptRepair',
      'hdRepair', 'blockRepair'
    ]) AS boolean_field(name)
    WHERE generation_input::jsonb ? boolean_field.name
      AND json_typeof(generation_input->boolean_field.name) <> 'boolean'
  ) THEN
    RETURN false;
  END IF;
  IF generation_input::jsonb ? 'outputCompression' AND (
    json_typeof(generation_input->'outputCompression') <> 'number'
    OR (generation_input->>'outputCompression')::numeric
      <> trunc((generation_input->>'outputCompression')::numeric)
    OR (generation_input->>'outputCompression')::numeric NOT BETWEEN 0 AND 100
  ) THEN
    RETURN false;
  END IF;

  IF generation_input::jsonb ? 'backendGroupId' AND (
    json_typeof(generation_input->'backendGroupId') <> 'string'
    OR char_length(btrim(generation_input->>'backendGroupId'))
      NOT BETWEEN 1 AND 128
  ) THEN
    RETURN false;
  END IF;
  IF generation_input::jsonb ? 'count' AND (
    json_typeof(generation_input->'count') <> 'number'
    OR (generation_input->>'count')::numeric
      <> trunc((generation_input->>'count')::numeric)
    OR (generation_input->>'count')::numeric NOT BETWEEN 1 AND 10000
  ) THEN
    RETURN false;
  END IF;

  IF expected_operation = 'generate' THEN
    RETURN NOT (generation_input::jsonb ? 'images')
      AND NOT (generation_input::jsonb ? 'mask');
  END IF;
  IF json_typeof(generation_input->'images') <> 'array'
    OR json_array_length(generation_input->'images') NOT BETWEEN 1 AND 256
  THEN
    RETURN false;
  END IF;
  FOR reference IN
    SELECT value FROM json_array_elements(generation_input->'images')
  LOOP
    IF NOT fluxmedia_u1_storage_image_reference_is_valid(reference) THEN
      RETURN false;
    END IF;
    image_total_bytes := image_total_bytes + (reference->>'byteLength')::numeric;
  END LOOP;
  IF image_total_bytes > 209715200 THEN
    RETURN false;
  END IF;

  IF expected_operation = 'edit' THEN
    RETURN NOT (generation_input::jsonb ? 'mask');
  END IF;
  RETURN fluxmedia_u1_storage_image_reference_is_valid(
    generation_input->'mask'
  );
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RETURN false;
END;
$function$;
--> statement-breakpoint
DO $migration_preflight$
DECLARE
  legacy_nonterminal_count bigint;
  legacy_invalid_count bigint;
  populated_invalid_count bigint;
  generation_conflict_count bigint;
BEGIN
  SELECT count(*)
  INTO legacy_nonterminal_count
  FROM image_async_task
  WHERE generation_input IS NULL
    AND status NOT IN ('completed', 'failed');

  WITH shaped AS (
    SELECT
      task.*,
      CASE
        WHEN json_typeof(task.generation_inputs) = 'array' THEN
          CASE
            WHEN json_array_length(task.generation_inputs) = 1
            THEN task.generation_inputs->0
          END
      END AS legacy_input,
      CASE
        WHEN json_typeof(task.generation_inputs) = 'array'
        THEN json_array_length(task.generation_inputs)
        ELSE -1
      END AS legacy_input_count,
      CASE
        WHEN json_typeof(task.generation_ids) = 'array' THEN
          CASE
            WHEN json_array_length(task.generation_ids) = 1
              AND json_typeof(task.generation_ids->0) = 'string'
            THEN task.generation_ids->>0
          END
      END AS legacy_generation_id,
      CASE
        WHEN json_typeof(task.generation_ids) = 'array'
        THEN json_array_length(task.generation_ids)
        ELSE -1
      END AS legacy_generation_id_count
    FROM image_async_task AS task
    WHERE task.generation_input IS NULL
      AND task.status IN ('completed', 'failed')
  )
  SELECT count(*)
  INTO legacy_invalid_count
  FROM shaped
  WHERE legacy_input_count <> 1
    OR legacy_generation_id_count <> 1
    OR legacy_input IS NULL
    OR legacy_generation_id IS NULL
    OR NOT fluxmedia_u1_image_generation_input_is_valid(
      legacy_input,
      operation,
      legacy_generation_id
    );

  SELECT count(*)
  INTO populated_invalid_count
  FROM image_async_task AS task
  WHERE (
      task.generation_input IS NULL
      AND (task.input_digest IS NOT NULL OR task.generation_id IS NOT NULL)
    )
    OR (
      task.generation_input IS NOT NULL
      AND (
        task.input_digest IS NULL
        OR task.input_digest !~ '^(md5:[0-9a-f]{32}|sha256:[0-9a-f]{64})$'
        OR task.generation_id IS NULL
        OR NOT fluxmedia_u1_image_generation_input_is_valid(
          task.generation_input,
          task.operation,
          task.generation_id
        )
      )
    );

  WITH candidates AS (
    SELECT
      task.id,
      COALESCE(
        task.generation_id,
        CASE
          WHEN json_typeof(task.generation_ids) = 'array' THEN
            CASE
              WHEN json_array_length(task.generation_ids) = 1
                AND json_typeof(task.generation_ids->0) = 'string'
              THEN NULLIF(btrim(task.generation_ids->>0), '')
            END
        END
      ) AS generation_id
    FROM image_async_task AS task
  ), conflicts AS (
    SELECT generation_id
    FROM candidates
    WHERE generation_id IS NOT NULL
    GROUP BY generation_id
    HAVING count(*) > 1
  )
  SELECT count(*)
  INTO generation_conflict_count
  FROM conflicts;

  IF legacy_nonterminal_count <> 0
    OR legacy_invalid_count <> 0
    OR populated_invalid_count <> 0
    OR generation_conflict_count <> 0
  THEN
    RAISE EXCEPTION
      '0081 blocked: image async task migration is not lossless (legacy_nonterminal=%, legacy_invalid=%, populated_invalid=%, generation_conflict=%)',
      legacy_nonterminal_count,
      legacy_invalid_count,
      populated_invalid_count,
      generation_conflict_count;
  END IF;
END;
$migration_preflight$;
--> statement-breakpoint
-- 历史行已终态且只用于幂等对账；使用带算法前缀的内建 MD5 避免要求扩展权限。
-- Phase A 新 writer 必须写 sha256:<64hex>，两种格式都不会被当作凭据摘要。
UPDATE image_async_task
SET
  generation_input = generation_inputs->0,
  generation_id = generation_ids->>0,
  input_digest = 'md5:' || md5((generation_inputs->0)::text)
WHERE generation_input IS NULL
  AND status IN ('completed', 'failed');
--> statement-breakpoint
ALTER TABLE image_async_task
  DROP CONSTRAINT IF EXISTS image_async_task_single_input_core_check,
  DROP CONSTRAINT IF EXISTS image_async_task_generation_input_shape_check,
  DROP CONSTRAINT IF EXISTS image_async_task_policy_snapshot_check,
  DROP CONSTRAINT IF EXISTS image_async_task_admission_lease_state_check,
  DROP CONSTRAINT IF EXISTS image_async_task_due_state_check;
--> statement-breakpoint
ALTER TABLE image_async_task
  ADD CONSTRAINT image_async_task_single_input_core_check
    CHECK (
      (
        generation_input IS NULL
        AND input_digest IS NULL
        AND generation_id IS NULL
      ) OR (
        generation_input IS NOT NULL
        AND input_digest IS NOT NULL
        AND input_digest ~ '^(md5:[0-9a-f]{32}|sha256:[0-9a-f]{64})$'
        AND generation_id IS NOT NULL
        AND char_length(btrim(generation_id)) BETWEEN 1 AND 128
      )
    ),
  ADD CONSTRAINT image_async_task_generation_input_shape_check
    CHECK (
      generation_input IS NULL OR (
        json_typeof(generation_input) = 'object'
        AND json_typeof(generation_input->'generationId') = 'string'
        AND generation_input->>'generationId' = generation_id
        AND json_typeof(generation_input->'operation') = 'string'
        AND generation_input->>'operation' = operation
      )
    ),
  ADD CONSTRAINT image_async_task_policy_snapshot_check
    CHECK (
      (
        effective_user_concurrency IS NULL
        AND group_id_snapshot IS NULL
        AND group_priority_snapshot IS NULL
      ) OR (
        effective_user_concurrency IS NOT NULL
        AND effective_user_concurrency BETWEEN 1 AND 10000
        AND group_id_snapshot IS NOT NULL
        AND char_length(btrim(group_id_snapshot)) BETWEEN 1 AND 128
        AND group_priority_snapshot IS NOT NULL
        AND group_priority_snapshot BETWEEN 0 AND 10000
      )
    ),
  ADD CONSTRAINT image_async_task_admission_lease_state_check
    CHECK (
      (
        admission_lease_token IS NULL
        AND admission_lease_expires_at IS NULL
        AND admission_lease_released_at IS NULL
      ) OR (
        admission_lease_token IS NOT NULL
        AND char_length(btrim(admission_lease_token)) BETWEEN 1 AND 256
        AND admission_lease_expires_at IS NOT NULL
        AND (
          admission_lease_released_at IS NULL
          OR status IN ('completed', 'failed')
        )
      )
    ),
  ADD CONSTRAINT image_async_task_due_state_check
    CHECK (
      (mq_delivery_due_at IS NULL OR status IN ('queued', 'running'))
      AND (claim_recovery_due_at IS NULL OR status IN ('queued', 'running'))
      AND (
        admission_renewal_due_at IS NULL
        OR (
          status IN ('queued', 'running')
          AND admission_lease_token IS NOT NULL
          AND admission_lease_released_at IS NULL
        )
      )
      AND (
        terminal_release_due_at IS NULL
        OR (
          status IN ('completed', 'failed')
          AND admission_lease_token IS NOT NULL
          AND admission_lease_released_at IS NULL
        )
      )
    );
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS image_async_task_generation_id_unique
  ON image_async_task (generation_id)
  WHERE generation_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS image_async_task_admission_lease_token_unique
  ON image_async_task (admission_lease_token)
  WHERE admission_lease_token IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS image_async_task_mq_delivery_due_idx
  ON image_async_task (mq_delivery_due_at, id)
  WHERE status IN ('queued', 'running') AND mq_delivery_due_at IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS image_async_task_claim_recovery_due_idx
  ON image_async_task (claim_recovery_due_at, id)
  WHERE status IN ('queued', 'running') AND claim_recovery_due_at IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS image_async_task_admission_renewal_due_idx
  ON image_async_task (admission_renewal_due_at, id)
  WHERE status IN ('queued', 'running')
    AND admission_renewal_due_at IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS image_async_task_terminal_release_due_idx
  ON image_async_task (terminal_release_due_at, id)
  WHERE status IN ('completed', 'failed')
    AND terminal_release_due_at IS NOT NULL
    AND admission_lease_released_at IS NULL;
--> statement-breakpoint
-- INSERT-only 守门：历史 subscription 批次仍可被 FIFO、过期和退款逻辑更新。
CREATE OR REPLACE FUNCTION reject_new_subscription_credits_batch()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.source_type::text = 'subscription' THEN
    RAISE EXCEPTION 'new subscription credits batches are retired'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS credits_batch_reject_subscription_insert
  ON credits_batch;
--> statement-breakpoint
CREATE TRIGGER credits_batch_reject_subscription_insert
  BEFORE INSERT ON credits_batch
  FOR EACH ROW
  EXECUTE FUNCTION reject_new_subscription_credits_batch();
--> statement-breakpoint
-- INSERT-only 守门：历史 monthly_grant 交易保留可读性及普通 UPDATE 能力。
CREATE OR REPLACE FUNCTION reject_new_monthly_grant_credits_transaction()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.type::text = 'monthly_grant' THEN
    RAISE EXCEPTION 'new monthly grant credits transactions are retired'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS credits_transaction_reject_monthly_grant_insert
  ON credits_transaction;
--> statement-breakpoint
CREATE TRIGGER credits_transaction_reject_monthly_grant_insert
  BEFORE INSERT ON credits_transaction
  FOR EACH ROW
  EXECUTE FUNCTION reject_new_monthly_grant_credits_transaction();
--> statement-breakpoint
DROP FUNCTION fluxmedia_u1_image_generation_input_is_valid(json, text, text);
--> statement-breakpoint
DROP FUNCTION fluxmedia_u1_storage_image_reference_is_valid(json);
