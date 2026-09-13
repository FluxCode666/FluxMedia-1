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
	for {
		w.runOnce(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
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
	if err := w.backend.db.QueryRow(ctx, `SELECT id FROM image_async_task WHERE status='queued' OR (status='running' AND claim_expires_at<now()) ORDER BY created_at,id LIMIT 1`).Scan(&id); err == nil {
		token := newWorkerToken()
		tag, err := w.backend.db.Exec(ctx, `UPDATE image_async_task SET status='running',claim_token=$2,claim_expires_at=now()+$3::interval,attempt_count=attempt_count+1,started_at=COALESCE(started_at,now()),updated_at=now() WHERE id=$1 AND (status='queued' OR (status='running' AND claim_expires_at<now()))`, id, token, mediaWorkerClaimTTL.String())
		if err != nil {
			return "", "", err
		}
		if tag.RowsAffected() > 0 {
			return id, "image", nil
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return "", "", err
	}
	if err := w.backend.db.QueryRow(ctx, `SELECT id FROM video_generation WHERE status IN ('pending','processing') ORDER BY created_at,id LIMIT 1`).Scan(&id); err == nil {
		tag, err := w.backend.db.Exec(ctx, `UPDATE video_generation SET status='processing',updated_at=now() WHERE id=$1 AND status IN ('pending','processing')`, id)
		if err != nil {
			return "", "", err
		}
		if tag.RowsAffected() > 0 {
			return id, "video", nil
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return "", "", err
	}
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
	err := w.backend.db.QueryRow(ctx, `SELECT user_id,(generation_ids->>0),operation,generation_inputs FROM image_async_task WHERE id=$1`, id).Scan(&uid, &genID, &operation, &input)
	if err != nil {
		return w.failImage(ctx, id, err)
	}
	var body map[string]any
	if json.Unmarshal(input, &body) != nil {
		return w.failImage(ctx, id, errors.New("invalid persisted image input"))
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
	bucket, _, err := w.backend.storageBuckets(ctx)
	if err != nil {
		return w.failImage(ctx, id, err)
	}
	key := fmt.Sprintf("%s/generations/%s/%s", uid, genID, newWorkerToken())
	if err = w.backend.putStorageObject(ctx, bucket, key, data, ct); err != nil {
		return w.failImage(ctx, id, err)
	}
	_, err = w.backend.db.Exec(ctx, `UPDATE generation SET status='completed',storage_key=$2,storage_bucket=$3,completed_at=now(),metadata=COALESCE(metadata,'{}'::jsonb)||$4::jsonb WHERE id=$1`, genID, key, bucket, mustJSON(map[string]any{"imageUrl": "/api/storage/" + url.PathEscape(bucket) + "/" + url.PathEscape(key)}))
	if err != nil {
		return err
	}
	_, err = w.backend.db.Exec(ctx, `UPDATE image_async_task SET status='completed',completed_at=now(),claim_token=NULL,claim_expires_at=NULL,updated_at=now() WHERE id=$1`, id)
	return err
}
func (w *mediaWorker) failImage(ctx context.Context, id string, cause error) error {
	msg := sanitizeWorkerError(cause)
	_, err := w.backend.db.Exec(ctx, `UPDATE image_async_task SET status='failed',error=$2,completed_at=now(),claim_token=NULL,claim_expires_at=NULL,updated_at=now() WHERE id=$1`, id, msg)
	return err
}

func (w *mediaWorker) processVideo(ctx context.Context, id string) error {
	var uid, model, prompt string
	var duration int
	var ratio, resolution string
	var meta []byte
	err := w.backend.db.QueryRow(ctx, `SELECT user_id,model,prompt,duration_seconds,aspect_ratio,resolution,COALESCE(metadata,'{}'::json) FROM video_generation WHERE id=$1`, id).Scan(&uid, &model, &prompt, &duration, &ratio, &resolution, &meta)
	if err != nil {
		return err
	}
	body := map[string]any{"model": model, "prompt": prompt, "duration": duration, "aspectRatio": ratio, "resolution": resolution}
	var stored map[string]any
	_ = json.Unmarshal(meta, &stored)
	cfg, err := w.backend.pickProvider(ctx, model, "videos.generate")
	if err != nil {
		return w.failVideo(ctx, id, err)
	}
	output, err := w.backend.callProvider(ctx, cfg, "videos.generate", body, id, model)
	if err != nil {
		return w.failVideo(ctx, id, err)
	}
	videoURL := extractMediaURL(output)
	if videoURL == "" { // accepted async response; retain poll URL and retry on next scan
		if poll := extractString(output, "poll_url", "pollUrl", "status_url", "statusUrl"); poll != "" {
			_, err = w.backend.db.Exec(ctx, `UPDATE video_generation SET poll_url=$2,upstream_job_id=$3,updated_at=now() WHERE id=$1`, id, poll, extractString(output, "id", "task_id", "taskId"))
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
	key := fmt.Sprintf("%s/videos/%s.mp4", uid, id)
	if err = w.backend.putStorageObject(ctx, bucket, key, data, ct); err != nil {
		return w.failVideo(ctx, id, err)
	}
	_, err = w.backend.db.Exec(ctx, `UPDATE video_generation SET status='completed',storage_key=$2,storage_bucket=$3,video_url=$4,completed_at=now(),updated_at=now() WHERE id=$1`, id, key, bucket, "/api/storage/"+url.PathEscape(bucket)+"/"+url.PathEscape(key))
	return err
}
func (w *mediaWorker) failVideo(ctx context.Context, id string, cause error) error {
	_, err := w.backend.db.Exec(ctx, `UPDATE video_generation SET status='failed',error=$2,completed_at=now(),updated_at=now() WHERE id=$1`, id, sanitizeWorkerError(cause))
	return err
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
			if c := newScriptRuntimeClient(b.config.scriptRuntimeURL, b.config.scriptRuntimeToken); c != nil {
				raw, e := c.execute(ctx, scriptRuntimeRequest{Script: script, Operation: operation, Stage: "request", Input: body, Context: map[string]any{"operation": operation, "stage": "request", "contentType": "application/json", "platformModelId": model, "upstreamModelId": model, "taskId": taskID}})
				if e != nil {
					return nil, e
				}
				var env map[string]any
				if json.Unmarshal(raw, &env) == nil {
					if x, ok := env["body"].(map[string]any); ok {
						payload = x
					}
				}
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
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("media provider HTTP %d", resp.StatusCode)
	}
	var out map[string]any
	if err = json.Unmarshal(raw, &out); err != nil {
		return nil, errors.New("media provider returned invalid JSON")
	}
	return out, nil
}
func extractMediaURL(v map[string]any) string {
	for _, k := range []string{"url", "image_url", "imageUrl", "video_url", "videoUrl"} {
		if x := extractString(v, k); x != "" {
			return x
		}
	}
	for _, k := range []string{"data", "images", "output", "result"} {
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
