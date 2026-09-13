package main

// Go-native maintenance scheduler.  The scheduler drives the database-backed
// recovery handlers directly so a running Go backend no longer depends on the
// Next.js process for routine payment, image, or credit maintenance.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5"
)

const (
	maintenanceImageInterval   = 5 * time.Minute
	maintenanceCreditInterval  = 24 * time.Hour
	maintenancePaymentInterval = time.Minute
	maintenanceExportInterval  = time.Hour
	maintenanceMediaInterval   = time.Minute
)

type maintenanceScheduler struct {
	backend *backend
	cancel  context.CancelFunc
	wg      sync.WaitGroup
}

// startMaintenanceScheduler starts the Go-owned maintenance loop.  Set
// GO_BACKEND_SCHEDULER_ENABLED=false during rollout or tests to leave the
// existing external cron owner in control.
func (b *backend) startMaintenanceScheduler(parent context.Context) *maintenanceScheduler {
	if strings.EqualFold(strings.TrimSpace(osGetenv("GO_BACKEND_SCHEDULER_ENABLED")), "false") {
		return nil
	}
	ctx, cancel := context.WithCancel(parent)
	s := &maintenanceScheduler{backend: b, cancel: cancel}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		s.loop(ctx)
	}()
	return s
}

func (s *maintenanceScheduler) close() {
	if s == nil {
		return
	}
	s.cancel()
	s.wg.Wait()
}

func (s *maintenanceScheduler) loop(ctx context.Context) {
	imageTicker := time.NewTicker(maintenanceImageInterval)
	creditTicker := time.NewTicker(maintenanceCreditInterval)
	paymentTicker := time.NewTicker(maintenancePaymentInterval)
	exportTicker := time.NewTicker(maintenanceExportInterval)
	mediaTicker := time.NewTicker(maintenanceMediaInterval)
	defer imageTicker.Stop()
	defer creditTicker.Stop()
	defer paymentTicker.Stop()
	defer exportTicker.Stop()
	defer mediaTicker.Stop()

	// Run payment recovery once at startup; image/credit jobs wait for their
	// configured cadence to avoid a burst immediately after deployment.
	s.runPayment(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-paymentTicker.C:
			s.runPayment(ctx)
		case <-imageTicker.C:
			s.runImages(ctx)
		case <-creditTicker.C:
			s.runCredits(ctx)
		case <-exportTicker.C:
			s.runExports(ctx)
		case <-mediaTicker.C:
			s.runMedia(ctx)
		}
	}
}

// runExports expires completed export objects after their retention window.
// The row remains auditable while the local object is removed before the CAS
// update, so a failed delete never presents a dangling download as expired.
func (s *maintenanceScheduler) runExports(ctx context.Context) {
	rows, err := s.backend.db.Query(ctx, `SELECT id,object_bucket,object_key FROM operations_export_task WHERE status='completed' AND expires_at IS NOT NULL AND expires_at < now() ORDER BY expires_at LIMIT 100`)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var id, bucket, key string
		if err := rows.Scan(&id, &bucket, &key); err != nil {
			return
		}
		if bucket != "" && key != "" {
			path := filepath.Join(s.backend.config.storagePath, bucket, filepath.FromSlash(key))
			if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
				continue
			}
		}
		_, _ = s.backend.db.Exec(ctx, `UPDATE operations_export_task SET status='expired',object_deleted_at=now(),updated_at=now() WHERE id=$1 AND status='completed' AND expires_at < now()`, id)
	}
}

// runMedia repairs durable queue wakeups and runs the two small video side
// queues. PostgreSQL remains the source of truth; Redis only wakes workers.
func (s *maintenanceScheduler) runMedia(ctx context.Context) {
	if _, err := s.backend.recoverMediaQueue(ctx); err != nil {
		return
	}
	_, _ = s.backend.deliverVideoCallbacks(ctx)
	_, _ = s.backend.cleanupVideoInputs(ctx)
}

