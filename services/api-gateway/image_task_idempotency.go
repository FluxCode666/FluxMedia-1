package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func imageTaskConflict() error {
	return &apiError{http.StatusConflict, "IDEMPOTENCY_CONFLICT", "taskId or generationId was already used with different image input or credentials"}
}

func imageTaskKeyID(p *apiPrincipal) string {
	if p.KeyID == "" {
		return "web:session"
	}
	return p.KeyID
}

// Normalize identity/delivery aliases before hashing. The digest is computed
// before media staging replaces request references with durable object keys.
func normalizeImageTaskInput(original map[string]json.RawMessage, operation string) (map[string]json.RawMessage, string, error) {
	body := make(map[string]json.RawMessage, len(original)+4)
	for key, value := range original {
		body[key] = value
	}
	if operation != "generate" && operation != "edit" && operation != "mask" {
		return nil, "", invalid("Invalid image operation")
	}
	if supplied, ok := body["operation"]; ok {
		var value string
		if json.Unmarshal(supplied, &value) != nil || value != operation {
			return nil, "", invalid("Image operation does not match endpoint")
		}
	}
	body["operation"], _ = json.Marshal(operation)
	for _, aliases := range [][]string{{"generationId", "generation_id"}, {"taskId", "task_id"}, {"responseFormat", "response_format"}, {"callbackUrl", "callback_url"}, {"repairPrompt", "repair_prompt"}} {
		value := ""
		for _, key := range aliases {
			if raw, ok := body[key]; ok {
				var next string
				if json.Unmarshal(raw, &next) != nil {
					return nil, "", invalid(key + " must be a string")
				}
				next = strings.TrimSpace(next)
				if value != "" && next != value {
					return nil, "", invalid("Conflicting " + aliases[0] + " aliases")
				}
				value = next
			}
			delete(body, key)
		}
		if value != "" {
			body[aliases[0]], _ = json.Marshal(value)
		}
	}
	for _, aliases := range [][]string{{"hdRepair", "hd_repair"}, {"blockRepair", "block_repair"}, {"transparentMatte", "transparent_matte"}} {
		var selected *bool
		for _, key := range aliases {
			if _, exists := body[key]; !exists {
				continue
			}
			value, err := imageDeliveryBoolean(body, key)
			if err != nil {
				return nil, "", err
			}
			if selected != nil && *selected != value {
				return nil, "", invalid("Conflicting " + aliases[0] + " aliases")
			}
			selected = &value
			delete(body, key)
		}
		if selected != nil {
			body[aliases[0]], _ = json.Marshal(*selected)
		}
	}
	generationID := rawString(body, "generationId")
	if generationID == "" {
		generationID = newRequestID()
	}
	if len(generationID) > 128 {
		return nil, "", invalid("Invalid generationId")
	}
	taskID := rawString(body, "taskId")
	if taskID == "" {
		taskID = "task_" + generationID
	}
	if !strings.HasPrefix(taskID, "task_") || len(taskID) > 128 {
		return nil, "", invalid("Invalid taskId")
	}
	format := rawString(body, "responseFormat")
	if format == "" {
		format = "url"
	}
	if format != "url" && format != "b64_json" {
		return nil, "", invalid("Invalid responseFormat")
	}
	callback := rawString(body, "callbackUrl")
	if callback != "" {
		parsed, err := url.Parse(callback)
		if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil || len(callback) > 2048 || parsed.Fragment != "" {
			return nil, "", invalid("Image callback URL must use HTTPS")
		}
	}
	body["generationId"], _ = json.Marshal(generationID)
	body["taskId"], _ = json.Marshal(taskID)
	body["responseFormat"], _ = json.Marshal(format)
	// Decode raw JSON so whitespace and object-key ordering do not change the
	// idempotency identity. Arrays and all caller-supplied fields remain scoped.
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, "", invalid("Invalid image task input")
	}
	var normalized any
	if err = json.Unmarshal(raw, &normalized); err != nil {
		return nil, "", invalid("Invalid image task input")
	}
	raw, err = json.Marshal(normalized)
	if err != nil {
		return nil, "", err
	}
	digest := sha256.Sum256(raw)
	return body, "sha256:" + hex.EncodeToString(digest[:]), nil
}

type imageTaskQuerier interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

func existingImageTask(ctx context.Context, db imageTaskQuerier, p *apiPrincipal, body map[string]json.RawMessage, digest string) (map[string]any, error) {
	taskID, generationID := rawString(body, "taskId"), rawString(body, "generationId")
	rows, err := db.Query(ctx, `SELECT t.id,t.user_id,t.api_key_id,t.generation_id,COALESCE(g.model,t.generation_input->>'model',''),t.status,t.created_at,COALESCE(g.metadata->>'requestDigest',''),COALESCE(t.input_digest,''),t.response_format,COALESCE(t.callback_url,'') FROM image_async_task t LEFT JOIN generation g ON g.id=t.generation_id WHERE t.id=$1 OR t.generation_id=$2`, taskID, generationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var response map[string]any
	for rows.Next() {
		var id, uid, key, gid, model, status, requestDigest, inputDigest, format, callback string
		var created time.Time
		if err = rows.Scan(&id, &uid, &key, &gid, &model, &status, &created, &requestDigest, &inputDigest, &format, &callback); err != nil {
			return nil, err
		}
		if requestDigest == "" {
			requestDigest = inputDigest
		}
		if response != nil || id != taskID || gid != generationID || uid != p.UserID || key != imageTaskKeyID(p) || requestDigest != digest || format != rawString(body, "responseFormat") || callback != rawString(body, "callbackUrl") {
			return nil, imageTaskConflict()
		}
		response = taskResponse(id, model, status, created, map[string]any{"generation_id": gid, "generationId": gid})
	}
	return response, rows.Err()
}
