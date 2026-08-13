-- 图库成品与视频使用 `(user_id, created_at, id)` 卡片级 keyset；WHERE 条件与页面
-- 完全一致，使首批和深 cursor 都只读取当前用户已完成且有持久产物的有界记录。
CREATE INDEX IF NOT EXISTS "generation_gallery_final_user_created_id_idx"
  ON "generation" ("user_id", "created_at" DESC, "id" DESC)
  WHERE "status" = 'completed' AND "storage_key" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "video_generation_gallery_user_created_id_idx"
  ON "video_generation" ("user_id", "created_at" DESC, "id" DESC)
  WHERE "status" = 'completed' AND "storage_key" IS NOT NULL;

-- 上传图父任务先按用户和创建时间定位，再在单行内有界展开 inputImages 数组。GIN
-- 负责 JSONPath 存在性过滤；父任务索引避免深 cursor 回退为全用户无序扫描。
CREATE INDEX IF NOT EXISTS "generation_gallery_upload_user_created_id_idx"
  ON "generation" ("user_id", "created_at" DESC, "id" DESC)
  WHERE "metadata" IS NOT NULL;
