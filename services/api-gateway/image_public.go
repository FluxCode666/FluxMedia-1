package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func imageDeliveryBoolean(body map[string]json.RawMessage, key string) (bool, error) {
	value, exists := body[key]
	if !exists {
		return false, nil
	}
	var result bool
	if json.Unmarshal(value, &result) == nil {
		return result, nil
	}
	var text string
	if json.Unmarshal(value, &text) == nil && (text == "true" || text == "false") {
		return text == "true", nil
	}
	return false, invalid(key + " must be a boolean")
}

// HTTP delivery never changes the durable generation state machine. A client
// disconnect leaves accepted work recoverable by the Go worker.
func (b *backend) servePublicImage(w http.ResponseWriter, r *http.Request, p *apiPrincipal, body map[string]json.RawMessage, operation string) error {
	async, err := imageDeliveryBoolean(body, "async")
	if err != nil {
		return err
	}
	async = async || r.URL.Query().Get("async") == "true"
	stream, err := imageDeliveryBoolean(body, "stream")
	if err != nil {
		return err
	}
	stream = stream || strings.Contains(strings.ToLower(r.Header.Get("Accept")), "text/event-stream")
	if async && stream {
		return invalid("async cannot be used with stream.")
	}
	if rawString(body, "responseFormat", "response_format") == "" {
		body["responseFormat"] = json.RawMessage(`"b64_json"`)
	}
	response, err := b.createImageTask(r, p, body, operation)
	if err != nil {
		return err
	}
	id := stringValue(response["id"])
	if async {
		payload, err := b.publicImageTask(r.Context(), p, id)
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, payload)
		return nil
	}
	noStore(w)
	w.Header().Set("X-Accel-Buffering", "no")
	if stream {
		w.Header().Set("Content-Type", "text/event-stream")
	} else {
		w.Header().Set("Content-Type", "application/json")
	}
	// Keep-alive whitespace is valid before a JSON value. SSE comments do not
	// masquerade as completed output or billable partial images.
	started := false
	keepAlive := func() error {
		started = true
		padding := strings.Repeat(" ", 2048) + "\n"
		if stream {
			padding = ": keep-alive\n\n"
		}
		if _, err := fmt.Fprint(w, padding); err != nil {
			return err
		}
		return http.NewResponseController(w).Flush()
	}
	if stream {
		if err := keepAlive(); err != nil {
			return nil
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), 21*time.Minute)
	defer cancel()
	poll := time.NewTicker(250 * time.Millisecond)
	defer poll.Stop()
	heartbeat := time.NewTimer(2 * time.Second)
	defer heartbeat.Stop()
	lastPreviewID := ""
	for {
		payload, readErr := b.publicImageTask(ctx, p, id)
		if readErr != nil {
			if r.Context().Err() != nil {
				return nil
			}
			if !started {
				return readErr
			}
			payload = map[string]any{"status": "failed", "error": map[string]any{"message": "Image result could not be loaded", "type": "server_error", "code": "image_result_unavailable"}}
		}
		if stream && readErr == nil {
			var err error
			lastPreviewID, err = b.flushImagePreviews(ctx, w, id, operation, lastPreviewID)
			if err != nil {
				return nil
			}
		}
		if payload["status"] == "completed" || payload["status"] == "failed" {
			if stream {
				event := "image_generation.completed"
				if operation != "generate" {
					event = "image_edit.completed"
				}
				if payload["status"] == "failed" {
					event = "error"
				}
				payload["type"], payload["index"] = event, 0
				if outputs, ok := payload["data"].([]any); ok && len(outputs) > 0 {
					if primary, ok := outputs[len(outputs)-1].(map[string]any); ok {
						for k, v := range primary {
							payload[k] = v
						}
					}
				}
				data, err := json.Marshal(payload)
				if err != nil {
					return err
				}
				_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, data)
				_ = http.NewResponseController(w).Flush()
			} else {
				// Preserve the Images JSON envelope, including usage and generation ID.
				delete(payload, "id")
				delete(payload, "object")
				delete(payload, "status")
				_ = json.NewEncoder(w).Encode(payload)
			}
			return nil
		}
		select {
		case <-ctx.Done():
			if r.Context().Err() != nil {
				return nil
			}
			message := map[string]any{"error": map[string]any{"message": "Image generation is still processing; query the task endpoint", "code": "image_wait_timeout"}, "task_id": id}
			if stream {
				data, _ := json.Marshal(message)
				_, _ = fmt.Fprintf(w, "event: error\ndata: %s\n\n", data)
			} else {
				_ = json.NewEncoder(w).Encode(message)
			}
			return nil
		case <-heartbeat.C:
			if err := keepAlive(); err != nil {
				return nil
			}
			heartbeat.Reset(10 * time.Second)
		case <-poll.C:
		}
	}
}