func (b *backend) recoverMediaQueue(ctx context.Context) (int, error) {
	count := 0
	rows, err := b.db.Query(ctx, `SELECT id FROM image_async_task WHERE status IN ('queued','running') AND (mq_delivery_due_at IS NOT NULL AND mq_delivery_due_at<=now() OR claim_recovery_due_at IS NOT NULL AND claim_recovery_due_at<=now()) ORDER BY COALESCE(mq_delivery_due_at,claim_recovery_due_at),id LIMIT 1000`)
	if err != nil {
		return 0, err
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return count, err
		}
		if b.redis != nil {
			_ = b.redis.Publish(ctx, "fluxmedia:media:wakeup", id).Err()
		}
		count++
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return count, err
	}
	rows.Close()
	videoRows, err := b.db.Query(ctx, `SELECT id FROM video_generation WHERE stage NOT IN ('completed','failed') AND (claim_expires_at IS NULL OR claim_expires_at<=now()) AND ((stage IN ('created','retrying','polling','downloading','refunding') AND (next_poll_at IS NULL OR next_poll_at<=now())) OR (stage IN ('charged','submitting') AND COALESCE(submit_started_at,updated_at)<=now()-interval '10 minutes') OR (stage='submit_uncertain' AND metadata->>'videoBackendProtocol'='api')) ORDER BY COALESCE(next_poll_at,updated_at),created_at,id LIMIT 1000`)
	if err != nil {
		return count, err
	}
	for videoRows.Next() {
		var id string
		if err := videoRows.Scan(&id); err != nil {
			videoRows.Close()
			return count, err
		}
		if b.redis != nil {
			_ = b.redis.Publish(ctx, "fluxmedia:media:wakeup", id).Err()
		}
		count++
	}
	return count, videoRows.Err()
}

