package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
)

type imageExpiryOptions struct {
	UserID    string     `json:"userId"`
	Now       *time.Time `json:"now"`
	Limit     int        `json:"limit"`
	TimeoutMS int64      `json:"timeoutMs"`
}
type imageExpiryDetail struct {
	GenerationID    string  `json:"generationId"`
	UserID          string  `json:"userId"`
	CreditsRefunded float64 `json:"creditsRefunded"`
	RefundGranted   bool    `json:"refundGranted"`
}

func (b *backend) handleImagePendingExpiry(w http.ResponseWriter, r *http.Request) error {
	if !b.cronAuthorized(r) {
		return unauthorized()
	}
	var input imageExpiryOptions
	if r.ContentLength != 0 {
		if err := decodeBody(r, &input); err != nil {
			return err
		}
	}
	details, err := b.expirePendingImages(r.Context(), input)
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"success": true, "details": details, "expired": len(details)})
	return nil
}
func (b *backend) expirePendingImages(ctx context.Context, options imageExpiryOptions) ([]imageExpiryDetail, error) {
	if options.Limit == 0 {
		options.Limit = 100
	}
	if options.TimeoutMS == 0 {
		options.TimeoutMS = 20 * 60 * 1000
	}
	if options.Limit < 1 || options.Limit > 1000 || options.TimeoutMS < 1 || options.TimeoutMS > 365*24*60*60*1000 {
		return nil, invalid("Invalid pending image expiry options")
	}
	now := time.Now().UTC()
	if options.Now != nil {
		now = options.Now.UTC()
	}
	cutoff := now.Add(-time.Duration(options.TimeoutMS) * time.Millisecond)
	rows, err := b.db.Query(ctx, `SELECT id FROM generation WHERE status='pending' AND created_at<$1 AND ($2='' OR user_id=$2) ORDER BY created_at,id LIMIT $3`, cutoff, options.UserID, options.Limit)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	details := []imageExpiryDetail{}
	for _, id := range ids {
		detail, err := b.expirePendingImage(ctx, id, cutoff, now, options.TimeoutMS)
		if err != nil {
			return details, err
		}
		if detail != nil {
			details = append(details, *detail)
		}
	}
	return details, nil
}
func (b *backend) expirePendingImage(ctx context.Context, id string, cutoff, now time.Time, timeoutMS int64) (*imageExpiryDetail, error) {
	tx, err := b.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer rollback(tx)
	// Match the worker's task -> generation -> wallet -> batch lock order.
	if _, err = tx.Exec(ctx, `SELECT id FROM image_async_task WHERE generation_id=$1 OR generation_ids::jsonb @> jsonb_build_array($1::text) ORDER BY id FOR UPDATE`, id); err != nil {
		return nil, err
	}
	var uid, status string
	var charged float64
	var created time.Time
	var raw []byte
	err = tx.QueryRow(ctx, `SELECT user_id,status,COALESCE(credits_consumed,0),created_at,COALESCE(metadata,'{}'::json) FROM generation WHERE id=$1 FOR UPDATE`, id).Scan(&uid, &status, &charged, &created, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if status != "pending" || !created.Before(cutoff) {
		return nil, nil
	}
	var meta map[string]any
	if err = json.Unmarshal(raw, &meta); err != nil {
		return nil, err
	}
	if meta == nil {
		meta = map[string]any{}
	}
	retained := imageFailureRetainedCredits(nil, charged, meta)
	amount := creditRound(charged - retained)
	granted := false
	if amount > 0 {
		result, err := b.refundImageGenerationTx(ctx, tx, id, uid, amount, created, meta, id+":timeout-refund", "Refund timed out image generation charge")
		if err != nil {
			return nil, err
		}
		granted = !result.Replayed
	}
	meta["timeout"] = map[string]any{"reason": "pending_timeout", "timeoutMs": timeoutMS, "refundSourceRef": id + ":timeout-refund"}
	meta["billingSettlement"] = map[string]any{"chargedCredits": charged, "retainedCredits": retained, "refundedCredits": amount}
	reason := fmt.Sprintf("Image generation timed out after %s. The image generation fee was refunded; any moderation fee already incurred was retained.", (time.Duration(timeoutMS) * time.Millisecond).String())
	if _, err = tx.Exec(ctx, `UPDATE generation SET status='failed',error=$2,completed_at=$3,credits_consumed=$4,metadata=$5 WHERE id=$1`, id, reason, now, retained, mustJSON(meta)); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `UPDATE image_async_task SET status='failed',error=$2,completed_at=$3,claim_token=NULL,claim_expires_at=NULL,mq_delivery_due_at=NULL,claim_recovery_due_at=NULL,admission_renewal_due_at=NULL,updated_at=$3 WHERE (generation_id=$1 OR generation_ids::jsonb @> jsonb_build_array($1::text)) AND status IN ('queued','running')`, id, reason, now); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &imageExpiryDetail{id, uid, amount, granted}, nil
}

func (b *backend) refundImageGenerationTx(ctx context.Context, tx pgx.Tx, id, uid string, amount float64, created time.Time, meta map[string]any, sourceRef, reason string) (creditMutationResult, error) {
	r := (&http.Request{}).WithContext(ctx)
	wallet, err := b.lockCreditWallet(r, tx, uid)
	if err != nil {
		return creditMutationResult{}, err
	}
	result, err := b.grantCreditTx(r, tx, wallet, creditMutation{Operation: "refund", UserID: uid, Amount: amount, SourceRef: sourceRef, OperationType: "image_generation", OperationID: id, OperationCreatedAt: &created, DebitAccount: "SYSTEM:generation_refund", Reason: reason, Metadata: map[string]any{"generationId": id, "worker": "go-media"}})
	if err != nil {
		return result, err
	}
	if key, _ := meta["externalApiKeyId"].(string); key != "" && !result.Replayed {
		_, err = tx.Exec(ctx, `UPDATE external_api_key SET credits_used=GREATEST(0,credits_used-$3),updated_at=now() WHERE id=$1 AND user_id=$2`, key, uid, amount)
	}
	return result, err
}

// Older Go workers wrote an unscoped consumption transaction and a separate
// projection. Only a unique, matching real charge can gain the missing context;
// an absent/mismatched ledger never becomes an invented refundable balance.
func (b *backend) ensureVideoConsumptionContext(ctx context.Context, tx pgx.Tx, uid, id string, amount float64, created time.Time, metadata []byte) error {
	var scoped int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM credits_transaction WHERE user_id=$1 AND type='consumption' AND operation_type='video_generation' AND operation_id=$2`, uid, id).Scan(&scoped); err != nil {
		return err
	}
	if scoped > 0 {
		return nil
	}
	var transactionID string
	var count int
	if err := tx.QueryRow(ctx, `SELECT COALESCE(min(id),''),count(*) FROM credits_transaction WHERE user_id=$1 AND type='consumption' AND source_ref IN ($2,$3) AND amount=$4 AND debit_account='WALLET:'||$1 AND operation_type IS NULL AND operation_id IS NULL AND operation_created_at IS NULL`, uid, id, videoLedgerSourceRef(id, metadata), amount).Scan(&transactionID, &count); err != nil {
		return err
	}
	if count != 1 {
		return creditConflict()
	}
	_, err := tx.Exec(ctx, `UPDATE credits_transaction SET operation_type='video_generation',operation_id=$2,operation_created_at=$3 WHERE id=$1`, transactionID, id, created)
	return err
}
