package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
)

// Every HTTP transport uses this core. The task lock serializes staging and
// immutable request replay; the user transaction atomically adopts the inputs,
// current quote, callback and reservation into the persisted task.
func (b *backend) createNativeVideoTask(r *http.Request, userID, keyID, scope string, body map[string]json.RawMessage) (map[string]any, error) {
	input, err := parseNativeVideoInput(body)
	if err != nil {
		return nil, err
	}
	id := nativeVideoTaskID(scope, input.ClientRequestID)
	connection, err := b.db.Acquire(r.Context())
	if err != nil {
		return nil, err
	}
	defer connection.Release()
	lockKey := "video-create:" + scope + ":" + input.ClientRequestID
	if _, err = connection.Exec(r.Context(), `SELECT pg_advisory_lock(hashtextextended($1,0))`, lockKey); err != nil {
		return nil, err
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = connection.Exec(ctx, `SELECT pg_advisory_unlock(hashtextextended($1,0))`, lockKey)
	}()
	existing, err := b.findVideoReplay(r.Context(), connection, id, userID, keyID, scope, input)
	if err != nil || existing != nil {
		return existing, err
	}
	pricing, err := b.loadGoVideoPricingContext(r.Context(), userID, keyID, input.BackendGroupID)
	if err != nil {
		return nil, err
	}
	if err = validateNativeVideoCapability(input, pricing.Models[input.Model]); err != nil {
		return nil, err
	}
	if _, err = resolveGoVideoQuoteFromContext(pricing, input.Model, input.Resolution, input.Duration); err != nil {
		return nil, err
	}
	if !pricing.Reachable[input.Model] {
		return nil, &apiError{503, "NO_ELIGIBLE_MEDIA_PROVIDER", "The selected media group has no configured video provider"}
	}
	if err = b.reserveGoVideoAdmission(r.Context(), userID, scope, id); err != nil {
		return nil, err
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = b.db.Exec(ctx, `DELETE FROM video_task_staging_reservation WHERE task_id=$1 AND user_id=$2`, id, userID)
	}()
	manifest, err := b.stageNativeVideoInputs(r.Context(), userID, id, input.manifest())
	if err != nil {
		return nil, err
	}
	tx, err := connection.Begin(r.Context())
	if err != nil {
		return nil, err
	}
	defer rollback(tx)
	if _, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "video-user:"+userID); err != nil {
		return nil, err
	}
	pricing, err = loadGoVideoPricingContext(r.Context(), tx, userID, keyID, input.BackendGroupID)
	if err != nil {
		return nil, err
	}
	cfg, ok := pricing.Models[input.Model]
	if !ok || !cfg.Enabled {
		return nil, invalid("Video model is disabled or unconfigured")
	}
	if err = validateNativeVideoCapability(input, cfg); err != nil {
		return nil, err
	}
	if !pricing.Reachable[input.Model] {
		return nil, &apiError{503, "NO_ELIGIBLE_MEDIA_PROVIDER", "The selected media group has no configured video provider"}
	}
	quote, err := resolveGoVideoQuoteFromContext(pricing, input.Model, input.Resolution, input.Duration)
	if err != nil {
		return nil, err
	}
	if input.QuoteToken != "" {
		if err = assertGoVideoQuoteToken(input.QuoteToken, scope, quote.Digest); err != nil {
			return nil, &apiError{409, "STALE_VIDEO_QUOTE", err.Error()}
		}
	}
	width, height, err := nativeVideoOutputSize(input, cfg)
	if err != nil {
		return nil, err
	}
	_, bucket, err := b.storageBuckets(r.Context())
	if err != nil {
		return nil, err
	}
	metadata := map[string]any{"clientRequestId": input.ClientRequestID, "requestFingerprint": input.fingerprint(), "requestFingerprintVersion": 2, "videoLedgerNamespace": "video", "backendGroupId": pricing.GroupID, "generateAudio": *input.GenerateAudio, "negativePrompt": input.NegativePrompt, "videoBillingSnapshot": quote.Snapshot, "videoCapabilitySnapshot": map[string]any{"version": 2, "modelConfigurationRevision": cfg.Revision, "maxReferenceImages": cfg.Capability.RefMax, "supportedResolutions": cfg.SupportedResolutions}}
	metadata["backendGroupSnapshot"] = pricing.Group
	metadata["moderationEnabled"] = pricing.ModerationEnabled && (pricing.Group.ContentSafetyEnabled == nil || *pricing.Group.ContentSafetyEnabled)
	if input.GeminiModel != "" {
		metadata["geminiModel"] = input.GeminiModel
	}
	if input.GeminiOperationID != "" {
		metadata["geminiOperationId"] = input.GeminiOperationID
	}
	if err = b.adoptNativeVideoInputs(r.Context(), tx, userID, id, manifest); err != nil {
		return nil, err
	}
	var persistedManifest any
	if len(manifest) > 0 {
		persistedManifest = mustJSON(manifest)
	}
	_, err = tx.Exec(r.Context(), `INSERT INTO video_generation(id,user_id,api_key_id,principal_scope,usage_log_visible,model,prompt,duration_seconds,aspect_ratio,resolution,output_width,output_height,storage_bucket,status,stage,input_manifest,metadata,credits_consumed,public_operation_id,next_poll_at) VALUES($1,$2,NULLIF($3,''),$4,true,$5,$6,$7,$8,$9,$10,$11,$12,'pending','created',$13,$14,0,NULLIF($15,''),now())`, id, userID, keyID, scope, input.Model, input.Prompt, input.Duration, input.AspectRatio, input.Resolution, width, height, bucket, persistedManifest, mustJSON(metadata), input.GeminiOperationID)
	if err != nil {
		return nil, err
	}
	if input.CallbackURL != "" {
		if _, err = tx.Exec(r.Context(), `INSERT INTO video_generation_callback_delivery(id,video_generation_id,callback_url) VALUES($1,$2,$3)`, newRequestID(), id, input.CallbackURL); err != nil {
			return nil, err
		}
	}
	if _, err = tx.Exec(r.Context(), `DELETE FROM video_task_staging_reservation WHERE task_id=$1 AND user_id=$2`, id, userID); err != nil {
		return nil, err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return nil, err
	}
	if b.redis != nil {
		_ = b.redis.Publish(r.Context(), "fluxmedia:media:wakeup", id).Err()
	}
	return b.readNativeVideoStatus(r, id, userID, keyID, scope)
}