// deliverVideoCallbacks claims and delivers a bounded batch. The callback
// record is fenced by claim_token, so a timeout or process crash is retried.
func (b *backend) deliverVideoCallbacks(ctx context.Context) (int, error) {
	var delivered int
	for i := 0; i < 25; i++ {
		token := newRequestID()
		var id, videoID, callbackURL string
		var attempt int
		err := b.db.QueryRow(ctx, `WITH candidate AS (SELECT id FROM video_generation_callback_delivery d JOIN video_generation v ON v.id=d.video_generation_id WHERE v.status IN ('completed','failed') AND d.status IN ('pending','delivering') AND d.next_attempt_at<=now() AND (d.claim_expires_at IS NULL OR d.claim_expires_at<=now()) ORDER BY d.next_attempt_at,d.created_at,d.id LIMIT 1 FOR UPDATE SKIP LOCKED) UPDATE video_generation_callback_delivery d SET status='delivering',attempt_count=d.attempt_count+1,claim_token=$1,claim_expires_at=now()+interval '2 minutes',updated_at=now() FROM candidate WHERE d.id=candidate.id RETURNING d.id,d.video_generation_id,d.callback_url,d.attempt_count`, token).Scan(&id, &videoID, &callbackURL, &attempt)
		if errors.Is(err, pgx.ErrNoRows) {
			break
		}
		if err != nil {
			return delivered, err
		}
		var model, status, stage, prompt, resolution, ratio string
		var duration int
		var credits float64
		var taskErr *string
		var storageKey, storageBucket *string
		if err = b.db.QueryRow(ctx, `SELECT model,status,stage,prompt,resolution,aspect_ratio,duration_seconds,credits_consumed,error,storage_key,storage_bucket FROM video_generation WHERE id=$1`, videoID).Scan(&model, &status, &stage, &prompt, &resolution, &ratio, &duration, &credits, &taskErr, &storageKey, &storageBucket); err != nil {
			return delivered, err
		}
		payload := map[string]any{"id": videoID, "object": "video.task", "status": status, "stage": stage, "model": model, "prompt": prompt, "durationSeconds": duration, "resolution": resolution, "aspectRatio": ratio, "creditsConsumed": credits}
		if taskErr != nil {
			payload["error"] = map[string]any{"message": *taskErr}
		}
		if storageKey != nil && storageBucket != nil && *storageKey != "" {
			base, _ := b.settingString(ctx, "NEXT_PUBLIC_APP_URL", "")
			if base != "" {
				payload["videoUrl"] = strings.TrimRight(base, "/") + "/api/storage/" + url.PathEscape(*storageBucket) + "/" + url.PathEscape(*storageKey)
			}
		}
		body, _ := json.Marshal(payload)
		reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		req, reqErr := http.NewRequestWithContext(reqCtx, http.MethodPost, callbackURL, bytes.NewReader(body))
		if reqErr == nil {
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Idempotency-Key", "video-callback:"+id)
			req.Header.Set("X-Tokens-Callback", "true")
		}
		respErr := reqErr
		if respErr == nil {
			resp, e := (&http.Client{Timeout: 10 * time.Second}).Do(req)
			if e != nil {
				respErr = e
			} else {
				io.Copy(io.Discard, resp.Body)
				resp.Body.Close()
				if resp.StatusCode < 200 || resp.StatusCode >= 300 {
					respErr = fmt.Errorf("video callback returned HTTP %d", resp.StatusCode)
				}
			}
		}
		cancel()
		if respErr == nil {
			if _, err = b.db.Exec(ctx, `UPDATE video_generation_callback_delivery SET status='delivered',delivered_at=now(),claim_token=NULL,claim_expires_at=NULL,last_error=NULL,updated_at=now() WHERE id=$1 AND claim_token=$2`, id, token); err != nil {
				return delivered, err
			}
			delivered++
			continue
		}
		delay := time.Duration(1<<minInt(attempt, 8)) * time.Minute
		if delay > time.Hour {
			delay = time.Hour
		}
		next := time.Now().Add(delay)
		if _, err = b.db.Exec(ctx, `UPDATE video_generation_callback_delivery SET status=CASE WHEN attempt_count>=8 THEN 'dead' ELSE 'pending' END,next_attempt_at=$3,claim_token=NULL,claim_expires_at=NULL,last_error=$4,updated_at=now() WHERE id=$1 AND claim_token=$2`, id, token, next, respErr.Error()); err != nil {
			return delivered, err
		}
	}
	return delivered, nil
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func (b *backend) cleanupVideoInputs(ctx context.Context) (int, error) {
	var deleted int
	for i := 0; i < 25; i++ {
		token := newRequestID()
		var id, userID, videoID, attemptID, key, bucket string
		var count int
		err := b.db.QueryRow(ctx, `WITH expired AS (DELETE FROM video_task_staging_reservation WHERE expires_at<=now() RETURNING task_id), candidate AS (SELECT c.id FROM video_input_cleanup c WHERE c.next_attempt_at<=now() AND (c.claim_expires_at IS NULL OR c.claim_expires_at<=now()) AND ((c.reason='orphan' AND NOT EXISTS (SELECT 1 FROM video_generation v WHERE v.id=c.video_id AND v.user_id=c.user_id)) OR (c.reason='lifecycle_delete' AND EXISTS (SELECT 1 FROM video_generation v JOIN "user" u ON u.id=v.user_id WHERE v.id=c.video_id AND v.user_id=c.user_id AND v.stage IN ('completed','failed') AND u.banned=true AND u.banned_reason='account_deleted'))) AND NOT EXISTS (SELECT 1 FROM video_task_staging_reservation r WHERE r.task_id=c.video_id AND r.user_id=c.user_id AND r.reservation_token=c.attempt_id) ORDER BY c.next_attempt_at,c.created_at,c.id LIMIT 1 FOR UPDATE SKIP LOCKED) UPDATE video_input_cleanup c SET claim_token=$1,claim_expires_at=now()+interval '5 minutes',updated_at=now() FROM candidate WHERE c.id=candidate.id RETURNING c.id,c.user_id,c.video_id,c.attempt_id,c.storage_key,c.storage_bucket,c.attempt_count`, token).Scan(&id, &userID, &videoID, &attemptID, &key, &bucket, &count)
		if errors.Is(err, pgx.ErrNoRows) {
			break
		}
		if err != nil {
			return deleted, err
		}
		delErr := b.deleteStorageObject(ctx, bucket, key)
		if delErr == nil {
			if _, err = b.db.Exec(ctx, `DELETE FROM video_input_cleanup WHERE id=$1 AND claim_token=$2`, id, token); err != nil {
				return deleted, err
			}
			deleted++
			continue
		}
		next := time.Now().Add(time.Duration(1<<minInt(count+1, 10)) * time.Minute)
		if _, err = b.db.Exec(ctx, `UPDATE video_input_cleanup SET attempt_count=attempt_count+1,next_attempt_at=$3,claim_token=NULL,claim_expires_at=NULL,last_error=$4,updated_at=now() WHERE id=$1 AND claim_token=$2`, id, token, next, delErr.Error()); err != nil {
			return deleted, err
		}
	}
	return deleted, nil
}

func (b *backend) deleteStorageObject(ctx context.Context, bucket, key string) error {
	endpoint, err := b.settingString(ctx, "STORAGE_ENDPOINT", "")
	if err != nil {
		return err
	}
	if strings.TrimSpace(endpoint) == "" {
		return os.Remove(filepath.Join(b.config.storagePath, bucket, filepath.FromSlash(key)))
	}
	access, err := b.settingString(ctx, "STORAGE_ACCESS_KEY_ID", "")
	if err != nil {
		return err
	}
	secret, err := b.settingString(ctx, "STORAGE_SECRET_ACCESS_KEY", "")
	if err != nil {
		return err
	}
	region, err := b.settingString(ctx, "STORAGE_REGION", "auto")
	if err != nil {
		return err
	}
	if access == "" || secret == "" {
		return errors.New("storage credentials are not configured")
	}
	cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(region), awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(access, secret, "")))
	if err != nil {
		return err
	}
	client := s3.NewFromConfig(cfg, func(o *s3.Options) { o.UsePathStyle = true; o.BaseEndpoint = aws.String(endpoint) })
	_, err = client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(bucket), Key: aws.String(key)})
	return err
}

