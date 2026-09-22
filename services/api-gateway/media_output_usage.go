package main

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

// Called in the transaction that completes the source task. Only a newly
// inserted output event increments the lifetime summary; redelivery is safe.
func recordMediaOutputTx(ctx context.Context, tx pgx.Tx, kind, id string) error {
	var source string
	switch kind {
	case "image":
		source = `SELECT 'image'::output_usage_kind,id,user_id,created_at,GREATEST(1,COALESCE((metadata->'outputImage'->>'billableImageOutputCount')::int,1)),0 FROM generation WHERE id=$1 AND status='completed' AND storage_key IS NOT NULL`
	case "video":
		source = `SELECT 'video'::output_usage_kind,id,user_id,created_at,0,duration_seconds FROM video_generation WHERE id=$1 AND stage='completed' AND duration_seconds>0`
	default:
		return errors.New("invalid output usage kind")
	}
	_, err := tx.Exec(ctx, `WITH inserted AS (
 INSERT INTO user_output_usage_event(output_kind,source_task_id,user_id,operation_created_at,image_count,video_seconds) `+source+`
 ON CONFLICT(output_kind,source_task_id) DO NOTHING RETURNING user_id,image_count,video_seconds
 ) INSERT INTO user_usage_summary(user_id,total_image_count,total_video_seconds)
 SELECT user_id,image_count,video_seconds FROM inserted
 ON CONFLICT(user_id) DO UPDATE SET total_image_count=user_usage_summary.total_image_count+excluded.total_image_count,total_video_seconds=user_usage_summary.total_video_seconds+excluded.total_video_seconds,updated_at=now()`, id)
	return err
}