func (b *backend) findVideoReplay(ctx context.Context, database videoPricingStore, id, userID, keyID, scope string, input nativeVideoInput) (map[string]any, error) {
	// Accept tasks created by the first Go rollout as well as the original
	// length-delimited identity. Their stored principal is never broadened.
	legacy := sha256.Sum256([]byte(scope + "\x00" + input.ClientRequestID))
	oldID := "video_" + hex.EncodeToString(legacy[:])[:32]
	var found string
	var raw []byte
	err := database.QueryRow(ctx, `SELECT id,COALESCE(metadata,'{}'::json) FROM video_generation WHERE id IN ($1,$2) AND user_id=$3 AND principal_scope=$4 AND api_key_id IS NOT DISTINCT FROM NULLIF($5,'') ORDER BY created_at LIMIT 1`, id, oldID, userID, scope, keyID).Scan(&found, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var metadata map[string]any
	if json.Unmarshal(raw, &metadata) != nil {
		return nil, errors.New("Invalid stored video metadata")
	}
	fingerprint, _ := metadata["requestFingerprint"].(string)
	if goInt64(metadata["requestFingerprintVersion"]) != 2 || fingerprint != input.fingerprint() {
		return nil, &apiError{409, "IDEMPOTENCY_CONFLICT", "The request ID already belongs to a different or unverifiable video request"}
	}
	r := (&http.Request{}).WithContext(ctx)
	return b.readNativeVideoStatus(r, found, userID, keyID, scope)
}

func videoSnapshotPublicBilling(metadata map[string]any, credits float64) map[string]any {
	snapshot, ok := metadata["videoBillingSnapshot"].(map[string]any)
	if !ok {
		return videoUOLBilling(credits)
	}
	mode, _ := snapshot["mode"].(string)
	unit := "second"
	if mode == "per_item" {
		unit = "item"
	} else if mode != "per_second" {
		return videoUOLBilling(credits)
	}
	price := imageCreditValue(snapshot["unitPrice"], 0)
	quoted := imageCreditValue(snapshot["quotedCredits"], 0)
	duration := goInt64(snapshot["durationSeconds"])
	if price <= 0 || quoted <= 0 || duration <= 0 {
		return videoUOLBilling(credits)
	}
	result := map[string]any{"kind": "snapshot", "mode": mode, "unit": unit, "unitPrice": price, "durationSeconds": duration, "quotedCredits": quoted, "actualCredits": credits}
	if mode == "per_second" {
		result["creditsPerSecond"] = price
	}
	return result
}

func (b *backend) readNativeVideoStatus(r *http.Request, id, userID, keyID, scope string) (map[string]any, error) {
	var model, status, stage, ratio, resolution string
	var duration int
	var credits float64
	var created time.Time
	var completed *time.Time
	var taskErr, operationID, key, bucket *string
	var manifest, metadata []byte
	err := b.db.QueryRow(r.Context(), `SELECT model,status,stage,aspect_ratio,resolution,duration_seconds,credits_consumed,created_at,completed_at,error,COALESCE(input_manifest,'{}'::json),COALESCE(metadata,'{}'::json),public_operation_id,storage_key,storage_bucket FROM video_generation WHERE id=$1 AND user_id=$2 AND principal_scope=$3 AND api_key_id IS NOT DISTINCT FROM NULLIF($4,'')`, id, userID, scope, keyID).Scan(&model, &status, &stage, &ratio, &resolution, &duration, &credits, &created, &completed, &taskErr, &manifest, &metadata, &operationID, &key, &bucket)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, &apiError{404, "NOT_FOUND", "Video task not found"}
	}
	if err != nil {
		return nil, err
	}
	var meta, inputs map[string]any
	if json.Unmarshal(metadata, &meta) != nil || json.Unmarshal(manifest, &inputs) != nil {
		return nil, errors.New("Invalid video task snapshot")
	}
	result := map[string]any{"taskId": id, "status": videoUOLStatus(status, stage), "model": model, "duration": duration, "aspectRatio": ratio, "resolution": resolution, "generateAudio": boolValue(meta["generateAudio"]), "input": videoInputSummary(inputs), "billing": videoSnapshotPublicBilling(meta, credits), "createdAt": created.UTC().Format(time.RFC3339Nano)}
	if taskErr != nil && *taskErr != "" {
		result["error"] = *taskErr
	}
	if completed != nil {
		result["completedAt"] = completed.UTC().Format(time.RFC3339Nano)
	}
	if operationID != nil && *operationID != "" {
		result["geminiOperationId"] = *operationID
	}
	if status == "completed" && key != nil && bucket != nil && *key != "" {
		result["videoUrl"] = b.absoluteVideoURL(r, "/api/storage/"+urlPathEscape(*bucket)+"/"+urlPathEscape(*key))
	}
	return result, nil
}

func videoGenerateResult(task map[string]any) map[string]any {
	result := map[string]any{"taskId": task["taskId"], "status": task["status"], "billing": task["billing"]}
	for _, key := range []string{"error", "geminiOperationId"} {
		if value, exists := task[key]; exists {
			result[key] = value
		}
	}
	return result
}

func (b *backend) absoluteVideoURL(r *http.Request, path string) string {
	return b.referralRedirectOrigin(r) + path
}