func (b *backend) absoluteImageReadURL(ctx context.Context, bucket, key string) (string, error) {
	value, err := b.storageSignedReadURL(ctx, bucket, key, 3600)
	if err != nil {
		return "", err
	}
	if strings.HasPrefix(value, "/") {
		base := strings.TrimRight(b.config.publicAppURL, "/")
		if base == "" {
			base = strings.TrimRight(b.config.authURL, "/")
		}
		if base == "" {
			return "", errors.New("public application URL is not configured")
		}
		value = base + value
	}
	return value, nil
}

// Public polling exposes only the calling key's task and signed outputs. The
// first-party history/status DTO is deliberately not used for external clients.
func (b *backend) publicImageTask(ctx context.Context, p *apiPrincipal, id string) (map[string]any, error) {
	var taskID, generationID, model, status, format, bucket, key, revised, size string
	var raw []byte
	var created time.Time
	var completed *time.Time
	var taskError *string
	var credits float64
	err := b.db.QueryRow(ctx, `SELECT t.id,g.id,g.model,t.status,t.response_format,t.created_at,t.completed_at,COALESCE(t.error,g.error),COALESCE(g.storage_bucket,''),COALESCE(g.storage_key,''),COALESCE(g.revised_prompt,''),COALESCE(g.size,''),COALESCE(g.credits_consumed,0),COALESCE(g.metadata,'{}'::json)
 FROM image_async_task t JOIN generation g ON g.id=COALESCE(t.generation_id,t.generation_ids->>0) AND g.user_id=t.user_id
 WHERE (t.id=$1 OR g.id=$1) AND t.user_id=$2 AND t.api_key_id=$3`, id, p.UserID, imageTaskKeyID(p)).Scan(&taskID, &generationID, &model, &status, &format, &created, &completed, &taskError, &bucket, &key, &revised, &size, &credits, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, &apiError{404, "NOT_FOUND", "Image async task not found"}
	}
	if err != nil {
		return nil, err
	}
	publicStatus := "processing"
	if status == "completed" || status == "failed" {
		publicStatus = status
	}
	out := taskResponse(taskID, model, publicStatus, created, map[string]any{"generation_id": generationID, "generationId": generationID})
	if completed != nil {
		out["completed"] = completed.Unix()
		out["completed_at"] = completed.UTC().Format(time.RFC3339Nano)
	}
	if status == "failed" {
		out["error"] = map[string]any{"message": imageStringValue(taskError, "Image generation failed. Please retry later."), "type": "upstream_error", "code": "image_generation_failed", "status": 502}
		out["credits_consumed"] = credits
		return out, nil
	}
	if status != "completed" {
		return out, nil
	}
	if bucket == "" || key == "" {
		return nil, errors.New("completed image task has no persisted output")
	}
	var metadata map[string]any
	if err = json.Unmarshal(raw, &metadata); err != nil {
		return nil, err
	}
	refs := []map[string]any{{"storageBucket": bucket, "storageKey": key, "revisedPrompt": revised}}
	if output, ok := metadata["outputImage"].(map[string]any); ok {
		if outputs, ok := output["imageOutputs"].([]any); ok && len(outputs) > 0 {
			var stored []map[string]any
			for _, item := range outputs {
				if ref, ok := item.(map[string]any); ok && extractString(ref, "storageBucket") != "" && extractString(ref, "storageKey") != "" {
					stored = append(stored, ref)
				}
			}
			if len(stored) == len(outputs) {
				refs = stored
			}
		}
	}
	data := make([]any, 0, len(refs))
	for _, ref := range refs {
		item := map[string]any{}
		if format == "b64_json" {
			bytes, err := b.readStorageObjectLimited(ctx, extractString(ref, "storageBucket"), extractString(ref, "storageKey"), imageProviderMaxResponse)
			if err != nil {
				return nil, err
			}
			item["b64_json"] = base64.StdEncoding.EncodeToString(bytes)
		} else {
			value, err := b.absoluteImageReadURL(ctx, extractString(ref, "storageBucket"), extractString(ref, "storageKey"))
			if err != nil {
				return nil, err
			}
			item["url"] = value
		}
		if value := extractString(ref, "revisedPrompt", "revised_prompt"); value != "" {
			item["revised_prompt"] = value
		} else if revised != "" {
			item["revised_prompt"] = revised
		}
		if value := extractString(metadata, "promptRepairNotice"); value != "" {
			item["prompt_repair_notice"] = value
		}
		data = append(data, item)
	}
	out["object"], out["data"], out["credits_consumed"], out["usage"], out["size"] = "image", data, credits, nil, size
	return out, nil
}
