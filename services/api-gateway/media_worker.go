package main

// Go media worker. PostgreSQL remains the durable queue and state machine; Redis
// is used as a wake-up channel when producers publish a media task. The worker
// also polls periodically so a lost wake-up never loses a task.

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"
)

const (
	mediaWorkerPollInterval = 2 * time.Second
	mediaWorkerClaimTTL     = 15 * time.Minute
	mediaWorkerMaxResponse  = 16 << 20
)

type mediaWorker struct {
	backend *backend
	cancel  context.CancelFunc
	wg      sync.WaitGroup
}

func (b *backend) startMediaWorker(parent context.Context) *mediaWorker {
	// The Go executor is opt-in until every provider protocol and billing CAS is
	// enabled in production. This guard prevents a partial worker from stealing
	// tasks from the still-authoritative Next worker during rollout.
	if !strings.EqualFold(strings.TrimSpace(osGetenv("GO_MEDIA_WORKER_ENABLED")), "true") {
		return nil
	}
	ctx, cancel := context.WithCancel(parent)
	w := &mediaWorker{backend: b, cancel: cancel}
	w.wg.Add(1)
	go func() { defer w.wg.Done(); w.loop(ctx) }()
	return w
}
func (w *mediaWorker) close() {
	if w == nil {
		return
	}
	w.cancel()
	w.wg.Wait()
}
func (w *mediaWorker) loop(ctx context.Context) {
	ticker := time.NewTicker(mediaWorkerPollInterval)
	defer ticker.Stop()
	var wakeup <-chan *redis.Message
	var pubsub *redis.PubSub
	if w.backend.redis != nil {
		pubsub = w.backend.redis.Subscribe(ctx, "fluxmedia:media:wakeup")
		defer pubsub.Close()
		wakeup = pubsub.Channel()
	}
	for {
		w.runOnce(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-wakeup:
		}
	}
}
func (w *mediaWorker) runOnce(ctx context.Context) {
	// A bounded batch prevents a single noisy tenant from starving other tasks.
	for i := 0; i < 8; i++ {
		id, kind, err := w.claimNext(ctx)
		if err != nil || id == "" {
			return
		}
		if kind == "image" {
			_ = w.processImage(ctx, id)
		} else {
			_ = w.processVideo(ctx, id)
		}
	}
}
func (w *mediaWorker) claimNext(ctx context.Context) (string, string, error) {
	var id string
	// Claiming is deliberately an atomic UPDATE ... FOR UPDATE SKIP LOCKED. The
	// previous select-then-update window allowed multiple Go workers to perform
	// provider calls for the same task before one of them observed RowsAffected=0.
	if err := w.backend.db.QueryRow(ctx, `WITH candidate AS (
		SELECT id FROM image_async_task
		WHERE status='queued' OR (status='running' AND claim_expires_at<now())
		ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
	)
	UPDATE image_async_task AS task
	SET status='running',claim_token=$1,claim_expires_at=now()+$2::interval,
		attempt_count=task.attempt_count+1,started_at=COALESCE(task.started_at,now()),updated_at=now()
	FROM candidate WHERE task.id=candidate.id
	RETURNING task.id`, newWorkerToken(), mediaWorkerClaimTTL.String()).Scan(&id); err == nil {
		return id, "image", nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return "", "", err
	}
	/*
		Only charged or later stages are eligible for this worker. Stage=created
		still belongs to the Next admission/quote path; claiming it here would
		bypass the immutable billing snapshot and is therefore unsafe.
	*/
	if err := w.backend.db.QueryRow(ctx, `WITH candidate AS (
		SELECT id FROM video_generation
		WHERE (stage IN ('charged','submitting','retrying','polling','downloading','refunding')
		   OR (stage='failed' AND COALESCE(credits_consumed,0)>0 AND refund_exhausted_at IS NULL))
		  AND (claim_expires_at IS NULL OR claim_expires_at<now())
		  AND (next_poll_at IS NULL OR next_poll_at<=now() OR stage IN ('refunding','failed'))
		ORDER BY COALESCE(next_poll_at,created_at),created_at,id
		LIMIT 1 FOR UPDATE SKIP LOCKED
	)
	UPDATE video_generation AS task
	SET status='processing',claim_token=$1,claim_expires_at=now()+$2::interval,
		updated_at=now(),state_version=task.state_version+1
	FROM candidate WHERE task.id=candidate.id
	RETURNING task.id`, newWorkerToken(), mediaWorkerClaimTTL.String()).Scan(&id); err == nil {
		return id, "video", nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return "", "", err
	}
	/*
		The old code below used a second non-atomic UPDATE for video rows. Keep no
		fallback claim path: a failed atomic claim is equivalent to an empty queue.
	*/
	return "", "", nil
}
func newWorkerToken() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("worker-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b[:])
}

