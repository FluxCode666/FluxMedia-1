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
		return b.authenticateAPI(r)
	}
	s, err := b.requireSession(r)
	if err != nil {
		return nil, err
	}
	return &apiPrincipal{UserID: s.User.ID, KeyID: ""}, nil
}

type imageAsyncUOLInput struct {
	TaskID          string                     `json:"taskId"`
	GenerationInput map[string]json.RawMessage `json:"generationInput"`
	ResponseFormat  string                     `json:"responseFormat"`
	CallbackURL     string                     `json:"callbackUrl,omitempty"`
}

func (b *backend) imageAsyncUOLStatus(r *http.Request, taskID string, p *apiPrincipal) (map[string]any, error) {
	keyID := p.KeyID
	if keyID == "" {
		keyID = "web:session"
	}
	var model, operation, status, generationID, responseFormat string
	var createdAt time.Time
	var startedAt, completedAt *time.Time
	var taskError *string
	err := b.db.QueryRow(r.Context(), `SELECT COALESCE(t.generation_input->>'model',g.model),t.operation,t.status,COALESCE(t.generation_id,t.generation_ids->>0),t.response_format,t.created_at,t.started_at,t.completed_at,t.error FROM image_async_task t LEFT JOIN generation g ON g.id=COALESCE(t.generation_id,t.generation_ids->>0) WHERE t.id=$1 AND t.user_id=$2 AND t.api_key_id=$3`, taskID, p.UserID, keyID).Scan(&model, &operation, &status, &generationID, &responseFormat, &createdAt, &startedAt, &completedAt, &taskError)
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
	input.GenerationInput["taskId"], _ = json.Marshal(input.TaskID)
	input.GenerationInput["responseFormat"], _ = json.Marshal(input.ResponseFormat)
	if input.CallbackURL != "" {
		input.GenerationInput["callbackUrl"], _ = json.Marshal(input.CallbackURL)
	}
	response, err := b.createImageTask(r, p, input.GenerationInput, operation)
	if err != nil {
		return err
	}
	createdTaskID, _ := response["id"].(string)
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

// Explicit system dispatch shares the durable atomic claim with the worker.
// Duplicate dispatches observe current state without submitting a second job.
func (b *backend) handleImageAsyncProcess(w http.ResponseWriter, r *http.Request) error {
	if !b.cronAuthorized(r) {
		return &apiError{403, "FORBIDDEN", "System worker authentication required"}
	}
	id := r.PathValue("taskId")
	var userID, keyID string
	if err := b.db.QueryRow(r.Context(), `SELECT user_id,api_key_id FROM image_async_task WHERE id=$1`, id).Scan(&userID, &keyID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return &apiError{404, "NOT_FOUND", "Image async task not found"}
		}
		return err
	}
	worker := &mediaWorker{backend: b}
	claimed, err := worker.claimImageTask(r.Context(), id)
	if err != nil {
		return err
	}
	if claimed != "" {
		if err = worker.processClaimedImage(r.Context(), claimed); err != nil {
			return err
		}
	}
	output, err := b.imageAsyncUOLStatus(r, id, &apiPrincipal{UserID: userID, KeyID: keyID})
	if err != nil {
		return err
	}
	writeJSON(w, 200, output)
	return nil
}
