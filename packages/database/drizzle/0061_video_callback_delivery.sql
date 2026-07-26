CREATE TABLE "video_generation_callback_delivery" (
  "id" text PRIMARY KEY NOT NULL,
  "video_generation_id" text NOT NULL,
  "callback_url" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp DEFAULT now() NOT NULL,
  "claim_token" text,
  "claim_expires_at" timestamp,
  "last_error" text,
  "delivered_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "video_generation_callback_delivery_video_generation_id_video_generation_id_fk"
    FOREIGN KEY ("video_generation_id") REFERENCES "video_generation"("id")
    ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "video_callback_delivery_status_check"
    CHECK ("status" IN ('pending', 'delivering', 'delivered', 'dead')),
  CONSTRAINT "video_callback_delivery_attempt_count_check"
    CHECK ("attempt_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "video_callback_delivery_video_unique"
  ON "video_generation_callback_delivery" ("video_generation_id");
--> statement-breakpoint
CREATE INDEX "video_callback_delivery_recovery_idx"
  ON "video_generation_callback_delivery"
  ("status", "next_attempt_at", "claim_expires_at");