// processImage executes the persisted image request against the configured API
// pool member and stores the resulting object. Failures are terminal only after
// the bounded claim retry window, preserving the Next worker's old semantics.
func (w *mediaWorker) processImage(ctx context.Context, id string) error {
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
			_, err = w.backend.db.Exec(ctx, `UPDATE image_async_task SET status=$2,error=CASE WHEN $2='failed' THEN COALESCE(error,'image generation failed') ELSE NULL END,completed_at=COALESCE(completed_at,now()),claim_token=NULL,claim_expires_at=NULL,updated_at=now() WHERE id=$1 AND status<>'completed'`, id, generationStatus)
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
	cfg, err := w.backend.pickProvider(ctx, model, "images.generate")
	if err != nil {
		return w.failImage(ctx, id, err)
	}
	output, err := w.backend.callProvider(ctx, cfg, "images.generate", body, id, model)
	if err != nil {
		return w.failImage(ctx, id, err)
	}
	imageURL := extractMediaURL(output)
	if imageURL == "" {
		return w.failImage(ctx, id, errors.New("image provider response omitted output URL"))
	}
	data, ct, err := downloadMedia(ctx, imageURL)
	if err != nil {
		return w.failImage(ctx, id, err)
	}
	_, bucket, err := w.backend.storageBuckets(ctx)
	if err != nil {
		return w.failImage(ctx, id, err)
	}
	key := fmt.Sprintf("%s/generations/%s/%s", uid, genID, newWorkerToken())
	if err = w.backend.putStorageObject(ctx, bucket, key, data, ct); err != nil {
		return w.failImage(ctx, id, err)
	}
	_, err = w.backend.db.Exec(ctx, `UPDATE generation SET status='completed',storage_key=$2,storage_bucket=$3,completed_at=now(),metadata=COALESCE(metadata,'{}'::jsonb)||$4::jsonb WHERE id=$1 AND status='pending'`, genID, key, bucket, mustJSON(map[string]any{"imageUrl": "/api/storage/" + url.PathEscape(bucket) + "/" + url.PathEscape(key)}))
	if err != nil {
		return err
	}
	_, err = w.backend.db.Exec(ctx, `UPDATE image_async_task SET status='completed',completed_at=now(),claim_token=NULL,claim_expires_at=NULL,updated_at=now() WHERE id=$1`, id)
	return err
}
func (w *mediaWorker) failImage(ctx context.Context, id string, cause error) error {
	msg := sanitizeWorkerError(cause)
	// Persist generation failure and settle any initial image charge before
	// closing the async task. The source_ref is stable across retries, while the
	// transaction/projection rows are protected by their unique constraints.
	if err := w.failImageGeneration(ctx, id, msg); err != nil {
		return err
	}
	_, err := w.backend.db.Exec(ctx, `UPDATE image_async_task SET status='failed',error=$2,completed_at=now(),claim_token=NULL,claim_expires_at=NULL,updated_at=now() WHERE id=$1 AND status<>'completed'`, id, msg)
	return err
}

