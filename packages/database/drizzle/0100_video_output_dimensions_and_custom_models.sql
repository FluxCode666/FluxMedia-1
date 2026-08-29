-- 对齐 video_generation 当前运行时 schema，并允许管理员注册的 custom 视频模型。
--
-- output_width/output_height 是创建时冻结的执行事实，不能依赖恢复时重新推导。
-- 先以可空列扩展、按公开分辨率目录回填，再收紧为 NOT NULL；未知历史组合明确阻断迁移，
-- 防止用猜测尺寸污染账单、供应商请求和恢复任务。
ALTER TABLE "video_generation"
  ADD COLUMN IF NOT EXISTS "output_width" integer,
  ADD COLUMN IF NOT EXISTS "output_height" integer;

UPDATE "video_generation" AS video
SET
  "output_width" = dimensions.width,
  "output_height" = dimensions.height
FROM (
  VALUES
    ('480p', '1:1', 480, 480),
    ('480p', '4:3', 640, 480),
    ('480p', '3:4', 480, 640),
    ('480p', '16:9', 854, 480),
    ('480p', '9:16', 480, 854),
    ('480p', '21:9', 1120, 480),
    ('720p', '1:1', 720, 720),
    ('720p', '4:3', 960, 720),
    ('720p', '3:4', 720, 960),
    ('720p', '16:9', 1280, 720),
    ('720p', '9:16', 720, 1280),
    ('720p', '21:9', 1680, 720),
    ('1080p', '1:1', 1080, 1080),
    ('1080p', '4:3', 1440, 1080),
    ('1080p', '3:4', 1080, 1440),
    ('1080p', '16:9', 1920, 1080),
    ('1080p', '9:16', 1080, 1920),
    ('1080p', '21:9', 2520, 1080),
    ('2k', '1:1', 1440, 1440),
    ('2k', '4:3', 1920, 1440),
    ('2k', '3:4', 1440, 1920),
    ('2k', '16:9', 2560, 1440),
    ('2k', '9:16', 1440, 2560),
    ('2k', '21:9', 3360, 1440),
    ('4k', '1:1', 2160, 2160),
    ('4k', '4:3', 2880, 2160),
    ('4k', '3:4', 2160, 2880),
    ('4k', '16:9', 3840, 2160),
    ('4k', '9:16', 2160, 3840),
    ('4k', '21:9', 5040, 2160),
    ('8k', '1:1', 4320, 4320),
    ('8k', '4:3', 5760, 4320),
    ('8k', '3:4', 4320, 5760),
    ('8k', '16:9', 7680, 4320),
    ('8k', '9:16', 4320, 7680),
    ('8k', '21:9', 10080, 4320)
) AS dimensions(resolution, aspect_ratio, width, height)
WHERE video."resolution" = dimensions.resolution
  AND video."aspect_ratio" = dimensions.aspect_ratio;

DO $migration$
DECLARE
  missing_dimensions_count integer;
BEGIN
  SELECT count(*)::integer
  INTO missing_dimensions_count
  FROM "video_generation"
  WHERE "output_width" IS NULL OR "output_height" IS NULL;

  IF missing_dimensions_count <> 0 THEN
    RAISE EXCEPTION
      '0100 blocked: video output dimensions could not be derived for % rows',
      missing_dimensions_count;
  END IF;
END
$migration$;

ALTER TABLE "video_generation"
  ALTER COLUMN "output_width" SET NOT NULL,
  ALTER COLUMN "output_height" SET NOT NULL;

-- 0098 的 validator 已允许 custom 参考视频/音频；模型约束必须同步允许已注册 custom ID。
-- 注册状态由 UOL/模型广场配置校验，数据库只负责格式、保留字和旧复合视频 ID 的最终边界。
ALTER TABLE "video_generation"
  DROP CONSTRAINT IF EXISTS "video_generation_real_model_check";

ALTER TABLE "video_generation"
  ADD CONSTRAINT "video_generation_real_model_check"
  CHECK (
    "model" IN (
      'sora2', 'sora2-pro', 'veo31', 'veo31-fast', 'veo31-ref',
      'kling-o3', 'kling3', 'kling3-omni', 'runway-gen45',
      'ray314', 'ray314-hdr', 'seedance2', 'seedance2-fast'
    )
    OR (
      char_length("model") BETWEEN 1 AND 120
      AND "model" ~ '^[a-z0-9][a-z0-9._:-]*$'
      AND "model" NOT LIKE 'firefly-%'
      AND "model" NOT IN ('auto', 'unknown')
      AND "model" NOT LIKE 'sora2-%'
      AND "model" NOT LIKE 'veo31-%'
      AND "model" NOT LIKE 'veo31-fast-%'
      AND "model" NOT LIKE 'veo31-ref-%'
      AND "model" NOT LIKE 'kling-o3-%'
      AND "model" NOT LIKE 'kling3-%'
      AND "model" NOT LIKE 'runway-gen45-%'
      AND "model" NOT LIKE 'ray314-%'
      AND "model" NOT LIKE 'seedance2-%'
    )
  );
