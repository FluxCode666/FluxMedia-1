package main

// Go media worker. PostgreSQL remains the durable queue and state machine; Redis
// is used as a wake-up channel when producers publish a media task. The worker
// also polls periodically so a lost wake-up never loses a task.

import (
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
	backend   *backend
	cancel    context.CancelFunc
	wg        sync.WaitGroup
	slotsOnce sync.Once
	slots     chan struct{}
}

func (b *backend) startMediaWorker(parent context.Context) *mediaWorker {
	// Go is the sole media worker owner once the migrated backend is running.
	// Keep an explicit false escape hatch for maintenance and local debugging;
	// the default must be enabled so disabling the Next scheduler cannot strand
	// newly-created tasks.
	if strings.EqualFold(strings.TrimSpace(osGetenv("GO_MEDIA_WORKER_ENABLED")), "false") {
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
	w.slotsOnce.Do(func() { w.slots = make(chan struct{}, 8) })
	// A bounded batch prevents a single noisy tenant from starving other tasks.
	for i := 0; i < 8; i++ {
		select {
		case w.slots <- struct{}{}:
		default:
			return
		}
		id, kind, err := w.claimNext(ctx)
		if err != nil || id == "" {
			<-w.slots
			return
		}
		w.wg.Add(1)
		go func() {
			defer w.wg.Done()
			defer func() { <-w.slots }()
			if kind == "image" {
				_ = w.processClaimedImage(ctx, id)
			} else {
				_ = w.processVideo(ctx, id)
			}
		}()
	}
}
func (w *mediaWorker) claimNext(ctx context.Context) (string, string, error) {
	var id string
	if imageID, err := w.claimImageTask(ctx, ""); err != nil || imageID != "" {
		return imageID, "image", err
	}
	// Created tasks already carry the validated immutable billing snapshot.
	if err := w.backend.db.QueryRow(ctx, `WITH candidate AS (
		SELECT id FROM video_generation
		WHERE (stage IN ('created','charged','submitting','submit_uncertain','retrying','polling','downloading','refunding')
		   OR (stage='failed' AND COALESCE(credits_consumed,0)>0 AND refund_exhausted_at IS NULL))
		  AND (claim_expires_at IS NULL OR claim_expires_at<now())
		  AND (next_poll_at IS NULL OR next_poll_at<=now() OR stage IN ('refunding','failed'))
		ORDER BY COALESCE(next_poll_at,created_at),created_at,id
		LIMIT 1 FOR UPDATE SKIP LOCKED
	)
	UPDATE video_generation AS task
	SET status=CASE WHEN task.stage IN ('refunding','failed') THEN 'failed' ELSE 'running' END,claim_token=$1,claim_expires_at=now()+$2::interval,
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

func (w *mediaWorker) processVideo(ctx context.Context, id string) error {
	return w.processDurableVideo(ctx, id)
}

func (b *backend) queryProvider(ctx context.Context, cfg providerConfig, rawURL, taskID, model string) (map[string]any, error) {
	return b.executeVideoProvider(ctx, cfg, "videos.query", rawURL, nil, taskID, model)
}

func providerPollURL(cfg providerConfig, taskID string) string {
	target, err := videoProviderURL(cfg, "videos.query", taskID)
	if err != nil {
		return ""
	}
	return target.String()
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
		r := (&http.Request{}).WithContext(ctx)
		wallet, err := w.backend.lockCreditWallet(r, tx, userID)
		if err != nil {
			return err
		}
		if err = w.backend.ensureVideoConsumptionContext(ctx, tx, userID, id, amount, createdAt, metadataRaw); err != nil {
			return err
		}
		if _, err = w.backend.grantCreditTx(r, tx, wallet, creditMutation{Operation: "refund", UserID: userID, Amount: amount, SourceRef: videoLedgerSourceRef(id, metadataRaw), OperationType: "video_generation", OperationID: id, OperationCreatedAt: &createdAt, DebitAccount: "SYSTEM:generation_refund", Reason: "视频生成失败退款", Metadata: map[string]any{"generationId": id, "worker": "go-media"}}); err != nil {
			return err
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
	if _, err = tx.Exec(ctx, `DELETE FROM image_backend_member_lease WHERE id=$1`, videoWorkerLeaseID(id)); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE video_generation SET status='failed',stage='failed',credits_consumed=0,error=$2,claim_token=NULL,claim_expires_at=NULL,member_lease_id=NULL,member_lease_owner_token=NULL,next_poll_at=NULL,completed_at=COALESCE(completed_at,now()),refund_attempt_count=LEAST(3,COALESCE(refund_attempt_count,0)+CASE WHEN $3>0 THEN 1 ELSE 0 END),updated_at=now(),state_version=state_version+1 WHERE id=$1 AND stage<>'completed'`, id, reason, amount)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// providerConfig is deliberately limited to the immutable adapter fields. It
// never exposes credentials to callers or logs.
type providerConfig struct {
	scheduler             *mediaSchedulerSelection
	memberID              string
	versionID             string
	baseURL, apiKey, auth string
	operations            map[string]any
	adapter               map[string]any
	contentSafetyEnabled  bool
}

func (b *backend) pickProvider(ctx context.Context, model, operation string) (providerConfig, error) {
	var apiKey string
	var raw []byte
	var contentSafetyEnabled bool
	err := b.db.QueryRow(ctx, `SELECT c.api_key,v.configuration,m.content_safety_enabled FROM image_backend_member m JOIN image_backend_member_api_config c ON c.member_id=m.id JOIN image_backend_member_api_adapter_version v ON v.id=c.current_adapter_version_id WHERE m.is_enabled AND m.status<>'error' AND m.supported_model_ids::jsonb @> jsonb_build_array($1::text) ORDER BY m.priority,m.id LIMIT 1`, model).Scan(&apiKey, &raw, &contentSafetyEnabled)
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
	return providerConfig{baseURL: strings.TrimRight(base, "/"), apiKey: apiKey, auth: auth, operations: ops, adapter: cfg, contentSafetyEnabled: contentSafetyEnabled}, nil
}
func (b *backend) callProvider(ctx context.Context, cfg providerConfig, operation string, body map[string]any, taskID, model string) (map[string]any, error) {
	if operation == "images.generate" || operation == "images.edit" {
		return b.callImageProvider(ctx, cfg, operation, body, taskID, model)
	}
	target, err := videoProviderURL(cfg, operation, model)
	if err != nil {
		return nil, err
	}
	return b.executeVideoProvider(ctx, cfg, operation, target.String(), body, taskID, model)
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
	upstreamModel, contentType := imageUpstreamModel(cfg, model), "application/json"
	if strings.HasPrefix(operation, "images.") {
		upstreamModel = imageUpstreamModel(cfg, model)
		if operation == "images.edit" && cfg.adapter["convertReferenceImagesToPublicUrl"] != true {
			contentType = "multipart/form-data"
		}
	}
	raw, err := client.execute(ctx, scriptRuntimeRequest{
		Script: script, Operation: operation, Stage: "response",
		ResponsePermitID: providerResponsePermitID(ctx),
		Input: map[string]any{
			"statusCode": statusCode,
			"headers":    providerResponseHeaders(headers),
			"body":       body,
		},
		Context: map[string]any{
			"operation": operation, "stage": "response",
			"contentType": contentType, "platformModelId": model,
			"upstreamModelId": upstreamModel, "taskId": taskID,
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

func extractImageOutputs(v map[string]any) []map[string]any {
	for _, key := range []string{"data", "images", "outputs", "output", "result"} {
		if values, ok := v[key].([]any); ok {
			result := make([]map[string]any, 0, len(values))
			for _, item := range values {
				m, ok := item.(map[string]any)
				if !ok {
					continue
				}
				u := extractMediaURL(m)
				if u == "" {
					continue
				}
				entry := map[string]any{"imageUrl": u, "role": "final"}
				if revised := extractString(m, "revised_prompt", "revisedPrompt"); revised != "" {
					entry["revisedPrompt"] = revised
				}
				result = append(result, entry)
			}
			if len(result) > 0 {
				return result
			}
		}
		if nested, ok := v[key].(map[string]any); ok {
			if result := extractImageOutputs(nested); len(result) > 0 {
				return result
			}
		}
	}
	return nil
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
	return downloadMediaWithLimit(ctx, rawURL, mediaWorkerMaxResponse)
}
func downloadMediaWithLimit(ctx context.Context, rawURL string, maxBytes int64) ([]byte, string, error) {
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
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	if err != nil {
		return nil, "", err
	}
	if int64(len(data)) > maxBytes {
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