func (w *mediaWorker) failImageGeneration(ctx context.Context, taskID, reason string) error {
	tx, err := w.backend.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)
	var generationID, userID, status string
	var amount float64
	var createdAt time.Time
	var metadataRaw []byte
	if err = tx.QueryRow(ctx, `SELECT COALESCE(generation_id,(generation_ids->>0)),user_id,status FROM image_async_task WHERE id=$1 FOR UPDATE`, taskID).
		Scan(&generationID, &userID, &status); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	}
	// Reload the authoritative generation row and tolerate a missing legacy row.
	if err = tx.QueryRow(ctx, `SELECT user_id,status,COALESCE(credits_consumed,0),created_at,COALESCE(metadata,'{}'::json) FROM generation WHERE id=$1 FOR UPDATE`, generationID).
		Scan(&userID, &status, &amount, &createdAt, &metadataRaw); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return tx.Commit(ctx)
		}
		return err
	}
	if status == "completed" || status == "failed" {
		return tx.Commit(ctx)
	}
	if _, err = tx.Exec(ctx, `UPDATE generation SET status='failed',error=$2,completed_at=COALESCE(completed_at,now()) WHERE id=$1 AND status='pending'`, generationID, reason); err != nil {
		return err
	}
	if amount > 0 {
		var external string
		var meta map[string]any
		_ = json.Unmarshal(metadataRaw, &meta)
		external, _ = meta["externalApiKeyId"].(string)
		sourceRef := generationID + ":worker-refund"
		if _, err = tx.Exec(ctx, `INSERT INTO credits_balance(id,user_id) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING`, newRequestID(), userID); err != nil {
			return err
		}
		batchID := newRequestID()
		if tag, e := tx.Exec(ctx, `INSERT INTO credits_batch(id,user_id,amount,remaining,source_type,source_ref,updated_at) VALUES($1,$2,$3,$3,'refund',$4,now()) ON CONFLICT(source_type,source_ref) DO NOTHING`, batchID, userID, amount, sourceRef); e != nil {
			return e
		} else if tag.RowsAffected() == 0 {
			var batchUser string
			var batchAmount float64
			if e = tx.QueryRow(ctx, `SELECT user_id,amount FROM credits_batch WHERE source_type='refund' AND source_ref=$1`, sourceRef).Scan(&batchUser, &batchAmount); e != nil || batchUser != userID || batchAmount != amount {
				if e != nil {
					return e
				}
				return fmt.Errorf("image refund batch conflict for %s", generationID)
			}
		}
		transactionID := newRequestID()
		if tag, e := tx.Exec(ctx, `INSERT INTO credits_transaction(id,user_id,type,amount,debit_account,credit_account,description,source_ref,operation_type,operation_id,operation_created_at,metadata,created_at) VALUES($1,$2,'refund',$3,'SYSTEM:generation_refund',$4,$5,$6,'image_generation',$7,$8,$9,now()) ON CONFLICT(user_id,type,source_ref) DO NOTHING`, transactionID, userID, amount, "WALLET:"+userID, "图片生成失败退款", sourceRef, generationID, createdAt, mustJSON(map[string]any{"generationId": generationID, "worker": "go-media", "sourceRef": sourceRef})); e != nil {
			return e
		} else if tag.RowsAffected() > 0 {
			// Projection may be absent for old rows; when present it must reconcile
			// the operation atomically with the ledger transaction.
			var gross, refunded float64
			var opCreated time.Time
			if e = tx.QueryRow(ctx, `SELECT gross_consumed,refunded,operation_created_at FROM credit_usage_operation WHERE user_id=$1 AND operation_type='image_generation' AND operation_id=$2 FOR UPDATE`, userID, generationID).Scan(&gross, &refunded, &opCreated); e == nil {
				if !opCreated.Equal(createdAt) || refunded+amount > gross {
					return fmt.Errorf("image refund operation conflict for %s", generationID)
				}
				if _, e = tx.Exec(ctx, `INSERT INTO credit_usage_projection_entry(transaction_id,user_id,contribution_kind,amount,operation_type,operation_id,operation_created_at,transaction_created_at) VALUES($1,$2,'refund',$3,'image_generation',$4,$5,now()) ON CONFLICT(transaction_id) DO NOTHING`, transactionID, userID, amount, generationID, createdAt); e != nil {
					return e
				}
				if _, e = tx.Exec(ctx, `UPDATE credit_usage_operation SET refunded=refunded+$3,net_consumed=net_consumed-$3,updated_at=now() WHERE user_id=$1 AND operation_type='image_generation' AND operation_id=$2`, userID, generationID, amount); e != nil {
					return e
				}
			} else if !errors.Is(e, pgx.ErrNoRows) {
				return e
			}
			if _, e = tx.Exec(ctx, `UPDATE credits_balance SET balance=balance+$2,total_earned=total_earned+$2,total_refunded=total_refunded+$2,updated_at=now() WHERE user_id=$1`, userID, amount); e != nil {
				return e
			}
		}
		if external == "" {
			external, _ = meta["externalApiKeyId"].(string)
		}
		if external != "" {
			if _, err = tx.Exec(ctx, `UPDATE external_api_key SET credits_used=GREATEST(0,credits_used-$3),updated_at=now() WHERE id=$1 AND user_id=$2`, external, userID, amount); err != nil {
				return err
			}
		}
	}
	return tx.Commit(ctx)
}

