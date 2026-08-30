-- 将 Nano Banana 2 的平台模型 ID 从 `nano-banana2` 统一为 `nano-banana-2`。
--
-- 旧值可能存在于后端能力、分辨率能力、分组价格、模型广场配置和历史任务中；
-- 所有转换均在同一事务内完成，并保留已存在的新键值以避免覆盖管理员配置。
WITH expanded_models AS (
  SELECT
    member."id",
    CASE
      WHEN item."model_id" ~* '^(firefly-)?nano-banana2($|-)' THEN
        regexp_replace(item."model_id", '^(firefly-)?nano-banana2', 'nano-banana-2', 'i')
      ELSE item."model_id"
    END AS "model_id",
    item."ordinality"
  FROM "image_backend_member" AS member
  CROSS JOIN LATERAL json_array_elements_text(member."supported_model_ids")
    WITH ORDINALITY AS item("model_id", "ordinality")
), ranked_models AS (
  SELECT
    expanded."id",
    expanded."model_id",
    expanded."ordinality",
    row_number() OVER (
      PARTITION BY expanded."id", lower(expanded."model_id")
      ORDER BY expanded."ordinality"
    ) AS "duplicate_rank"
  FROM expanded_models AS expanded
), normalized_models AS (
  SELECT
    ranked."id",
    json_agg(ranked."model_id" ORDER BY ranked."ordinality") AS "model_ids"
  FROM ranked_models AS ranked
  WHERE ranked."duplicate_rank" = 1
  GROUP BY ranked."id"
)
UPDATE "image_backend_member" AS member
SET
  "supported_model_ids" = normalized."model_ids",
  "updated_at" = now()
FROM normalized_models AS normalized
WHERE normalized."id" = member."id";
--> statement-breakpoint
WITH normalized_resolutions AS (
  SELECT
    member."id",
    jsonb_object_agg(
      CASE
        WHEN entry."key" ~* '^(firefly-)?nano-banana2($|-)' THEN
          regexp_replace(entry."key", '^(firefly-)?nano-banana2', 'nano-banana-2', 'i')
        ELSE entry."key"
      END,
      entry."value"
      ORDER BY
        CASE
          WHEN entry."key" ~* '^(firefly-)?nano-banana2($|-)' THEN 0
          ELSE 1
        END,
        entry."key"
    ) AS "resolutions"
  FROM "image_backend_member" AS member
  CROSS JOIN LATERAL jsonb_each(
    CASE
      WHEN jsonb_typeof(member."supported_resolutions_by_model"::jsonb) = 'object'
        THEN member."supported_resolutions_by_model"::jsonb
      ELSE '{}'::jsonb
    END
  ) AS entry("key", "value")
  GROUP BY member."id"
)
UPDATE "image_backend_member" AS member
SET
  "supported_resolutions_by_model" = normalized."resolutions"::json,
  "updated_at" = now()
FROM normalized_resolutions AS normalized
WHERE normalized."id" = member."id";
--> statement-breakpoint
WITH normalized_groups AS (
  SELECT
    group_row."id",
    jsonb_set(
      group_row."metadata"::jsonb,
      '{imageCreditOverrides,byModel}',
      (
        SELECT coalesce(
          jsonb_object_agg(
            CASE
              WHEN entry."key" ~* '^(firefly-)?nano-banana2($|-)' THEN
                regexp_replace(entry."key", '^(firefly-)?nano-banana2', 'nano-banana-2', 'i')
              ELSE entry."key"
            END,
            entry."value"
            ORDER BY
              CASE
                WHEN entry."key" ~* '^(firefly-)?nano-banana2($|-)' THEN 0
                ELSE 1
              END,
              entry."key"
          ),
          '{}'::jsonb
        )
        FROM jsonb_each(
          group_row."metadata"::jsonb #> '{imageCreditOverrides,byModel}'
        ) AS entry("key", "value")
      ),
      true
    ) AS "metadata"
  FROM "image_backend_group" AS group_row
  WHERE group_row."metadata" IS NOT NULL
    AND jsonb_typeof(group_row."metadata"::jsonb #> '{imageCreditOverrides,byModel}') = 'object'
)
UPDATE "image_backend_group" AS group_row
SET
  "metadata" = normalized."metadata"::json,
  "updated_at" = now()
FROM normalized_groups AS normalized
WHERE normalized."id" = group_row."id";
--> statement-breakpoint
UPDATE "system_setting" AS setting
SET "value" = jsonb_set(
  setting."value"::jsonb,
  '{byModel}',
  (
    SELECT coalesce(
      jsonb_object_agg(
        CASE
          WHEN entry."key" ~* '^(firefly-)?nano-banana2($|-)' THEN
            regexp_replace(entry."key", '^(firefly-)?nano-banana2', 'nano-banana-2', 'i')
          ELSE entry."key"
        END,
        entry."value"
        ORDER BY
          CASE
            WHEN entry."key" ~* '^(firefly-)?nano-banana2($|-)' THEN 0
            ELSE 1
          END,
          entry."key"
      ),
      '{}'::jsonb
    )
    FROM jsonb_each(setting."value"::jsonb -> 'byModel') AS entry("key", "value")
  ),
  true
)::json
WHERE setting."key" = 'IMAGE_MODEL_CREDIT_PRICES'
  AND jsonb_typeof(setting."value"::jsonb -> 'byModel') = 'object';
--> statement-breakpoint
UPDATE "system_setting" AS setting
SET "value" = jsonb_set(
  setting."value"::jsonb,
  '{imageByModel}',
  (
    SELECT coalesce(
      jsonb_object_agg(
        CASE
          WHEN entry."key" ~* '^(firefly-)?nano-banana2($|-)' THEN
            regexp_replace(entry."key", '^(firefly-)?nano-banana2', 'nano-banana-2', 'i')
          ELSE entry."key"
        END,
        entry."value"
        ORDER BY
          CASE
            WHEN entry."key" ~* '^(firefly-)?nano-banana2($|-)' THEN 0
            ELSE 1
          END,
          entry."key"
      ),
      '{}'::jsonb
    )
    FROM jsonb_each(setting."value"::jsonb -> 'imageByModel') AS entry("key", "value")
  ),
  true
)::json
WHERE setting."key" = 'MODEL_MARKETPLACE_CONFIG'
  AND jsonb_typeof(setting."value"::jsonb -> 'imageByModel') = 'object';
--> statement-breakpoint
UPDATE "generation"
SET
  "model" = regexp_replace(
    "model",
    '^(firefly-)?nano-banana2',
    'nano-banana-2',
    'i'
  )
  WHERE "model" ~* '^(firefly-)?nano-banana2($|-)';
--> statement-breakpoint
UPDATE "video_generation"
SET
  "model" = regexp_replace(
    "model",
    '^(firefly-)?nano-banana2',
    'nano-banana-2',
    'i'
  ),
  "updated_at" = now()
WHERE "model" ~* '^(firefly-)?nano-banana2($|-)';
