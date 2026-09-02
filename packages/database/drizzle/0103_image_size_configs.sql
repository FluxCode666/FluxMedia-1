CREATE TABLE IF NOT EXISTS "image_size_config" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "image_size_config_name_unique" ON "image_size_config" ("name");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "image_size_config_mapping" (
  "id" text PRIMARY KEY NOT NULL,
  "config_id" text NOT NULL REFERENCES "image_size_config"("id") ON DELETE CASCADE,
  "resolution" text NOT NULL,
  "aspect_ratio" text NOT NULL,
  "size" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "image_size_config_mapping_key_unique" ON "image_size_config_mapping" ("config_id", "resolution", "aspect_ratio");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "image_size_config_mapping_config_idx" ON "image_size_config_mapping" ("config_id");
