package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

type imageProviderState struct {
	Stage      string    `json:"stage"`
	Operation  string    `json:"operation"`
	TaskID     string    `json:"taskId,omitempty"`
	StartedAt  time.Time `json:"startedAt"`
	NextPollAt time.Time `json:"nextPollAt,omitempty"`
	Failures   int       `json:"failures,omitempty"`
}

// Preserve the normalized failure category without exposing provider details.
// The same category drives member health and the persisted SLA classification.
type imageProviderTerminalError struct{ category string }

func (e *imageProviderTerminalError) Error() string {
	switch e.category {
	case "invalid_request":
		return "image provider invalid_request"
	case "moderation":
		return "image provider content blocked"
	default:
		return "image provider reported a terminal failure"
	}
}

func imageProviderTerminalFailure(record map[string]any) error {
	failure, _ := record["error"].(map[string]any)
	category := extractString(failure, "category")
	switch category {
	case "invalid_request", "moderation", "authentication", "permission", "rate_limit", "capacity", "not_found", "timeout", "upstream", "unknown":
	default:
		category = "unknown"
	}
	return &imageProviderTerminalError{category: category}
}

func (w *mediaWorker) executeImageProviderTask(ctx context.Context, taskID, generationID, userID, operation, model string, body map[string]any) (map[string]any, bool, error) {
	b := w.backend
	var raw []byte
	if err := b.db.QueryRow(ctx, `SELECT COALESCE(metadata->'apiImage','{}'::json) FROM generation WHERE id=$1 AND user_id=$2`, generationID, userID).Scan(&raw); err != nil {
		return nil, false, err
	}
	var state imageProviderState
	if json.Unmarshal(raw, &state) != nil {
		return nil, false, errors.New("invalid persisted image provider state")
	}
	var cfg providerConfig
	var output map[string]any
	var err error
	if state.Stage != "" {
		if state.Stage != "polling" || state.TaskID == "" {
			return nil, false, errors.New("image provider submission was interrupted; refusing to submit it again")
		}
		if state.StartedAt.IsZero() || time.Since(state.StartedAt) >= 20*time.Minute {
			return nil, false, errors.New("image provider polling timed out")
		}
		cfg, err = b.imageProviderForAcceptedTask(ctx, generationID, userID)
		if err == nil {
			err = b.acquireImageProviderLease(ctx, taskID, cfg)
		}
		if err == nil {
			output, err = b.queryImageProvider(ctx, cfg, state.Operation+".query", state.TaskID, model)
		}
		if err != nil {
			var transport *imageProviderTransportError
			var runtime *scriptRuntimeUnavailableError
			seconds := 5
			if errors.As(err, &transport) {
				if transport.retryAfterSeconds > seconds {
					seconds = transport.retryAfterSeconds
				}
			} else if errors.As(err, &runtime) {
				if runtime.retryAfterSeconds > seconds {
					seconds = runtime.retryAfterSeconds
				}
			} else if !errors.Is(err, errImageProviderCapacity) {
				state.Failures++
			}
			if state.Failures >= 3 {
				return nil, false, errors.New("image provider query failed repeatedly")
			}
			state.NextPollAt = time.Now().UTC().Add(time.Duration(seconds) * time.Second)
			return nil, true, b.persistPendingImageProvider(ctx, taskID, generationID, userID, state)
		}
	} else {
		cfg, err = b.imageTaskProvider(ctx, generationID, userID, model)
		if err != nil {
			return nil, false, err
		}
		if err = b.acquireImageProviderLease(ctx, taskID, cfg); err != nil {
			if errors.Is(err, errImageProviderCapacity) {
				_, err = b.db.Exec(ctx, `UPDATE image_async_task SET mq_delivery_due_at=now()+interval '5 seconds' WHERE id=$1 AND claim_token=$2`, taskID, ctx.Value(imageWorkerClaimKey{}))
				return nil, true, err
			}
			return nil, false, err
		}
		if cfg.contentSafetyEnabled {
			if err := b.moderateGeneration(ctx, userID, generationID, "image_generation", body); err != nil {
				return nil, false, err
			}
		}
		providerOperation, providerBody, err := b.prepareImageProviderInput(ctx, cfg, userID, operation, model, body)
		if err != nil {
			return nil, false, err
		}
		state = imageProviderState{Stage: "submitting", Operation: providerOperation, StartedAt: time.Now().UTC()}
		// Fence only after local adaptation and response capacity admission.
		// Temporary platform saturation has not submitted anything and can wait.
		submitted := false
		ctx = context.WithValue(ctx, imageBeforeSendContextKey{}, func() error {
			tag, err := b.db.Exec(ctx, `UPDATE generation SET api_adapter_member_id=$3,api_adapter_version_id=$4,metadata=(COALESCE(metadata::jsonb,'{}'::jsonb)||$5::jsonb)::json WHERE id=$1 AND user_id=$2 AND status='pending' AND NOT COALESCE(metadata::jsonb,'{}'::jsonb) ? 'apiImage' AND EXISTS(SELECT 1 FROM image_async_task WHERE id=$6 AND claim_token=$7 AND claim_expires_at>now())`, generationID, userID, cfg.memberID, cfg.versionID, mustJSON(map[string]any{"apiImage": state}), taskID, ctx.Value(imageWorkerClaimKey{}))
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				return errImageClaimLost
			}
			submitted = true
			return nil
		})
		output, err = b.callProvider(ctx, cfg, providerOperation, providerBody, taskID, model)
		var busy *scriptRuntimeUnavailableError
		if !submitted && errors.As(err, &busy) {
			seconds := busy.retryAfterSeconds
			if seconds < 5 {
				seconds = 5
			}
			_, waitErr := b.db.Exec(ctx, `UPDATE image_async_task SET mq_delivery_due_at=now()+$3::interval WHERE id=$1 AND claim_token=$2 AND claim_expires_at>now()`, taskID, ctx.Value(imageWorkerClaimKey{}), (time.Duration(seconds) * time.Second).String())
			return nil, true, waitErr
		}
		if errors.Is(err, errImageClaimLost) {
			return nil, true, nil
		}
		if errors.Is(err, errImageTransparentUnsupported) && body["background"] == "transparent" && body["transparentMatte"] == true {
			// The first request was deterministically rejected. Fence the one
			// opaque retry before sending, so crash recovery cannot repeat it.
			state.Stage = "opaque_submitting"
			tag, saveErr := b.db.Exec(ctx, `UPDATE generation SET metadata=(COALESCE(metadata::jsonb,'{}'::jsonb)||$3::jsonb)::json WHERE id=$1 AND user_id=$2 AND status='pending' AND EXISTS(SELECT 1 FROM image_async_task WHERE id=$4 AND claim_token=$5 AND claim_expires_at>now())`, generationID, userID, mustJSON(map[string]any{"apiImage": state, "transparentMatteRequired": true}), taskID, ctx.Value(imageWorkerClaimKey{}))
			if saveErr != nil {
				return nil, false, saveErr
			}
			if tag.RowsAffected() != 1 {
				return nil, false, errors.New("image claim changed before opaque retry")
			}
			ctx = context.WithValue(ctx, imageBeforeSendContextKey{}, func() error { return nil })
			delete(providerBody, "background")
			output, err = b.callProvider(ctx, cfg, providerOperation, providerBody, taskID, model)
		}
		if err != nil {
			return nil, false, err
		}
	}
	pending, acceptedID, err := inspectImageProviderResult(output, state.TaskID)
	if err != nil {
		return nil, false, err
	}
	if !pending {
		return output, false, nil
	}
	if state.TaskID == "" {
		state.TaskID = acceptedID
	}
	if _, err := imageProviderQueryURL(cfg, state.Operation+".query", state.TaskID); err != nil {
		return nil, false, err
	}
	state.Stage = "polling"
	state.Failures = 0
	seconds := 5
	if n, ok := output["__fluxImagePollAfterSeconds"].(int); ok && n >= 1 && n <= 300 {
		seconds = n
	}
	state.NextPollAt = time.Now().UTC().Add(time.Duration(seconds) * time.Second)
	return nil, true, b.persistPendingImageProvider(ctx, taskID, generationID, userID, state)
}

