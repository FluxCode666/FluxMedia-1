package main

import (
	"context"
	"errors"
	"fmt"
	"time"
)

type imageWorkerClaimKey struct{}

var errImageClaimLost = errors.New("image worker claim lost")
var errImageProviderCapacity = errors.New("image provider capacity temporarily unavailable")

// A session advisory lock spans provider I/O. A lease expiry or a duplicate
// system dispatch cannot execute or refund a task still held by another worker.
func (w *mediaWorker) processImage(parent context.Context, id string) error {
	b := w.backend
	conn, err := b.db.Acquire(parent)
	if err != nil {
		return err
	}
	defer conn.Release()
	lock := "image-execute:" + id
	var acquired bool
	if err = conn.QueryRow(parent, `SELECT pg_try_advisory_lock(hashtextextended($1,0))`, lock).Scan(&acquired); err != nil || !acquired {
		return err
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = conn.Exec(ctx, `SELECT pg_advisory_unlock(hashtextextended($1,0))`, lock)
	}()
	var status string
	if err = b.db.QueryRow(parent, `SELECT status FROM image_async_task WHERE id=$1`, id).Scan(&status); err != nil {
		return err
	}
	if status == "completed" || status == "failed" {
		return nil
	}
	token := newWorkerToken()
	tag, err := b.db.Exec(parent, `UPDATE image_async_task SET status='running',claim_token=$2,claim_expires_at=now()+$3::interval,started_at=COALESCE(started_at,now()),updated_at=now() WHERE id=$1 AND status IN ('queued','running')`, id, token, mediaWorkerClaimTTL.String())
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return nil
	}
	ctx, cancel := context.WithCancel(context.WithValue(parent, imageWorkerClaimKey{}, token))
	done := make(chan struct{})
	go func() {
		defer close(done)
		timer := time.NewTicker(time.Minute)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
				tag, err := b.db.Exec(ctx, `UPDATE image_async_task SET claim_expires_at=now()+$3::interval WHERE id=$1 AND claim_token=$2 AND status='running' AND claim_expires_at>now()`, id, token, mediaWorkerClaimTTL.String())
				if err != nil || tag.RowsAffected() != 1 {
					cancel()
					return
				}
				if _, err = b.db.Exec(ctx, `UPDATE image_backend_member_lease SET expires_at=now()+$3::interval,updated_at=now() WHERE id=$1 AND owner_token=$2`, "go-image:"+id, token, mediaWorkerClaimTTL.String()); err != nil {
					cancel()
					return
				}
			}
		}
	}()
	err = w.executeClaimedImage(ctx, id)
	cancel()
	<-done
	cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	_, releaseErr := b.db.Exec(cleanup, `UPDATE image_async_task SET claim_token=NULL,claim_expires_at=NULL,mq_delivery_due_at=CASE WHEN status IN ('completed','failed') THEN NULL ELSE COALESCE(mq_delivery_due_at,now()+interval '5 seconds') END WHERE id=$1 AND claim_token=$2`, id, token)
	// Polling work retains provider capacity until completion or expiry, while
	// local execution capacity is released between polls.
	_, _ = b.db.Exec(cleanup, `DELETE FROM image_backend_member_lease WHERE id=$1 AND owner_token=$2 AND EXISTS(SELECT 1 FROM image_async_task WHERE id=$3 AND status IN ('completed','failed'))`, "go-image:"+id, token, id)
	if err != nil {
		return err
	}
	return releaseErr
}

