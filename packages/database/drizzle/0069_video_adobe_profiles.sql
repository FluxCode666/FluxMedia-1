-- 持久化视频请求与鉴权 Profile，避免部署后按新目录误读历史任务 Token。
ALTER TABLE video_generation
  ADD COLUMN IF NOT EXISTS adobe_request_profile text,
  ADD COLUMN IF NOT EXISTS adobe_auth_profile text;

-- 未知且仍需恢复的历史模型不能猜测 Profile，否则可能用错误 Token 轮询或重新提交。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM video_generation
    WHERE stage NOT IN ('completed', 'failed')
      AND family NOT IN (
        'sora2',
        'sora2-pro',
        'veo31',
        'veo31-ref',
        'veo31-fast',
        'kling-o3',
        'kling3',
        'kling3-omni',
        'runway-gen45',
        'ray314',
        'ray314-hdr',
        'seedance2',
        'seedance2-fast'
      )
  ) THEN
    RAISE EXCEPTION
      '0069 blocked: unknown non-terminal Adobe video family requires manual profile mapping';
  END IF;
END $$;

-- 0068 以前所有任务都使用 Express Token。Kling Omni、Runway、Ray 系列已使用
-- Firefly 请求头；Seedance 当时仍使用 Express 请求头。新任务由应用显式写入两列。
UPDATE video_generation
SET
  adobe_request_profile = CASE
    WHEN family IN ('kling3-omni', 'runway-gen45', 'ray314', 'ray314-hdr')
      THEN 'firefly'
    -- 未知 family 只可能是无需恢复的终态历史行，统一保守标记为 Express。
    ELSE 'express'
  END,
  adobe_auth_profile = 'express'
WHERE adobe_request_profile IS NULL OR adobe_auth_profile IS NULL;

ALTER TABLE video_generation
  ALTER COLUMN adobe_request_profile SET NOT NULL,
  ALTER COLUMN adobe_auth_profile SET NOT NULL;

ALTER TABLE video_generation
  DROP CONSTRAINT IF EXISTS video_generation_adobe_profile_check;

ALTER TABLE video_generation
  ADD CONSTRAINT video_generation_adobe_profile_check
    CHECK (
      adobe_request_profile IN ('express', 'firefly')
      AND adobe_auth_profile IN ('express', 'firefly')
    );
