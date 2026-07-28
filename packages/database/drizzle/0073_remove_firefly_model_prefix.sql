-- 将统一成员能力键转换为平台规范裸 ID，并按大小写无关规则保留首次出现的值。
-- WHY：Adobe gateway 的 `firefly-` 仅是上游协议细节，不能继续泄漏到平台调度键。
WITH target_members AS (
  SELECT member.id
  FROM image_backend_member AS member
  WHERE json_typeof(member.supported_model_ids) = 'array'
    AND EXISTS (
      SELECT 1
      FROM json_array_elements_text(member.supported_model_ids) AS item(model_id)
      WHERE lower(item.model_id) LIKE 'firefly-%'
    )
), expanded_models AS (
  SELECT target.id,
         regexp_replace(item.model_id, '^firefly-', '', 'i') AS model_id,
         item.ordinality
  FROM target_members AS target
  INNER JOIN image_backend_member AS member ON member.id = target.id
  CROSS JOIN LATERAL json_array_elements_text(member.supported_model_ids)
    WITH ORDINALITY AS item(model_id, ordinality)
), ranked_models AS (
  SELECT expanded.id,
         expanded.model_id,
         expanded.ordinality,
         row_number() OVER (
           PARTITION BY expanded.id, lower(expanded.model_id)
           ORDER BY expanded.ordinality
         ) AS duplicate_rank
  FROM expanded_models AS expanded
  WHERE expanded.model_id <> ''
), aggregated_models AS (
  SELECT ranked.id,
         json_agg(ranked.model_id ORDER BY ranked.ordinality) AS model_ids
  FROM ranked_models AS ranked
  WHERE ranked.duplicate_rank = 1
  GROUP BY ranked.id
), normalized_members AS (
  SELECT target.id,
         coalesce(aggregated.model_ids, '[]'::json) AS model_ids
  FROM target_members AS target
  LEFT JOIN aggregated_models AS aggregated ON aggregated.id = target.id
)
UPDATE image_backend_member AS member
SET supported_model_ids = normalized.model_ids,
    updated_at = now()
FROM normalized_members AS normalized
WHERE normalized.id = member.id;
--> statement-breakpoint
-- 历史图片记录只修改模型身份，不改变产物、计费或创建时间。
UPDATE generation
SET model = regexp_replace(model, '^firefly-', '', 'i')
WHERE model ~* '^firefly-';
--> statement-breakpoint
-- 视频任务的查询、恢复和调度统一使用裸 ID；上游适配器仍按需补协议前缀。
UPDATE video_generation
SET model = regexp_replace(model, '^firefly-', '', 'i'),
    updated_at = now()
WHERE model ~* '^firefly-';
