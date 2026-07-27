ALTER TABLE "video_generation"
  ADD COLUMN "principal_scope" text;
--> statement-breakpoint
UPDATE "video_generation"
SET "principal_scope" = CASE
  WHEN "api_key_id" IS NOT NULL
    THEN 'external:' || "user_id" || ':' || "api_key_id"
  ELSE 'user:' || "user_id"
END;
--> statement-breakpoint
ALTER TABLE "video_generation"
  ALTER COLUMN "principal_scope" SET NOT NULL,
  ADD CONSTRAINT "video_generation_principal_scope_check"
    CHECK (length(trim("principal_scope")) > 0);