func (b *backend) imageProviderForAcceptedTask(ctx context.Context, generationID, userID string) (providerConfig, error) {
	var cfg providerConfig
	var raw []byte
	// Accepted work keeps the immutable version and its credential scope even
	// if the member is disabled, moved to another group or configured differently.
	err := b.db.QueryRow(ctx, `SELECT v.member_id_snapshot,v.id,COALESCE(c.api_key,''),v.configuration FROM generation g JOIN image_backend_member_api_adapter_version v ON v.id=g.api_adapter_version_id AND v.member_id_snapshot=g.api_adapter_member_id JOIN image_backend_member_api_config c ON c.member_id=v.member_id_snapshot AND c.credential_scope=v.credential_scope WHERE g.id=$1 AND g.user_id=$2`, generationID, userID).Scan(&cfg.memberID, &cfg.versionID, &cfg.apiKey, &raw)
	if err != nil {
		return cfg, err
	}
	if json.Unmarshal(raw, &cfg.adapter) != nil {
		return cfg, errors.New("invalid accepted image adapter")
	}
	cfg.baseURL = strings.TrimRight(extractString(cfg.adapter, "baseUrl", "baseURL"), "/")
	cfg.operations, _ = cfg.adapter["operations"].(map[string]any)
	cfg.auth = extractString(cfg.adapter, "authentication")
	return cfg, nil
}

