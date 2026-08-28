ALTER TABLE "image_backend_member"
  ADD COLUMN IF NOT EXISTS "supported_resolutions_by_model" json NOT NULL DEFAULT '{}'::json;
