package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// imageUOLPrincipal authenticates either the browser or the signed API/MCP
// identity forwarded by Next. The user/key pair never comes from JSON input.
func (b *backend) imageUOLPrincipal(r *http.Request) (*apiPrincipal, error) {
	if p, ok := b.signedInternalPrincipal(r); ok && p.Type == "apiKey" {
		return &apiPrincipal{UserID: p.UserID, KeyID: p.APIKeyID}, nil
	}
	s, err := b.requireSession(r)
	if err != nil {
		return nil, err
	}
	return &apiPrincipal{UserID: s.User.ID, KeyID: "session"}, nil
}

type imageAsyncUOLInput struct {
	TaskID          string                     `json:"taskId"`
	GenerationInput map[string]json.RawMessage `json:"generationInput"`
	ResponseFormat  string                     `json:"responseFormat"`
	CallbackURL     string                     `json:"callbackUrl,omitempty"`
}

func (b *backend) imageAsyncUOLStatus(r *http.Request, taskID string, p *apiPrincipal) (map[string]any, error) {
	var model, operation, status, generationID, responseFormat string
	var createdAt time.Time
	var startedAt, completedAt *time.Time
	var taskError *string
	err := b.db.QueryRow(r.Context(), `SELECT COALESCE(t.generation_input->>'model',g.model),t.operation,t.status,COALESCE(t.generation_id,t.generation_ids->>0),t.response_format,t.created_at,t.started_at,t.completed_at,t.error FROM image_async_task t LEFT JOIN generation g ON g.id=COALESCE(t.generation_id,t.generation_ids->>0) WHERE t.id=$1 AND t.user_id=$2 AND t.api_key_id=$3`, taskID, p.UserID, p.KeyID).Scan(&model, &operation, &status, &generationID, &responseFormat, &createdAt, &startedAt, &completedAt, &taskError)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, &apiError{404, "NOT_FOUND", "Image async task not found"}
	}
	if err != nil {
		return nil, err
	}
	return map[string]any{"taskId": taskID, "model": model, "operation": operation, "status": status, "generationId": generationID, "responseFormat": responseFormat, "createdAt": createdAt.UTC().Format(time.RFC3339Nano), "startedAt": startedAt, "completedAt": completedAt, "error": taskError}, nil
}

func (b *backend) handleImageAsyncCreate(w http.ResponseWriter, r *http.Request) error {
	p, err := b.imageUOLPrincipal(r)
	if err != nil {
		return err
	}
	var input imageAsyncUOLInput
	if err := decodeBody(r, &input); err != nil {
		return err
	}
	if !strings.HasPrefix(input.TaskID, "task_") || len(input.TaskID) > 128 {
		return invalid("Invalid image async taskId")
	}
	if input.ResponseFormat != "url" && input.ResponseFormat != "b64_json" {
		return invalid("Invalid responseFormat")
	}
	operation := rawString(input.GenerationInput, "operation")
	if operation != "generate" && operation != "edit" && operation != "mask" {
		return invalid("Invalid image operation")
	}
	if rawString(input.GenerationInput, "generationId") == "" {
		return invalid("generationId is required")
	}
	if existing, err := b.imageAsyncUOLStatus(r, input.TaskID, p); err == nil {
		requestedGenerationID := rawString(input.GenerationInput, "generationId")
		if existing["generationId"] != requestedGenerationID || existing["operation"] != operation || existing["responseFormat"] != input.ResponseFormat {
			return &apiError{409, "IDEMPOTENCY_CONFLICT", "taskId was already used with different image async input"}
		}
		writeJSON(w, 200, existing)
		return nil
	} else {
		var known *apiError
		if !errors.As(err, &known) || known.status != 404 {
			return err
		}
	}
	input.GenerationInput["taskId"], _ = json.Marshal(input.TaskID)
	response, err := b.createImageTask(r, p, input.GenerationInput, operation)
	if err != nil {
		return err
	}
	createdTaskID, _ := response["id"].(string)
	if _, err := b.db.Exec(r.Context(), `UPDATE image_async_task SET response_format=$2,callback_url=NULLIF($3,'') WHERE id=$1 AND user_id=$4 AND api_key_id=$5`, createdTaskID, input.ResponseFormat, input.CallbackURL, p.UserID, p.KeyID); err != nil {
		return err
	}
	output, err := b.imageAsyncUOLStatus(r, createdTaskID, p)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusAccepted, output)
	return nil
}

func (b *backend) handleImageAsyncStatus(w http.ResponseWriter, r *http.Request) error {
	p, err := b.imageUOLPrincipal(r)
	if err != nil {
		return err
	}
	output, err := b.imageAsyncUOLStatus(r, r.PathValue("taskId"), p)
	if err != nil {
		return err
	}
	writeJSON(w, 200, output)
	return nil
}
