-- 将 Kling 3.0 官网新协议的规范组合追加到已有 Adobe direct 成员。
-- 旧 ID 保留用于兼容历史客户端；仅匹配原本声明过 Kling 3.0 的成员，避免扩大
-- 未配置该模型的成员能力范围。规范目录为 13 个时长 × 2 个比例 × 2 个分辨率。
WITH canonical_models AS (
  SELECT format('firefly-kling3-%ss-%s-%s', duration, ratio, resolution) AS model_id,
         row_number() OVER (ORDER BY duration, ratio, resolution) AS ordinal
  FROM generate_series(3, 15) AS durations(duration)
  CROSS JOIN (VALUES ('16x9'), ('9x16')) AS ratios(ratio)
  CROSS JOIN (VALUES ('1080p'), ('720p')) AS resolutions(resolution)
), target_models AS (
  SELECT member.id,
         jsonb_agg(models.model_id ORDER BY models.ordinal, models.model_id)::json AS supported_model_ids
  FROM image_backend_member AS member
  INNER JOIN image_backend_member_adobe_config AS adobe
    ON adobe.member_id = member.id
   AND adobe.mode = 'direct'
  CROSS JOIN LATERAL (
    SELECT existing.model_id, existing.ordinal::bigint AS ordinal
    FROM jsonb_array_elements_text(member.supported_model_ids::jsonb)
      WITH ORDINALITY AS existing(model_id, ordinal)
    UNION ALL
    SELECT canonical.model_id, 100000 + canonical.ordinal
    FROM canonical_models AS canonical
    WHERE NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(member.supported_model_ids::jsonb) AS current_model(model_id)
      WHERE current_model.model_id = canonical.model_id
    )
  ) AS models
  WHERE member.type = 'adobe'
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(member.supported_model_ids::jsonb) AS legacy_model(model_id)
      WHERE lower(legacy_model.model_id) ~
        '^(firefly-)?kling3-(5|10|15)s-(16x9|9x16)$'
    )
  GROUP BY member.id
)
UPDATE image_backend_member AS member
SET supported_model_ids = target.supported_model_ids,
    updated_at = now()
FROM target_models AS target
WHERE target.id = member.id;

-- 仍在创建或扣费阶段的 Kling 3.0 任务必须使用 Firefly 请求和鉴权 Profile；
-- 已提交到 Adobe 的任务保留原 Profile，避免恢复时改变上游身份。
UPDATE video_generation
SET adobe_request_profile = 'firefly',
    adobe_auth_profile = 'firefly'
WHERE family = 'kling3'
  AND stage IN ('created', 'charged');
