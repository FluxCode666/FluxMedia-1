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
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	maintenanceImageInterval   = 5 * time.Minute
	maintenanceCreditInterval  = 24 * time.Hour
	maintenancePaymentInterval = time.Minute
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
	// Export generation and retention have independent cadences and workers.
	// A slow CSV upload cannot delay payment recovery or expiry cleanup.
	for _, retention := range []bool{false, true} {
		s.wg.Add(1)
		go func(retention bool) {
			defer s.wg.Done()
			s.loopOperationsExports(ctx, retention)
		}(retention)
	}
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
	mediaTicker := time.NewTicker(maintenanceMediaInterval)
	defer imageTicker.Stop()
	defer creditTicker.Stop()
	defer paymentTicker.Stop()
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
		case <-mediaTicker.C:
			s.runMedia(ctx)
		}
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
		err := b.db.QueryRow(ctx, `WITH candidate AS (SELECT d.id FROM video_generation_callback_delivery d JOIN video_generation v ON v.id=d.video_generation_id WHERE v.status IN ('completed','failed') AND d.status IN ('pending','delivering') AND d.next_attempt_at<=now() AND (d.claim_expires_at IS NULL OR d.claim_expires_at<=now()) ORDER BY d.next_attempt_at,d.created_at,d.id LIMIT 1 FOR UPDATE SKIP LOCKED) UPDATE video_generation_callback_delivery d SET status='delivering',attempt_count=d.attempt_count+1,claim_token=$1,claim_expires_at=now()+interval '2 minutes',updated_at=now() FROM candidate WHERE d.id=candidate.id RETURNING d.id,d.video_generation_id,d.callback_url,d.attempt_count`, token).Scan(&id, &videoID, &callbackURL, &attempt)
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

func (s *maintenanceScheduler) runPayment(ctx context.Context) {
	// recoverPaymentFulfillments uses SKIP LOCKED leases, so multiple backend
	// instances can safely execute this scan concurrently.
	if _, err := s.backend.recoverPaymentFulfillments(ctx, paymentFulfillmentBatch); err != nil {
		return
	}
}

func (s *maintenanceScheduler) runImages(ctx context.Context) {
	if err := s.backend.cleanupImageRepairObjects(ctx); err != nil {
		s.backend.logger.WarnContext(ctx, "image repair cleanup failed", "error", err)
	}
	if err := s.backend.cleanupModelConfigurationCovers(ctx); err != nil {
		s.backend.logger.ErrorContext(ctx, "model cover cleanup failed")
	}
	if _, err := s.backend.runImageRetention(ctx, imageRetentionOptions{}); err != nil {
		s.backend.logger.ErrorContext(ctx, "image retention failed", "error", err)
	}
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
	details, err := b.expirePendingImages(ctx, imageExpiryOptions{})
	return int64(len(details)), err
}

func (b *backend) expireAllCredits(ctx context.Context) error {
	_, _, err := b.processExpiredCredits(ctx)
	return err
}
