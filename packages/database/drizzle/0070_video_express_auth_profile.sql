-- 修复 15d70961 创建但尚未提交到 Adobe 的视频任务：请求头仍按模型网页入口选择，
-- Bearer Token 统一恢复为原有 Express IMS 凭据。已进入 submitting 或已被上游接受的
-- 任务保留创建时 Profile，避免部署迁移改变结果不确定任务的恢复身份。
UPDATE video_generation
SET adobe_auth_profile = 'express'
WHERE adobe_auth_profile = 'firefly'
  AND stage IN ('created', 'charged');
