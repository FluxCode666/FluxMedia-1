-- 视频任务必须保留逻辑 lease ID，过期租约被清理后 worker 才能以同一 ID
-- 做容量感知重建；该字段因此不能外键到生命周期更短的租约行。
ALTER TABLE "video_generation"
  DROP CONSTRAINT IF EXISTS "video_generation_member_lease_id_image_backend_member_lease_id_fk";
