-- Leonardo 的异步图片上游只接受下列三种像素尺寸。这里的配置集可由供应商
-- 显式选择，把公开的 resolution + aspectRatio 转换成上游 size；未选择的供应商
-- 仍保持参数原样透传。
--
-- 不覆盖管理员可能已创建的同名配置或映射：部署前已有内容时只补充缺失项。
INSERT INTO "image_size_config" ("id", "name")
VALUES ('system-image-size-config-leonardo', 'Leonardo')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "image_size_config_mapping" (
  "id",
  "config_id",
  "resolution",
  "aspect_ratio",
  "size"
)
SELECT
  'system-image-size-config-leonardo-1k-1x1',
  config."id",
  '1K',
  '1:1',
  '1024x1024'
FROM "image_size_config" AS config
WHERE config."name" = 'Leonardo'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "image_size_config_mapping" (
  "id",
  "config_id",
  "resolution",
  "aspect_ratio",
  "size"
)
SELECT
  'system-image-size-config-leonardo-1k-16x9',
  config."id",
  '1K',
  '16:9',
  '1792x1024'
FROM "image_size_config" AS config
WHERE config."name" = 'Leonardo'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "image_size_config_mapping" (
  "id",
  "config_id",
  "resolution",
  "aspect_ratio",
  "size"
)
SELECT
  'system-image-size-config-leonardo-1k-9x16',
  config."id",
  '1K',
  '9:16',
  '1024x1792'
FROM "image_size_config" AS config
WHERE config."name" = 'Leonardo'
ON CONFLICT DO NOTHING;
