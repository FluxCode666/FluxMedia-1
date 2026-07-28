-- 修复尚未提交到 Adobe 的视频任务：Bearer Token 的 IMS client_id 必须与请求端点
-- 对应的网页 Profile 一致。Express 端点继续使用 projectx_webapp，Firefly 3P 端点
-- 使用 clio-playground-web；已进入 submitting 或更后阶段的任务保持原恢复身份。
UPDATE video_generation
SET adobe_auth_profile = adobe_request_profile
WHERE adobe_auth_profile <> adobe_request_profile
  AND stage IN ('created', 'charged');