func (b *backend) acquireImageProviderLease(ctx context.Context, taskID string, cfg providerConfig) error {
	token, _ := ctx.Value(imageWorkerClaimKey{}).(string)
	if token == "" {
		return errors.New("image provider lease requires worker ownership")
	}
	tx, err := b.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)
	if err = assertImageRepairClaim(ctx, tx, taskID); err != nil {
		return err
	}
	var capacity, active int
	if err = tx.QueryRow(ctx, `SELECT concurrency FROM image_backend_member WHERE id=$1 FOR UPDATE`, cfg.memberID).Scan(&capacity); err != nil {
		return err
	}
	leaseID := "go-image:" + taskID
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM image_backend_member_lease WHERE member_id=$1 AND expires_at>now() AND id<>$2`, cfg.memberID, leaseID).Scan(&active); err != nil {
		return err
	}
	if capacity < 1 || active >= capacity {
		if cfg.scheduler != nil {
			if err = recordMediaSchedulerMetric(ctx, tx, "image", "capacity_rejected", "", *cfg.scheduler); err != nil {
				return err
			}
			if err = tx.Commit(ctx); err != nil {
				return err
			}
		}
		return errImageProviderCapacity
	}
	_, err = tx.Exec(ctx, `INSERT INTO image_backend_member_lease(id,member_id,owner_token,expires_at,api_adapter_member_id,api_adapter_version_id) VALUES($1,$2,$3,now()+$4::interval,$2,NULLIF($5,'')) ON CONFLICT(id) DO UPDATE SET owner_token=excluded.owner_token,expires_at=excluded.expires_at,updated_at=now()`, leaseID, cfg.memberID, token, mediaWorkerClaimTTL.String(), cfg.versionID)
	if err != nil {
		return err
	}
	if err = mediaSchedulerAcquiredTx(ctx, tx, "image", taskID, cfg.memberID, cfg.scheduler); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func imageProviderOutputItems(value map[string]any) []map[string]any {
	for _, key := range []string{"data", "images", "outputs", "output", "result"} {
		if items, ok := value[key].([]any); ok {
			var result []map[string]any
			for _, raw := range items {
				if item, ok := raw.(map[string]any); ok && imageProviderHasOutput(item) {
					result = append(result, item)
				}
			}
			if len(result) > 0 {
				return result
			}
		}
		if item, ok := value[key].(map[string]any); ok {
			if results := imageProviderOutputItems(item); len(results) > 0 {
				return results
			}
		}
	}
	if imageProviderHasOutput(value) {
		return []map[string]any{value}
	}
	return nil
}

func (w *mediaWorker) completeImageOutput(ctx context.Context, taskID, generationID, userID string, result map[string]any) error {
	items := imageProviderOutputItems(result)
	if len(items) == 0 || len(items) > 256 {
		return w.failImage(ctx, taskID, errors.New("image provider output count is invalid"))
	}
	_, bucket, err := w.backend.storageBuckets(ctx)
	if err != nil {
		return err
	}
	outputs := make([]map[string]any, 0, len(items))
	adopted := false
	defer func() {
		if !adopted {
			cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			for _, item := range outputs {
				_ = w.backend.deleteStorageObject(cleanup, bucket, extractString(item, "storageKey"))
			}
		}
	}()
	total := 0
	providerData := make([][]byte, len(items))
	for index, item := range items {
		data, _, err := readImageProviderOutput(ctx, item)
		if err != nil {
			return w.failImage(ctx, taskID, err)
		}
		total += len(data)
		if total > imageProviderMaxResponse {
			return w.failImage(ctx, taskID, errors.New("combined image outputs exceed the media limit"))
		}
		providerData[index] = data
	}
	if err = w.backend.recordImageSchedulerResult(ctx, taskID, "", "", true, nil); err != nil {
		return err
	}
	total = 0
	for outputIndex, item := range items {
		data, contentType, err := w.postprocessImageOutput(ctx, taskID, generationID, userID, outputIndex, item, providerData[outputIndex])
		if err != nil {
			return w.failImage(ctx, taskID, err)
		}
		total += len(data)
		if total > imageProviderMaxResponse {
			return w.failImage(ctx, taskID, errors.New("combined image outputs exceed the media limit"))
		}
		key := fmt.Sprintf("%s/generations/%s/%s", userID, generationID, newWorkerToken())
		if err = w.backend.putStorageObject(ctx, bucket, key, data, contentType); err != nil {
			return err
		}
		outputs = append(outputs, map[string]any{"imageUrl": "/api/storage/" + urlPathEscape(bucket) + "/" + urlPathEscape(key), "generationId": generationID, "storageKey": key, "storageBucket": bucket, "revisedPrompt": extractString(item, "revised_prompt", "revisedPrompt"), "role": "final", "outputRole": "final"})
	}
	tx, err := w.backend.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)
	var token, status string
	var valid bool
	if err = tx.QueryRow(ctx, `SELECT COALESCE(claim_token,''),status,COALESCE(claim_expires_at>now(),false) FROM image_async_task WHERE id=$1 FOR UPDATE`, taskID).Scan(&token, &status, &valid); err != nil {
		return err
	}
	claim, _ := ctx.Value(imageWorkerClaimKey{}).(string)
	if claim == "" || token != claim || !valid || status != "running" {
		return errImageClaimLost
	}
	primary := outputs[0]
	metadata := map[string]any{"imageUrl": primary["imageUrl"], "outputImage": map[string]any{"imageUrl": primary["imageUrl"], "imageOutputs": outputs, "billableImageOutputCount": len(outputs)}}
	tag, err := tx.Exec(ctx, `UPDATE generation SET status='completed',storage_key=$2,storage_bucket=$3,revised_prompt=NULLIF($4,''),completed_at=now(),metadata=(COALESCE(metadata::jsonb,'{}'::jsonb)||$5::jsonb)::json WHERE id=$1 AND status='pending'`, generationID, primary["storageKey"], bucket, extractString(primary, "revisedPrompt"), mustJSON(metadata))
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return errImageClaimLost
	}
	if err = recordMediaOutputTx(ctx, tx, "image", generationID); err != nil {
		return err
	}
	if err = mediaSchedulerResultTx(ctx, tx, "image", taskID, "", true, nil); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE image_async_task SET status='completed',error=NULL,completed_at=now(),claim_token=NULL,claim_expires_at=NULL,mq_delivery_due_at=NULL,claim_recovery_due_at=NULL,admission_renewal_due_at=NULL,updated_at=now() WHERE id=$1`, taskID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM image_backend_member_lease WHERE id=$1 AND owner_token=$2`, "go-image:"+taskID, token); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	adopted = true
	_ = w.backend.deliverImageAsyncCallback(ctx, taskID)
	return nil
}