func (s *maintenanceScheduler) runPayment(ctx context.Context) {
	// recoverPaymentFulfillments uses SKIP LOCKED leases, so multiple backend
	// instances can safely execute this scan concurrently.
	if _, err := s.backend.recoverPaymentFulfillments(ctx, paymentFulfillmentBatch); err != nil {
		return
	}
}

func (s *maintenanceScheduler) runImages(ctx context.Context) {
	if _, err := s.backend.expireStaleImages(ctx); err != nil {
		return
	}
}

func (s *maintenanceScheduler) runCredits(ctx context.Context) {
	if err := s.backend.expireAllCredits(ctx); err != nil {
		return
	}
}

func (b *backend) expireStaleImages(ctx context.Context) (int64, error) {
	rows, err := b.db.Query(ctx, `SELECT id,user_id,COALESCE(credits_consumed,0),created_at,COALESCE(metadata,'{}'::json) FROM generation WHERE status='pending' AND created_at < now()-interval '20 minutes' ORDER BY created_at LIMIT 100`)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	var expired int64
	for rows.Next() {
		var id, userID string
		var amount float64
		var createdAt time.Time
		var metadataRaw []byte
		if err = rows.Scan(&id, &userID, &amount, &createdAt, &metadataRaw); err != nil {
			return expired, err
		}
		tx, txErr := b.db.Begin(ctx)
		if txErr != nil {
			return expired, txErr
		}
		var changed int64
		err = tx.QueryRow(ctx, `UPDATE generation SET status='failed',error='Generation timed out',completed_at=now(),credits_consumed=0,metadata=COALESCE(metadata,'{}'::jsonb)||$2::jsonb WHERE id=$1 AND status='pending' RETURNING 1`, id, mustJSON(map[string]any{"timeout": map[string]any{"reason": "pending_timeout", "timeoutMs": 20 * 60 * 1000, "refundSourceRef": id + ":timeout-refund"}})).Scan(&changed)
		if errors.Is(err, pgx.ErrNoRows) {
			_ = tx.Rollback(ctx)
			continue
		}
		if err != nil {
			_ = tx.Rollback(ctx)
			return expired, err
		}
		if amount > 0 {
			if err = b.insertGenerationRefund(ctx, tx, id, userID, amount, createdAt, metadataRaw, id+":timeout-refund", "Refund timed out image generation charge"); err != nil {
				_ = tx.Rollback(ctx)
				return expired, err
			}
		}
		if err = tx.Commit(ctx); err != nil {
			return expired, err
		}
		expired += changed
	}
	return expired, rows.Err()
}

