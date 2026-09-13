package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"github.com/jackc/pgx/v5"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"time"
)

func (b *backend) registerVideoUOLRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/internal/video/generate", b.endpoint(b.handleInternalVideoGenerate))
	mux.HandleFunc("POST /api/internal/video/status", b.endpoint(b.handleInternalVideoStatus))
	mux.HandleFunc("POST /api/internal/video/inputs", b.endpoint(b.handleInternalVideoInputs))
	mux.HandleFunc("POST /api/internal/video/gemini", b.endpoint(b.handleInternalVideoGemini))
	mux.HandleFunc("POST /api/internal/video/gemini/status", b.endpoint(b.handleInternalVideoGeminiStatus))
	mux.HandleFunc("POST /api/internal/video/account-input-cleanup", b.endpoint(b.handleInternalVideoCleanup))
}
func (b *backend) internalVideoPrincipal(r *http.Request) (string, string, string, error) {
	if p, ok := b.signedInternalPrincipal(r); ok {
		if p.Type == "apiKey" {
			return p.UserID, p.APIKeyID, "external:" + p.UserID + ":" + p.APIKeyID, nil
		}
		return p.UserID, "", "session:" + p.UserID, nil
	}
	s, e := b.requireSession(r)
	if e != nil {
		return "", "", "", e
	}
	return s.User.ID, "", "session:" + s.User.ID, nil
}
func videoUOLStatus(status, stage string) string {
	if status == "completed" {
		return "completed"
	}
	if status == "failed" {
		return "failed"
	}
	if stage == "created" || stage == "queued" {
		return "queued"
	}
	return "in_progress"
}
func videoUOLBilling(credits int) map[string]any {
	return map[string]any{"kind": "legacy", "mode": "per_second", "unit": "second", "unitPrice": nil, "creditsPerSecond": nil, "quotedCredits": nil, "actualCredits": credits}
}
func (b *backend) handleInternalVideoGenerate(w http.ResponseWriter, r *http.Request) error {
	userID, keyID, scope, e := b.internalVideoPrincipal(r)
	if e != nil {
		return e
	}
	body, e := decodeObject(r)
	if e != nil {
		return e
	}
	clientID := rawString(body, "clientRequestId", "client_request_id")
	if clientID == "" {
		return invalid("clientRequestId is required")
	}
	prompt, model := rawString(body, "prompt"), rawString(body, "model")
	ratio, resolution := rawString(body, "aspectRatio", "aspect_ratio"), rawString(body, "resolution")
	duration := rawInt(body, "duration", "duration_seconds", "seconds")
	if prompt == "" || model == "" || ratio == "" || resolution == "" || duration <= 0 {
		return invalid("prompt, model, duration, aspectRatio and resolution are required")
	}
	digest := sha256.Sum256([]byte(scope + "\x00" + clientID))
	id := "video_" + hex.EncodeToString(digest[:])[:32]
	input, _ := json.Marshal(body)
	_, e = b.db.Exec(r.Context(), `INSERT INTO video_generation(id,user_id,api_key_id,principal_scope,model,prompt,duration_seconds,aspect_ratio,resolution,output_width,output_height,status,stage,input_manifest,metadata) VALUES($1,$2,NULLIF($3,''),$4,$5,$6,$7,$8,$9,1024,1024,'pending','created',$10,$10) ON CONFLICT (id) DO NOTHING`, id, userID, keyID, scope, model, prompt, duration, ratio, resolution, input)
	if e != nil {
		return e
	}
	if operationID := rawString(body, "geminiOperationId", "gemini_operation_id"); operationID != "" {
		if _, e = b.db.Exec(r.Context(), `UPDATE video_generation SET public_operation_id=$1,updated_at=now() WHERE id=$2 AND user_id=$3`, operationID, id, userID); e != nil {
			return e
		}
	}
	if callbackURL := rawString(body, "callbackUrl", "callback_url"); callbackURL != "" {
		u, parseErr := url.Parse(callbackURL)
		if parseErr != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
			return invalid("Invalid video callback URL")
		}
		if _, e = b.db.Exec(r.Context(), `INSERT INTO video_generation_callback_delivery(id,video_generation_id,callback_url) VALUES($1,$2,$3) ON CONFLICT (video_generation_id) DO UPDATE SET callback_url=excluded.callback_url,status='pending',attempt_count=0,next_attempt_at=now(),updated_at=now()`, newRequestID(), id, callbackURL); e != nil {
			return e
		}
	}
	var status, stage string
	var credits int
	var taskErr *string
	if e = b.db.QueryRow(r.Context(), `SELECT status,stage,COALESCE(credits_consumed,0),error FROM video_generation WHERE id=$1 AND user_id=$2`, id, userID).Scan(&status, &stage, &credits, &taskErr); e != nil {
		return e
	}
	result := map[string]any{"taskId": id, "status": videoUOLStatus(status, stage), "billing": videoUOLBilling(credits)}
	if taskErr != nil && *taskErr != "" {
		result["error"] = *taskErr
	}
	if b.redis != nil {
		_ = b.redis.Publish(r.Context(), "fluxmedia:media:wakeup", id).Err()
	}
	writeJSON(w, 200, result)
	return nil
}
func (b *backend) handleInternalVideoStatus(w http.ResponseWriter, r *http.Request) error {
	userID, keyID, scope, e := b.internalVideoPrincipal(r)
	if e != nil {
		return e
	}
	body, e := decodeObject(r)
	if e != nil {
		return e
	}
	taskID := rawString(body, "taskId", "task_id")
	if taskID == "" {
		return invalid("taskId is required")
	}
	var model, status, stage, ratio, resolution string
	var duration, credits int
	var created time.Time
	var completed *time.Time
	var taskErr *string
	var manifest, metadata []byte
	e = b.db.QueryRow(r.Context(), `SELECT model,status,stage,aspect_ratio,resolution,duration_seconds,COALESCE(credits_consumed,0),created_at,completed_at,error,input_manifest,metadata FROM video_generation WHERE id=$1 AND user_id=$2 AND principal_scope=$3 AND (api_key_id IS NOT DISTINCT FROM NULLIF($4,''))`, taskID, userID, scope, keyID).Scan(&model, &status, &stage, &ratio, &resolution, &duration, &credits, &created, &completed, &taskErr, &manifest, &metadata)
	if e != nil {
		if e == pgx.ErrNoRows {
			return &apiError{404, "NOT_FOUND", "Video task not found"}
		}
		return e
	}
	var decoded map[string]any
	_ = json.Unmarshal(manifest, &decoded)
	input := map[string]any{"mode": "none", "count": 0}
	if _, ok := decoded["firstFrame"]; ok {
		input["mode"], input["count"] = "first-frame", 1
	}
	if refs, ok := decoded["referenceImages"].([]any); ok && len(refs) > 0 {
		input["mode"], input["count"] = "references", len(refs)
	}
	var meta map[string]any
	_ = json.Unmarshal(metadata, &meta)
	audio, _ := meta["generateAudio"].(bool)
	result := map[string]any{"taskId": taskID, "status": videoUOLStatus(status, stage), "model": model, "duration": duration, "aspectRatio": ratio, "resolution": resolution, "generateAudio": audio, "input": input, "billing": videoUOLBilling(credits), "createdAt": created.UTC().Format(time.RFC3339Nano)}
	if taskErr != nil && *taskErr != "" {
		result["error"] = *taskErr
	}
	if completed != nil {
		result["completedAt"] = completed.UTC().Format(time.RFC3339Nano)
	}
	if status == "completed" {
		var key, bucket string
		_ = b.db.QueryRow(r.Context(), `SELECT COALESCE(storage_key,''),COALESCE(storage_bucket,'') FROM video_generation WHERE id=$1`, taskID).Scan(&key, &bucket)
		if key != "" {
			result["videoUrl"] = "/api/storage/" + urlPathEscape(bucket) + "/" + urlPathEscape(key)
		}
	}
	writeJSON(w, 200, result)
	return nil
}
func (b *backend) handleInternalVideoInputs(w http.ResponseWriter, r *http.Request) error {
	userID, keyID, scope, e := b.internalVideoPrincipal(r)
	if e != nil {
		return e
	}
	body, e := decodeObject(r)
	if e != nil {
		return e
	}
	taskID := rawString(body, "taskId", "task_id")
	if taskID == "" {
		return invalid("taskId is required")
	}
	var manifest []byte
	e = b.db.QueryRow(r.Context(), `SELECT input_manifest FROM video_generation WHERE id=$1 AND user_id=$2 AND principal_scope=$3 AND (api_key_id IS NOT DISTINCT FROM NULLIF($4,''))`, taskID, userID, scope, keyID).Scan(&manifest)
	if e == pgx.ErrNoRows {
		return &apiError{404, "NOT_FOUND", "Video task not found"}
	}
	if e != nil {
		return e
	}
	var decoded any
	_ = json.Unmarshal(manifest, &decoded)
	writeJSON(w, 200, map[string]any{"taskId": taskID, "inputs": decoded})
	return nil
}
func (b *backend) handleInternalVideoGemini(w http.ResponseWriter, r *http.Request) error {
	return b.handleInternalVideoGenerate(w, r)
}
func (b *backend) handleInternalVideoGeminiStatus(w http.ResponseWriter, r *http.Request) error {
	userID, keyID, scope, e := b.internalVideoPrincipal(r)
	if e != nil {
		return e
	}
	body, e := decodeObject(r)
	if e != nil {
		return e
	}
	operationName := rawString(body, "operationName", "operation_name")
	operationID := operationName[strings.LastIndex(operationName, "/")+1:]
	if operationID == "" {
		return &apiError{404, "NOT_FOUND", "Operation not found"}
	}
	var taskID string
	e = b.db.QueryRow(r.Context(), `SELECT id FROM video_generation WHERE public_operation_id=$1 AND user_id=$2 AND principal_scope=$3 AND (api_key_id IS NOT DISTINCT FROM NULLIF($4,''))`, operationID, userID, scope, keyID).Scan(&taskID)
	if e == pgx.ErrNoRows {
		return &apiError{404, "NOT_FOUND", "Operation not found"}
	}
	if e != nil {
		return e
	}
	body["taskId"], _ = json.Marshal(taskID)
	encoded, _ := json.Marshal(body)
	r.Body = io.NopCloser(bytes.NewReader(encoded))
	recorder := httptest.NewRecorder()
	if e = b.handleInternalVideoStatus(recorder, r); e != nil {
		return e
	}
	var status map[string]any
	if json.Unmarshal(recorder.Body.Bytes(), &status) != nil {
		return &apiError{500, "INTERNAL_SERVER_ERROR", "Invalid video status"}
	}
	name := operationName
	done := status["status"] == "completed" || status["status"] == "failed"
	result := map[string]any{"name": name, "done": done}
	if status["status"] == "failed" {
		result["error"] = map[string]any{"code": 13, "message": status["error"]}
	}
	if status["status"] == "completed" {
		if uri, ok := status["videoUrl"].(string); ok && uri != "" {
			result["response"] = map[string]any{"generateVideoResponse": map[string]any{"generatedSamples": []any{map[string]any{"video": map[string]any{"uri": uri}}}}}
		}
	}
	writeJSON(w, 200, result)
	return nil
}
func (b *backend) handleInternalVideoCleanup(w http.ResponseWriter, r *http.Request) error {
	_, _, _, e := b.internalVideoPrincipal(r)
	if e != nil {
		return e
	}
	body, e := decodeObject(r)
	if e != nil {
		return e
	}
	requestID := rawString(body, "clientRequestId", "client_request_id")
	if requestID == "" {
		return invalid("clientRequestId is required")
	}
	_ = requestID // cleanup worker will reconcile staged objects after account deletion.
	writeJSON(w, 200, map[string]any{"cleanupRequestId": newRequestID(), "status": "queued"})
	return nil
}