func (w *mediaWorker) processVideo(ctx context.Context, id string) error {
	var uid, model, prompt, pollURL, upstreamJobID, persistedVideoURL, stage string
	var credits float64
	var duration int
	var ratio, resolution string
	var meta []byte
	err := w.backend.db.QueryRow(ctx, `SELECT user_id,model,prompt,duration_seconds,aspect_ratio,resolution,
		COALESCE(poll_url,''),COALESCE(upstream_job_id,''),COALESCE(metadata,'{}'::json),COALESCE(stage,'created'),COALESCE(credits_consumed,0) FROM video_generation WHERE id=$1`, id).
		Scan(&uid, &model, &prompt, &duration, &ratio, &resolution, &pollURL, &upstreamJobID, &meta, &stage, &credits)
	if err != nil {
		return err
	}
	if stage == "refunding" {
		return w.refundVideoTask(ctx, id, "视频任务失败退款")
	}
	if stage == "failed" {
		if credits <= 0 {
			return nil
		}
		return w.refundVideoTask(ctx, id, "视频任务遗留失败状态退款")
	}
	body := map[string]any{"model": model, "prompt": prompt, "duration": duration, "aspectRatio": ratio, "resolution": resolution}
	var stored map[string]any
	_ = json.Unmarshal(meta, &stored)
	var output map[string]any
	var cfg providerConfig
	var cfgErr error
	if stage == "downloading" {
		if err := w.backend.db.QueryRow(ctx, `SELECT COALESCE(video_url,'') FROM video_generation WHERE id=$1`, id).Scan(&persistedVideoURL); err != nil {
			return w.failVideo(ctx, id, err)
		}
		if persistedVideoURL == "" {
			return w.failVideo(ctx, id, errors.New("video download stage omitted output URL"))
		}
		output = map[string]any{"video_url": persistedVideoURL}
	} else {
		cfg, cfgErr = w.backend.pickProvider(ctx, model, "videos.generate")
		if cfgErr != nil {
			return w.failVideo(ctx, id, cfgErr)
		}
		if pollURL == "" && upstreamJobID != "" {
			pollURL = providerPollURL(cfg, upstreamJobID)
		}
		if pollURL != "" {
			output, err = w.backend.queryProvider(ctx, cfg, pollURL, id, model)
		} else {
			output, err = w.backend.callProvider(ctx, cfg, "videos.generate", body, id, model)
		}
	}
	if err != nil {
		return w.failVideo(ctx, id, err)
	}
	videoURL := extractMediaURL(output)
	if videoURL == "" { // accepted async response; retain poll URL and retry on next scan
		if pollURL != "" {
			state := strings.ToLower(extractString(output, "status", "state"))
			if state == "" || state == "pending" || state == "processing" || state == "queued" || state == "running" {
				_, err = w.backend.db.Exec(ctx, `UPDATE video_generation SET stage='polling',status='running',next_poll_at=now()+interval '5 seconds',claim_token=NULL,claim_expires_at=NULL,state_version=state_version+1,updated_at=now() WHERE id=$1 AND stage<>'completed' AND stage<>'failed'`, id)
				return err
			}
			if state == "failed" || state == "error" || state == "rejected" {
				return w.failVideo(ctx, id, errors.New("video provider reported a terminal failure"))
			}
		}
		poll := extractString(output, "poll_url", "pollUrl", "status_url", "statusUrl")
		jobID := extractString(output, "id", "task_id", "taskId", "job_id", "jobId", "operation_name", "operationName")
		if poll == "" && jobID != "" {
			poll = providerPollURL(cfg, jobID)
		}
		if poll != "" {
			_, err = w.backend.db.Exec(ctx, `UPDATE video_generation SET stage='polling',status='running',poll_url=$2,upstream_job_id=$3,next_poll_at=now()+interval '2 seconds',claim_token=NULL,claim_expires_at=NULL,state_version=state_version+1,updated_at=now() WHERE id=$1 AND stage NOT IN ('completed','failed')`, id, poll, jobID)
			return err
		}
		return w.failVideo(ctx, id, errors.New("video provider response omitted output URL"))
	}
	data, ct, err := downloadMedia(ctx, videoURL)
	if err != nil {
		return w.failVideo(ctx, id, err)
	}
	_, bucket, err := w.backend.storageBuckets(ctx)
	if err != nil {
		return w.failVideo(ctx, id, err)
	}
	if _, err = w.backend.db.Exec(ctx, `UPDATE video_generation SET stage='downloading',status='running',video_url=$2,next_poll_at=NULL,state_version=state_version+1,updated_at=now() WHERE id=$1 AND stage NOT IN ('completed','failed')`, id, videoURL); err != nil {
		return err
	}
	key := fmt.Sprintf("%s/videos/%s.mp4", uid, id)
	if err = w.backend.putStorageObject(ctx, bucket, key, data, ct); err != nil {
		return w.failVideo(ctx, id, err)
	}
	_, err = w.backend.db.Exec(ctx, `UPDATE video_generation SET status='completed',stage='completed',storage_key=$2,storage_bucket=$3,video_url=$4,claim_token=NULL,claim_expires_at=NULL,next_poll_at=NULL,completed_at=now(),state_version=state_version+1,updated_at=now() WHERE id=$1 AND stage='downloading'`, id, key, bucket, "/api/storage/"+url.PathEscape(bucket)+"/"+url.PathEscape(key))
	return err
}