func (b *backend) persistPendingImageProvider(ctx context.Context, taskID, generationID, userID string, state imageProviderState) error {
	tx, err := b.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)
	var status, token string
	var alive bool
	if err := tx.QueryRow(ctx, `SELECT status,COALESCE(claim_token,''),COALESCE(claim_expires_at>now(),false) FROM image_async_task WHERE id=$1 AND user_id=$2 FOR UPDATE`, taskID, userID).Scan(&status, &token, &alive); err != nil {
		return err
	}
	if status == "completed" || status == "failed" {
		return errors.New("image task became terminal while polling")
	}
	if token != ctx.Value(imageWorkerClaimKey{}) || !alive {
		return errImageClaimLost
	}
	tag, err := tx.Exec(ctx, `UPDATE generation SET metadata=(COALESCE(metadata::jsonb,'{}'::jsonb)||$3::jsonb)::json WHERE id=$1 AND user_id=$2 AND status='pending'`, generationID, userID, mustJSON(map[string]any{"apiImage": state}))
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return errors.New("image generation became terminal while polling")
	}
	if _, err := tx.Exec(ctx, `UPDATE image_async_task SET status='running',claim_token=NULL,claim_expires_at=NULL,mq_delivery_due_at=$2,updated_at=now() WHERE id=$1`, taskID, state.NextPollAt); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func inspectImageProviderResult(output map[string]any, expectedTaskID string) (bool, string, error) {
	record := output
	if nested, ok := output["data"].(map[string]any); ok {
		record = nested
	}
	status := strings.ToLower(extractString(record, "status", "state"))
	switch status {
	case "failed", "error", "cancelled", "canceled", "rejected":
		return false, "", imageProviderTerminalFailure(record)
	}
	if imageProviderHasOutput(output) {
		return false, "", nil
	}
	switch status {
	case "", "pending", "queued", "created", "submitting", "processing", "running", "in_progress":
	default:
		return false, "", errors.New("image provider returned an invalid result")
	}
	id := extractString(record, "taskId", "task_id", "id", "generation_id")
	if expectedTaskID != "" && id != "" && id != expectedTaskID {
		return false, "", errors.New("image provider query returned a different task ID")
	}
	if id == "" {
		id = expectedTaskID
	}
	if id == "" {
		return false, "", errors.New("image provider response omitted accepted task ID")
	}
	return true, id, nil
}
func imageProviderHasOutput(value any) bool {
	switch value := value.(type) {
	case map[string]any:
		for _, key := range []string{"url", "image_url", "imageUrl", "b64_json", "base64", "imageBase64"} {
			if extractString(value, key) != "" {
				return true
			}
		}
		for _, key := range []string{"data", "images", "outputs", "output", "result"} {
			if imageProviderHasOutput(value[key]) {
				return true
			}
		}
	case []any:
		for _, item := range value {
			if imageProviderHasOutput(item) {
				return true
			}
		}
	}
	return false
}
