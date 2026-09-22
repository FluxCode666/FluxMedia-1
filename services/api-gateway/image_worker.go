package main

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// executeClaimedImage runs under the task execution lock and fencing token.
func (w *mediaWorker) executeClaimedImage(ctx context.Context, id string) error {
	var uid, genID, model, operation string
	var input []byte
	err := w.backend.db.QueryRow(ctx, `SELECT user_id,COALESCE(generation_id,(generation_ids->>0)),operation,generation_inputs FROM image_async_task WHERE id=$1`, id).Scan(&uid, &genID, &operation, &input)
	if err != nil {
		return w.failImage(ctx, id, err)
	}
	// A generation row is the durable source of truth. Re-delivered messages must
	// reconcile an existing terminal generation before making another provider
	// request; this is the same idempotency boundary as the Next worker.
	var generationStatus string
	if err = w.backend.db.QueryRow(ctx, `SELECT status FROM generation WHERE id=$1`, genID).Scan(&generationStatus); err == nil {
		if generationStatus == "completed" || generationStatus == "failed" {
			var tag pgconn.CommandTag
			tag, err = w.backend.db.Exec(ctx, `UPDATE image_async_task SET status=$2,error=CASE WHEN $2='failed' THEN COALESCE(error,'image generation failed') ELSE NULL END,completed_at=COALESCE(completed_at,now()),claim_token=NULL,claim_expires_at=NULL,mq_delivery_due_at=NULL,claim_recovery_due_at=NULL,admission_renewal_due_at=NULL,updated_at=now() WHERE id=$1 AND status NOT IN ('completed','failed')`, id, generationStatus)
			if err == nil && tag.RowsAffected() > 0 {
				_ = w.backend.deliverImageAsyncCallback(ctx, id)
			}
			return err
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return w.failImage(ctx, id, err)
	}
	var persisted any
	if json.Unmarshal(input, &persisted) != nil {
		return w.failImage(ctx, id, errors.New("invalid persisted image input"))
	}
	var body map[string]any
	switch value := persisted.(type) {
	case map[string]any:
		body = value
	case []any:
		if len(value) > 0 {
			body, _ = value[0].(map[string]any)
		}
	}
	if body == nil {
		return w.failImage(ctx, id, errors.New("persisted image input must be an object"))
	}
	model, _ = body["model"].(string)
	ctx = w.backend.withImagePreviewPublisher(ctx, id, genID)
	output, pending, err := w.executeImageProviderTask(ctx, id, genID, uid, operation, model, body)
	if err != nil {
		return w.failImage(ctx, id, err)
	}
	if pending {
		return nil
	}
	return w.completeImageOutput(ctx, id, genID, uid, output)
}
func (w *mediaWorker) failImage(ctx context.Context, id string, cause error) error {
	msg := sanitizeWorkerError(cause)
	// Persist generation failure and settle any initial image charge before
	// closing the async task. The source_ref is stable across retries, while the
	// transaction/projection rows are protected by their unique constraints.
	if err := w.failImageGeneration(ctx, id, msg, cause); err != nil {
		return err
	}
	_, err := w.backend.db.Exec(ctx, `UPDATE image_async_task SET status='failed',error=$2,completed_at=now(),claim_token=NULL,claim_expires_at=NULL,mq_delivery_due_at=NULL,claim_recovery_due_at=NULL,admission_renewal_due_at=NULL,updated_at=now() WHERE id=$1 AND status<>'completed'`, id, msg)
	if err == nil {
		_ = w.backend.deliverImageAsyncCallback(ctx, id)
	}
	return err
}

func (w *mediaWorker) failImageGeneration(ctx context.Context, taskID, reason string, causes ...error) error {
	tx, err := w.backend.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)
	var generationID, userID, status, token string
	if err = tx.QueryRow(ctx, `SELECT COALESCE(generation_id,(generation_ids->>0)),user_id,status,COALESCE(claim_token,'') FROM image_async_task WHERE id=$1 FOR UPDATE`, taskID).Scan(&generationID, &userID, &status, &token); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	}
	if claim, ok := ctx.Value(imageWorkerClaimKey{}).(string); ok && claim != token {
		return errImageClaimLost
	}
	var amount float64
	var createdAt time.Time
	var metadataRaw []byte
	if err = tx.QueryRow(ctx, `SELECT user_id,status,COALESCE(credits_consumed,0),created_at,COALESCE(metadata,'{}'::json) FROM generation WHERE id=$1 FOR UPDATE`, generationID).Scan(&userID, &status, &amount, &createdAt, &metadataRaw); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return tx.Commit(ctx)
		}
		return err
	}
	if status == "completed" || status == "failed" {
		return tx.Commit(ctx)
	}
	var metadata map[string]any
	if err = json.Unmarshal(metadataRaw, &metadata); err != nil {
		return err
	}
	if metadata == nil {
		metadata = map[string]any{}
	}
	var cause error
	if len(causes) > 0 {
		cause = causes[0]
	}
	retained := imageFailureRetainedCredits(cause, amount, metadata)
	refundAmount := creditRound(amount - retained)
	if refundAmount > 0 {
		if _, err = w.backend.refundImageGenerationTx(ctx, tx, generationID, userID, refundAmount, createdAt, metadata, generationID+":worker-refund", "图片生成失败退款"); err != nil {
			return err
		}
	}

	metadata["billingSettlement"] = map[string]any{"chargedCredits": amount, "retainedCredits": retained, "refundedCredits": refundAmount}
	if _, err = tx.Exec(ctx, `UPDATE generation SET status='failed',error=$2,credits_consumed=$3,metadata=$4,completed_at=COALESCE(completed_at,now()) WHERE id=$1 AND status='pending'`, generationID, reason, retained, mustJSON(metadata)); err != nil {
		return err
	}
	if err = mediaSchedulerResultTx(ctx, tx, "image", taskID, "", false, cause, true); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