func (b *backend) queryProvider(ctx context.Context, cfg providerConfig, rawURL, taskID, model string) (map[string]any, error) {
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil {
		return nil, errors.New("provider returned invalid polling URL")
	}
	base, baseErr := url.Parse(cfg.baseURL)
	if baseErr != nil || base.Host == "" || !strings.EqualFold(u.Host, base.Host) || !strings.EqualFold(u.Scheme, base.Scheme) {
		return nil, errors.New("provider polling URL origin does not match configured provider")
	}
	requestHeaders := make(http.Header)
	if op, ok := cfg.operations["videos.query"].(map[string]any); ok {
		if script, _ := op["requestScript"].(string); strings.TrimSpace(script) != "" {
			client := newScriptRuntimeClient(b.config.scriptRuntimeURL, b.config.scriptRuntimeToken)
			if client == nil {
				return nil, errors.New("media provider query script runtime unavailable")
			}
			queryInput := make(map[string]any)
			for key, values := range u.Query() {
				if len(values) == 1 {
					queryInput[key] = values[0]
				} else {
					queryInput[key] = append([]string(nil), values...)
				}
			}
			raw, scriptErr := client.execute(ctx, scriptRuntimeRequest{
				Script: script, Operation: "videos.query", Stage: "request",
				Input:   map[string]any{"query": queryInput},
				Context: map[string]any{"operation": "videos.query", "stage": "request", "contentType": "application/json", "platformModelId": model, "upstreamModelId": model, "taskId": taskID},
			})
			if scriptErr != nil {
				return nil, scriptErr
			}
			var envelope map[string]any
			if err := json.Unmarshal(raw, &envelope); err != nil || envelope == nil {
				return nil, errors.New("media provider query script returned invalid JSON")
			}
			if query, ok := envelope["query"].(map[string]any); ok {
				values := u.Query()
				for key, value := range query {
					values.Del(key)
					switch item := value.(type) {
					case nil:
					case string:
						values.Set(key, item)
					case []any:
						for _, element := range item {
							if text, ok := element.(string); ok {
								values.Add(key, text)
							}
						}
					case []string:
						for _, text := range item {
							values.Add(key, text)
						}
					}
				}
				u.RawQuery = values.Encode()
			}
			if headers, ok := envelope["headers"].(map[string]any); ok {
				for key, value := range headers {
					if text, ok := value.(string); ok {
						requestHeaders.Set(key, text)
					}
				}
			}
		}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	for key, values := range requestHeaders {
		if len(values) > 0 {
			req.Header.Set(key, values[0])
		}
	}
	if cfg.apiKey != "" {
		if strings.EqualFold(cfg.auth, "api-key") {
			req.Header.Set("x-api-key", cfg.apiKey)
		} else {
			req.Header.Set("Authorization", "Bearer "+cfg.apiKey)
		}
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, mediaWorkerMaxResponse+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > mediaWorkerMaxResponse {
		return nil, errors.New("media provider response too large")
	}
	var output map[string]any
	if err := json.Unmarshal(raw, &output); err != nil {
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return nil, fmt.Errorf("media provider poll HTTP %d", resp.StatusCode)
		}
		return nil, errors.New("media provider poll returned invalid JSON")
	}
	normalized, scriptErr := b.applyProviderResponseScript(ctx, cfg, "videos.query", output, resp.StatusCode, resp.Header, taskID, model)
	if scriptErr != nil {
		return nil, scriptErr
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if _, scripted := cfg.operations["videos.query"].(map[string]any); scripted {
			if op, ok := cfg.operations["videos.query"].(map[string]any); ok {
				if script, _ := op["responseScript"].(string); strings.TrimSpace(script) != "" {
					return normalized, nil
				}
			}
		}
		return nil, fmt.Errorf("media provider poll HTTP %d", resp.StatusCode)
	}
	return normalized, nil
}

// providerPollURL turns an adapter's videos.query path into a fixed-origin URL.
// Task IDs are escaped as one path segment, matching the Next executor's
// `{task_id}` contract and preventing path traversal through an upstream ID.
func providerPollURL(cfg providerConfig, taskID string) string {
	path := "/videos.query/{task_id}"
	if op, ok := cfg.operations["videos.query"].(map[string]any); ok {
		if configured, _ := op["path"].(string); strings.TrimSpace(configured) != "" {
			path = configured
		}
	}
	escaped := url.PathEscape(taskID)
	path = strings.ReplaceAll(path, "{task_id}", escaped)
	path = strings.ReplaceAll(path, "{taskId}", escaped)
	if parsed, err := url.Parse(path); err == nil && parsed.IsAbs() {
		return parsed.String()
	}
	return strings.TrimRight(cfg.baseURL, "/") + "/" + strings.TrimLeft(path, "/")
}
func (w *mediaWorker) failVideo(ctx context.Context, id string, cause error) error {
	reason := sanitizeWorkerError(cause)
	// Persist the refunding stage in its own transaction. If the actual wallet
	// refund then fails, recovery can claim this row without reissuing a provider
	// request or losing the financial obligation.
	tx, err := w.backend.db.Begin(ctx)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE video_generation SET status='failed',stage='refunding',error=$2,next_poll_at=now(),claim_token=NULL,claim_expires_at=NULL,state_version=state_version+1,updated_at=now() WHERE id=$1 AND stage<>'completed'`, id, reason)
	if err != nil {
		_ = tx.Rollback(ctx)
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	return w.refundVideoTask(ctx, id, reason)
}

// videoLedgerSourceRef mirrors getVideoLedgerSourceRef in the Next video
// operation. The metadata namespace is an immutable migration marker; missing
// markers intentionally use the legacy adobe-video prefix for pre-migration
// rows so a retry cannot charge/refund under a second idempotency key.
func videoLedgerSourceRef(id string, metadataRaw []byte) string {
	var metadata map[string]any
	_ = json.Unmarshal(metadataRaw, &metadata)
	if namespace, _ := metadata["videoLedgerNamespace"].(string); namespace == "video" {
		return "video:" + id
	}
	return "adobe-video:" + id
}

// refundVideoTask settles a charged video exactly once and closes the task in
// the same database transaction. The (user_id,type,source_ref) unique index is
// the durable idempotency key used by the Next credit ledger; a worker crash
// before or after commit therefore cannot double-credit the wallet. A failed
// refund leaves stage=refunding and is picked up by claimNext on the next scan.
func (w *mediaWorker) refundVideoTask(ctx context.Context, id, reason string) error {
	tx, err := w.backend.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)

	var userID, stage, apiKeyID string
	var metadataRaw []byte
	var amount, reserved float64
	var createdAt time.Time
	err = tx.QueryRow(ctx, `SELECT user_id,COALESCE(stage,'created'),COALESCE(credits_consumed,0),created_at,
		COALESCE(api_key_id,''),COALESCE(api_key_credits_reserved,0),COALESCE(metadata,'{}'::json)
		FROM video_generation WHERE id=$1 FOR UPDATE`, id).
		Scan(&userID, &stage, &amount, &createdAt, &apiKeyID, &reserved, &metadataRaw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if stage == "completed" {
		return nil
	}

	if amount > 0 {
		// Create the wallet row up front. The row is locked after the operation
		// projection below, matching the shared credit service lock order.
		if _, err = tx.Exec(ctx, `INSERT INTO credits_balance(id,user_id) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING`, newRequestID(), userID); err != nil {
			return err
		}

		sourceRef := videoLedgerSourceRef(id, metadataRaw)
		var existingAmount float64
		existingErr := tx.QueryRow(ctx, `SELECT amount FROM credits_transaction WHERE user_id=$1 AND type='refund' AND source_ref=$2 LIMIT 1`, userID, sourceRef).Scan(&existingAmount)
		if existingErr != nil && !errors.Is(existingErr, pgx.ErrNoRows) {
			return existingErr
		}
		if existingErr == nil {
			if existingAmount != amount {
				return fmt.Errorf("video refund amount conflict for %s", id)
			}
		} else {
			batchID := newRequestID()
			batchTag, batchErr := tx.Exec(ctx, `INSERT INTO credits_batch(id,user_id,amount,remaining,source_type,source_ref,updated_at)
				VALUES($1,$2,$3,$3,'refund',$4,now()) ON CONFLICT(source_type,source_ref) DO NOTHING`, batchID, userID, amount, sourceRef)
			if batchErr != nil {
				return batchErr
			}
			if batchTag.RowsAffected() == 0 {
				var batchUser string
				var storedAmount float64
				if err = tx.QueryRow(ctx, `SELECT user_id,amount FROM credits_batch WHERE source_type='refund' AND source_ref=$1`, sourceRef).Scan(&batchUser, &storedAmount); err != nil {
					return err
				}
				if batchUser != userID || storedAmount != amount {
					return fmt.Errorf("video refund batch conflict for %s", id)
				}
			}
			metadata := mustJSON(map[string]any{"generationId": id, "worker": "go-media", "sourceRef": sourceRef})
			transactionID := newRequestID()
			transactionAt := time.Now().UTC()
			transactionTag, transactionErr := tx.Exec(ctx, `INSERT INTO credits_transaction(id,user_id,type,amount,debit_account,credit_account,description,source_ref,operation_type,operation_id,operation_created_at,metadata,created_at)
				VALUES($1,$2,'refund',$3,'SYSTEM:generation_refund',$4,$5,$6,'video_generation',$7,$8,$9,$10)
				ON CONFLICT(user_id,type,source_ref) DO NOTHING`, transactionID, userID, amount, "WALLET:"+userID, "视频生成失败退款", sourceRef, id, createdAt, metadata, transactionAt)
			if transactionErr != nil {
				return transactionErr
			}
			if transactionTag.RowsAffected() == 0 {
				if err = tx.QueryRow(ctx, `SELECT amount FROM credits_transaction WHERE user_id=$1 AND type='refund' AND source_ref=$2`, userID, sourceRef).Scan(&existingAmount); err != nil {
					return err
				}
				if existingAmount != amount {
					return fmt.Errorf("video refund amount conflict for %s", id)
				}
			} else {
				// Keep the operation projection in the same transaction as the ledger
				// row. Usage dashboards therefore observe the refund atomically with
				// the wallet balance, matching grantCredits in the shared package.
				var grossConsumed, refunded float64
				var operationCreatedAt time.Time
				if err = tx.QueryRow(ctx, `SELECT gross_consumed,refunded,operation_created_at FROM credit_usage_operation WHERE user_id=$1 AND operation_type='video_generation' AND operation_id=$2 FOR UPDATE`, userID, id).Scan(&grossConsumed, &refunded, &operationCreatedAt); err != nil {
					return fmt.Errorf("video refund operation projection: %w", err)
				}
				if !operationCreatedAt.Equal(createdAt) {
					return fmt.Errorf("video refund operation timestamp conflict for %s", id)
				}
				if refunded+amount > grossConsumed {
					return fmt.Errorf("video refund exceeds gross consumption for %s", id)
				}
				if _, err = tx.Exec(ctx, `INSERT INTO credit_usage_projection_entry(transaction_id,user_id,contribution_kind,amount,operation_type,operation_id,operation_created_at,transaction_created_at)
					VALUES($1,$2,'refund',$3,'video_generation',$4,$5,$6) ON CONFLICT(transaction_id) DO NOTHING`, transactionID, userID, amount, id, createdAt, transactionAt); err != nil {
					return err
				}
				if _, err = tx.Exec(ctx, `UPDATE credit_usage_operation SET refunded=refunded+$3,net_consumed=net_consumed-$3,updated_at=$4 WHERE user_id=$1 AND operation_type='video_generation' AND operation_id=$2 AND operation_created_at=$5`, userID, id, amount, transactionAt, createdAt); err != nil {
					return err
				}
				if err = tx.QueryRow(ctx, `SELECT user_id FROM credits_balance WHERE user_id=$1 FOR UPDATE`, userID).Scan(new(string)); err != nil {
					return err
				}
				if _, err = tx.Exec(ctx, `UPDATE credits_balance SET balance=balance+$2,total_earned=total_earned+$2,total_refunded=total_refunded+$2,updated_at=$3 WHERE user_id=$1`, userID, amount, transactionAt); err != nil {
					return err
				}
			}
		}
	}

	// External API keys reserve the same amount as the wallet charge. Clear the
	// persisted reservation only after the key update, so replay can safely retry.
	if reserved > 0 && apiKeyID != "" {
		if _, err = tx.Exec(ctx, `UPDATE external_api_key SET credits_used=GREATEST(0,credits_used-$3),updated_at=now() WHERE id=$1 AND user_id=$2`, apiKeyID, userID, reserved); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `UPDATE video_generation SET api_key_credits_reserved=0 WHERE id=$1 AND api_key_credits_reserved=$2`, id, reserved); err != nil {
			return err
		}
	}
	_, err = tx.Exec(ctx, `UPDATE video_generation SET status='failed',stage='failed',credits_consumed=0,error=$2,claim_token=NULL,claim_expires_at=NULL,next_poll_at=NULL,completed_at=COALESCE(completed_at,now()),refund_attempt_count=LEAST(3,COALESCE(refund_attempt_count,0)+CASE WHEN $3>0 THEN 1 ELSE 0 END),updated_at=now(),state_version=state_version+1 WHERE id=$1 AND stage<>'completed'`, id, reason, amount)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// providerConfig is deliberately limited to the immutable adapter fields. It
// never exposes credentials to callers or logs.
type providerConfig struct {
	baseURL, apiKey, auth string
	operations            map[string]any
}

func (b *backend) pickProvider(ctx context.Context, model, operation string) (providerConfig, error) {
	var apiKey string
	var raw []byte
	err := b.db.QueryRow(ctx, `SELECT c.api_key,v.configuration FROM image_backend_member m JOIN image_backend_member_api_config c ON c.member_id=m.id JOIN image_backend_member_api_adapter_version v ON v.id=c.current_adapter_version_id WHERE m.is_enabled AND m.status<>'error' AND m.supported_model_ids::jsonb @> jsonb_build_array($1::text) ORDER BY m.priority,m.id LIMIT 1`, model).Scan(&apiKey, &raw)
	if err != nil {
		return providerConfig{}, fmt.Errorf("no enabled media provider for model %s", model)
	}
	var cfg map[string]any
	if json.Unmarshal(raw, &cfg) != nil {
		return providerConfig{}, errors.New("invalid media provider configuration")
	}
	base, _ := cfg["baseUrl"].(string)
	if base == "" {
		base, _ = cfg["baseURL"].(string)
	}
	if base == "" {
		return providerConfig{}, errors.New("media provider baseUrl is missing")
	}
	ops, _ := cfg["operations"].(map[string]any)
	auth, _ := cfg["authentication"].(string)
	if auth == "" {
		auth = "bearer"
	}
	return providerConfig{baseURL: strings.TrimRight(base, "/"), apiKey: apiKey, auth: auth, operations: ops}, nil
}
func (b *backend) callProvider(ctx context.Context, cfg providerConfig, operation string, body map[string]any, taskID, model string) (map[string]any, error) {
	path := "/" + operation
	if op, ok := cfg.operations[operation].(map[string]any); ok {
		if p, _ := op["path"].(string); p != "" {
			path = p
		}
	}
	target := cfg.baseURL + "/" + strings.TrimLeft(path, "/")
	payload := any(body)
	if op, ok := cfg.operations[operation].(map[string]any); ok {
		if script, _ := op["requestScript"].(string); strings.TrimSpace(script) != "" {
			c := newScriptRuntimeClient(b.config.scriptRuntimeURL, b.config.scriptRuntimeToken)
			if c == nil {
				return nil, errors.New("media provider request script runtime unavailable")
			}
			raw, e := c.execute(ctx, scriptRuntimeRequest{Script: script, Operation: operation, Stage: "request", Input: map[string]any{"query": map[string]any{}, "body": body}, Context: map[string]any{"operation": operation, "stage": "request", "contentType": "application/json", "platformModelId": model, "upstreamModelId": model, "taskId": taskID}})
			if e != nil {
				return nil, e
			}
			var env map[string]any
			if err := json.Unmarshal(raw, &env); err != nil || env == nil {
				return nil, errors.New("media provider request script returned invalid JSON")
			}
			if x, ok := env["body"].(map[string]any); ok {
				payload = x
			} else {
				// Request scripts may intentionally return the body directly.
				payload = env
			}
		}
	}
	encoded, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(encoded))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if cfg.apiKey != "" {
		if strings.EqualFold(cfg.auth, "api-key") {
			req.Header.Set("x-api-key", cfg.apiKey)
		} else {
			req.Header.Set("Authorization", "Bearer "+cfg.apiKey)
		}
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, mediaWorkerMaxResponse+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > mediaWorkerMaxResponse {
		return nil, errors.New("media provider response too large")
	}
	var out map[string]any
	if err = json.Unmarshal(raw, &out); err != nil {
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return nil, fmt.Errorf("media provider HTTP %d", resp.StatusCode)
		}
		return nil, errors.New("media provider returned invalid JSON")
	}
	normalized, scriptErr := b.applyProviderResponseScript(ctx, cfg, operation, out, resp.StatusCode, resp.Header, taskID, model)
	if scriptErr != nil {
		return nil, scriptErr
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if op, ok := cfg.operations[operation].(map[string]any); ok {
			if script, _ := op["responseScript"].(string); strings.TrimSpace(script) != "" {
				return normalized, nil
			}
		}
		return nil, fmt.Errorf("media provider HTTP %d", resp.StatusCode)
	}
	return normalized, nil
}

// applyProviderResponseScript is the Go equivalent of the Next API-upstream
// response stage. Adapters are allowed to return the stable media contract
// (status/outputs/error) while keeping vendor response shapes out of the
// worker. An empty script preserves the provider JSON unchanged.
func providerResponseHeaders(headers http.Header) map[string]any {
	result := make(map[string]any, len(headers))
	for key, values := range headers {
		if len(values) == 1 {
			result[key] = values[0]
		} else {
			result[key] = append([]string(nil), values...)
		}
	}
	return result
}

func (b *backend) applyProviderResponseScript(ctx context.Context, cfg providerConfig, operation string, body map[string]any, statusCode int, headers http.Header, taskID, model string) (map[string]any, error) {
	op, ok := cfg.operations[operation].(map[string]any)
	if !ok {
		return body, nil
	}
	script, _ := op["responseScript"].(string)
	if strings.TrimSpace(script) == "" {
		return body, nil
	}
	client := newScriptRuntimeClient(b.config.scriptRuntimeURL, b.config.scriptRuntimeToken)
	if client == nil {
		return nil, errors.New("media provider response script runtime unavailable")
	}
	raw, err := client.execute(ctx, scriptRuntimeRequest{
		Script: script, Operation: operation, Stage: "response",
		Input: map[string]any{
			"statusCode": statusCode,
			"headers":    providerResponseHeaders(headers),
			"body":       body,
		},
		Context: map[string]any{
			"operation": operation, "stage": "response",
			"contentType": "application/json", "platformModelId": model,
			"upstreamModelId": model, "taskId": taskID,
		},
	})
	if err != nil {
		return nil, fmt.Errorf("media provider response script: %w", err)
	}
	var normalized map[string]any
	if err := json.Unmarshal(raw, &normalized); err != nil || normalized == nil {
		return nil, errors.New("media provider response script returned invalid JSON")
	}
	return normalized, nil
}
func extractMediaURL(v map[string]any) string {
	for _, k := range []string{"url", "image_url", "imageUrl", "video_url", "videoUrl"} {
		if x := extractString(v, k); x != "" {
			return x
		}
	}
	for _, k := range []string{"data", "images", "outputs", "output", "result"} {
		if x, ok := v[k].([]any); ok {
			for _, item := range x {
				if m, ok := item.(map[string]any); ok {
					if u := extractMediaURL(m); u != "" {
						return u
					}
				}
			}
		}
		if m, ok := v[k].(map[string]any); ok {
			if u := extractMediaURL(m); u != "" {
				return u
			}
		}
	}
	return ""
}
func extractString(v map[string]any, keys ...string) string {
	for _, k := range keys {
		if x, ok := v[k].(string); ok && strings.TrimSpace(x) != "" {
			return strings.TrimSpace(x)
		}
	}
	return ""
}
func downloadMedia(ctx context.Context, rawURL string) ([]byte, string, error) {
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, "", errors.New("provider returned invalid media URL")
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, "", fmt.Errorf("media download HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, mediaWorkerMaxResponse+1))
	if err != nil {
		return nil, "", err
	}
	if len(data) > mediaWorkerMaxResponse {
		return nil, "", errors.New("media output too large")
	}
	ct := resp.Header.Get("Content-Type")
	if ct == "" {
		ct = "application/octet-stream"
	}
	return data, ct, nil
}
func sanitizeWorkerError(err error) string {
	if err == nil {
		return "media task failed"
	}
	s := strings.Map(func(r rune) rune {
		if r < 32 {
			return ' '
		}
		return r
	}, err.Error())
	if len(s) > 500 {
		s = s[:500]
	}
	return s
}
func mustJSON(v any) string    { b, _ := json.Marshal(v); return string(b) }
func osGetenv(k string) string { return os.Getenv(k) }