// insertGenerationRefund writes the same idempotent ledger and usage projection
// used by the media worker. It runs inside the generation CAS transaction so a
// crash cannot leave a timed-out image marked failed without its refund.
func (b *backend) insertGenerationRefund(ctx context.Context, tx pgx.Tx, id, userID string, amount float64, createdAt time.Time, metadataRaw []byte, sourceRef, description string) error {
	if _, err := tx.Exec(ctx, `INSERT INTO credits_balance(id,user_id) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING`, newRequestID(), userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO credits_batch(id,user_id,amount,remaining,source_type,source_ref,updated_at) VALUES($1,$2,$3,$3,'refund',$4,now()) ON CONFLICT(source_type,source_ref) DO NOTHING`, newRequestID(), userID, amount, sourceRef); err != nil {
		return err
	}
	txID := newRequestID()
	if tag, err := tx.Exec(ctx, `INSERT INTO credits_transaction(id,user_id,type,amount,debit_account,credit_account,description,source_ref,operation_type,operation_id,operation_created_at,metadata,created_at) VALUES($1,$2,'refund',$3,'SYSTEM:generation_refund',$4,$5,$6,'image_generation',$7,$8,$9,now()) ON CONFLICT(user_id,type,source_ref) DO NOTHING`, txID, userID, amount, "WALLET:"+userID, description, sourceRef, id, createdAt, mustJSON(map[string]any{"generationId": id, "sourceRef": sourceRef, "worker": "go-maintenance"})); err != nil {
		return err
	} else if tag.RowsAffected() == 0 {
		return nil
	}
	var gross, refunded float64
	var operationCreatedAt time.Time
	if err := tx.QueryRow(ctx, `SELECT gross_consumed,refunded,operation_created_at FROM credit_usage_operation WHERE user_id=$1 AND operation_type='image_generation' AND operation_id=$2 FOR UPDATE`, userID, id).Scan(&gross, &refunded, &operationCreatedAt); err == nil {
		if !operationCreatedAt.Equal(createdAt) || refunded+amount > gross {
			return fmt.Errorf("image timeout refund operation conflict for %s", id)
		}
		if _, err = tx.Exec(ctx, `INSERT INTO credit_usage_projection_entry(transaction_id,user_id,contribution_kind,amount,operation_type,operation_id,operation_created_at,transaction_created_at) VALUES($1,$2,'refund',$3,'image_generation',$4,$5,now()) ON CONFLICT(transaction_id) DO NOTHING`, txID, userID, amount, id, createdAt); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `UPDATE credit_usage_operation SET refunded=refunded+$3,net_consumed=net_consumed-$3,updated_at=now() WHERE user_id=$1 AND operation_type='image_generation' AND operation_id=$2`, userID, id, amount); err != nil {
			return err
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE credits_balance SET balance=balance+$2,total_earned=total_earned+$2,total_refunded=total_refunded+$2,updated_at=now() WHERE user_id=$1`, userID, amount); err != nil {
		return err
	}
	var meta map[string]any
	_ = json.Unmarshal(metadataRaw, &meta)
	if key, _ := meta["externalApiKeyId"].(string); key != "" {
		if _, err := tx.Exec(ctx, `UPDATE external_api_key SET credits_used=GREATEST(0,credits_used-$3),updated_at=now() WHERE id=$1 AND user_id=$2`, key, userID, amount); err != nil {
			return err
		}
	}
	return nil
}

func (b *backend) expireAllCredits(ctx context.Context) error {
	tx, err := b.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)
	if _, err = tx.Exec(ctx, `WITH expired AS (
		UPDATE credits_batch SET status='expired',updated_at=now()
		WHERE status='active' AND expires_at<now() AND remaining>0
		RETURNING id,user_id,remaining
	), ledger AS (
		INSERT INTO credits_transaction(id,user_id,type,amount,debit_account,credit_account,description,metadata)
		SELECT $1||id,user_id,'expiration',remaining,'WALLET:'||user_id,'SYSTEM:expired',
			'credit batch expired',json_build_object('batchId',id,'expiredAmount',remaining)
		FROM expired RETURNING user_id,amount
	)
	UPDATE credits_balance b SET balance=GREATEST(0,b.balance-COALESCE(
		(SELECT sum(amount) FROM ledger l WHERE l.user_id=b.user_id),0)),updated_at=now()
	WHERE EXISTS (SELECT 1 FROM ledger l WHERE l.user_id=b.user_id)`, newRequestID()); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
