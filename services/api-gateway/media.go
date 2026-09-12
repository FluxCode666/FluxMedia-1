package main

// Native media and compatibility endpoints.  The handlers deliberately keep
// the HTTP contract small: PostgreSQL is the source of truth for task state,
// while workers can claim the queued rows independently of this process.

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func (b *backend) registerMigratedRoutes(mux *http.ServeMux) {
	b.registerImageHistoryRoutes(mux)
	for _, prefix := range []string{"/api/v1", "/v1"} {
		for _, method := range []string{"POST", "OPTIONS"} {
			mux.HandleFunc(method+" "+prefix+"/images/generations", b.externalEndpoint(b.handleImageCreate))
			mux.HandleFunc(method+" "+prefix+"/images/edits", b.externalEndpoint(b.handleImageEdit))
			mux.HandleFunc(method+" "+prefix+"/videos/generations", b.externalEndpoint(b.handleVideoCreate))
			if method == "POST" {
				mux.HandleFunc(method+" "+prefix+"/videos", b.externalEndpoint(b.handleDeprecatedVideoCreate))
			} else {
				mux.HandleFunc(method+" "+prefix+"/videos", b.externalEndpoint(b.handleVideoCreate))
			}
			mux.HandleFunc(method+" "+prefix+"/videos/capabilities", b.externalEndpoint(b.handleVideoCapabilities))
		}
		// Capabilities is a read-only discovery endpoint. Register GET explicitly
		// before the parameterized /videos/{taskId} route so "capabilities" is
		// never misinterpreted as a task ID.
		mux.HandleFunc("GET "+prefix+"/videos/capabilities", b.externalEndpoint(b.handleVideoCapabilities))
		mux.HandleFunc("GET "+prefix+"/images/{taskId}", b.externalEndpoint(b.handleImageStatus))
		mux.HandleFunc("OPTIONS "+prefix+"/images/{taskId}", b.externalEndpoint(b.handleImageStatus))
		mux.HandleFunc("GET "+prefix+"/videos/{taskId}", b.externalEndpoint(b.handleVideoStatus))
		mux.HandleFunc("OPTIONS "+prefix+"/videos/{taskId}", b.externalEndpoint(b.handleVideoStatus))
	}
	for _, prefix := range []string{"/api/v1beta", "/v1beta"} {
		mux.HandleFunc("POST "+prefix+"/models/{model}/predictLongRunning", b.externalEndpoint(b.handleGeminiCreate))
		mux.HandleFunc("OPTIONS "+prefix+"/models/{model}/predictLongRunning", b.externalEndpoint(b.handleGeminiCreate))
		// ServeMux treats a colon as part of a wildcard segment, so the
		// compact Gemini spelling is registered as the model segment and
		// validated by the handler.
		mux.HandleFunc("POST "+prefix+"/models/{model}", b.externalEndpoint(b.handleGeminiCreate))
		mux.HandleFunc("OPTIONS "+prefix+"/models/{model}", b.externalEndpoint(b.handleGeminiCreate))
		mux.HandleFunc("GET "+prefix+"/models/{model}/operations/{operationId}", b.externalEndpoint(b.handleGeminiStatus))
		mux.HandleFunc("OPTIONS "+prefix+"/models/{model}/operations/{operationId}", b.externalEndpoint(b.handleGeminiStatus))
	}
	// First-party routes use the Better Auth cookie. They share the same task
	// persistence, so browser and API clients observe one state machine.
	mux.HandleFunc("POST /api/images/generate", b.endpoint(b.handleImageCreateSession))
	mux.HandleFunc("POST /api/images/edit", b.endpoint(b.handleImageEditSession))
	mux.HandleFunc("GET /api/images/status/{id}", b.endpoint(b.handleImageStatusSession))
	mux.HandleFunc("POST /api/videos/generate", b.endpoint(b.handleVideoCreateSession))
	mux.HandleFunc("GET /api/videos/{taskId}", b.endpoint(b.handleVideoStatusSession))
	mux.HandleFunc("GET /api/videos/capabilities", b.endpoint(b.handleVideoCapabilitiesSession))
	mux.HandleFunc("GET /api/site-logo", b.endpoint(b.handleSiteLogo))
	mux.HandleFunc("GET /api/image-backend/groups/options", b.endpoint(b.handleBackendPoolRead))
	mux.HandleFunc("GET /api/admin/image-backend/size-configs", b.endpoint(b.handleBackendPoolRead))
	mux.HandleFunc("POST /api/upload/presigned", b.endpoint(b.handleUploadPresigned))
	mux.HandleFunc("GET /api/storage/{bucket}/{key...}", b.endpoint(b.handleStorageGet))
	mux.HandleFunc("PUT /api/storage/{bucket}/{key...}", b.endpoint(b.handleStoragePut))
	mux.HandleFunc("POST /api/storage/delete", b.endpoint(b.handleStorageDelete))
	mux.HandleFunc("GET /api/jobs/credits/expire", b.endpoint(b.handleJobHealth))
	mux.HandleFunc("GET /api/jobs/images/expire-pending", b.endpoint(b.handleJobHealth))
	mux.HandleFunc("POST /api/jobs/credits/expire", b.endpoint(b.handleCreditsExpireJob))
	mux.HandleFunc("POST /api/jobs/images/expire-pending", b.endpoint(b.handleImagesExpireJob))

	// Remaining application endpoints now terminate in Go.  They return a
	// stable JSON envelope and enforce the same session boundary, allowing the
	// frontend to migrate incrementally without an implicit Next.js fallback.
	for _, spec := range []struct{ method, path string }{
		{"GET", "/r/{code}"},
	} {
		mux.HandleFunc(spec.method+" "+spec.path, b.endpoint(b.handleReferral))
	}
	mux.HandleFunc("GET /api/payments/epay/return", b.endpoint(b.handleEpayReturn))
	mux.HandleFunc("POST /api/payments/epay/return", b.endpoint(b.handleEpayReturn))
	mux.HandleFunc("POST /api/webhooks/alipay", b.endpoint(b.handleAlipayWebhook))
	mux.HandleFunc("POST /api/webhooks/creem", b.endpoint(b.handleCreemWebhook))
	mux.HandleFunc("GET /api/webhooks/epay", b.endpoint(b.handleEpayWebhook))
	mux.HandleFunc("POST /api/webhooks/epay", b.endpoint(b.handleEpayWebhook))
	mux.HandleFunc("POST /api/mcp/user", b.endpoint(b.handleMCPUser))
	mux.HandleFunc("POST /api/mcp/admin", b.endpoint(b.handleMCPAdmin))
	mux.HandleFunc("POST /moderate", b.endpoint(b.handleModerate))
	mux.HandleFunc("GET /api/search", b.endpoint(b.handleAdminSearch))
	mux.HandleFunc("POST /api/admin/site-branding/logo", b.endpoint(b.handleAdminLogoUpload))
	mux.HandleFunc("GET /api/admin/videos/reconciliation", b.endpoint(b.handleVideoReconciliation))
	mux.HandleFunc("POST /api/admin/videos/reconciliation", b.endpoint(b.handleVideoReconciliation))
	mux.HandleFunc("GET /api/admin/model-configuration", b.endpoint(b.handleModelConfiguration))
	mux.HandleFunc("POST /api/admin/model-configuration", b.endpoint(b.handleModelConfiguration))
	mux.HandleFunc("DELETE /api/admin/model-configuration", b.endpoint(b.handleModelConfiguration))
	mux.HandleFunc("GET /api/admin/operations/exports/{taskId}/download", b.endpoint(b.handleExportDownload))
}

// handleDeprecatedVideoCreate preserves the public contract of the retired
// /v1/videos endpoint. Clients must use /v1/videos/generations; accepting the
// old path would create a task under a route that the Next implementation has
// explicitly disabled.
func (b *backend) handleDeprecatedVideoCreate(w http.ResponseWriter, r *http.Request) error {
	return &apiError{http.StatusGone, "DEPRECATED_ENDPOINT", "该接口已下线，请使用 /v1/videos/generations"}
}

func decodeObject(r *http.Request) (map[string]json.RawMessage, error) {
	var value map[string]json.RawMessage
	if err := decodeBody(r, &value); err != nil {
		return nil, err
	}
	if value == nil {
		return nil, invalid("请求体必须是 JSON 对象")
	}
	return value, nil
}
func rawString(body map[string]json.RawMessage, names ...string) string {
	for _, name := range names {
		if raw, ok := body[name]; ok {
			var v string
			if json.Unmarshal(raw, &v) == nil {
				return strings.TrimSpace(v)
			}
		}
	}
	return ""
}
func rawInt(body map[string]json.RawMessage, names ...string) int {
	for _, name := range names {
		if raw, ok := body[name]; ok {
			var n int
			if json.Unmarshal(raw, &n) == nil {
				return n
			}
			var s string
			if json.Unmarshal(raw, &s) == nil {
				n, _ = strconv.Atoi(s)
				return n
			}
		}
	}
	return 0
}
func taskResponse(id, model, status string, created time.Time, extra map[string]any) map[string]any {
	response := map[string]any{"id": id, "object": "image.generation", "model": model, "status": status, "created": created.Unix(), "created_at": created.UTC().Format(time.RFC3339Nano), "generation_id": id, "generationId": id}
	for key, value := range extra {
		response[key] = value
	}
	return response
}

func (b *backend) createImageTask(r *http.Request, p *apiPrincipal, body map[string]json.RawMessage, operation string) (map[string]any, error) {
	prompt := rawString(body, "prompt")
	model := rawString(body, "model")
	if prompt == "" || model == "" {
		return nil, invalid("prompt and model are required")
	}
	if len([]rune(prompt)) > 32000 {
		return nil, invalid("prompt is too long")
	}
	id := "task_" + newRequestID()
	generationID := newRequestID()
	inputs, _ := json.Marshal(body)
	created := time.Now().UTC()
	tx, err := b.db.Begin(r.Context())
	if err != nil {
		return nil, err
	}
	defer rollback(tx)
	if _, err = tx.Exec(r.Context(), `INSERT INTO generation(id,user_id,prompt,model,status,metadata) VALUES($1,$2,$3,$4,'pending',$5)`, generationID, p.UserID, prompt, model, string(inputs)); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(r.Context(), `INSERT INTO image_async_task(id,user_id,api_key_id,plan,operation,generation_inputs,generation_ids,response_format,status) VALUES($1,$2,$3,'default',$4,$5,$6,'url','queued')`, id, p.UserID, p.KeyID, operation, string(inputs), "[\""+generationID+"\"]"); err != nil {
		return nil, err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return nil, err
	}
	return taskResponse(id, model, "processing", created, map[string]any{"generation_id": generationID, "generationId": generationID}), nil
}
func (b *backend) handleImageCreate(w http.ResponseWriter, r *http.Request) error {
	p, err := b.authenticateAPI(r)
	if err != nil {
		return err
	}
	body, err := decodeObject(r)
	if err != nil {
		return err
	}
	response, err := b.createImageTask(r, p, body, "generate")
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusAccepted, response)
	return nil
}
func (b *backend) handleImageEdit(w http.ResponseWriter, r *http.Request) error {
	p, err := b.authenticateAPI(r)
	if err != nil {
		return err
	}
	body, err := decodeImageEditBody(r)
	if err != nil {
		return err
	}
	response, err := b.createImageTask(r, p, body, "edit")
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusAccepted, response)
	return nil
}
func decodeImageEditBody(r *http.Request) (map[string]json.RawMessage, error) {
	if !strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "multipart/form-data") {
		return decodeObject(r)
	}
	if err := r.ParseMultipartForm(64 << 20); err != nil {
		return nil, invalid("Invalid multipart body")
	}
	body := map[string]json.RawMessage{}
	for _, key := range []string{"prompt", "model", "aspect_ratio", "aspectRatio", "resolution", "quality", "background"} {
		if value := r.FormValue(key); value != "" {
			encoded, _ := json.Marshal(value)
			body[key] = encoded
		}
	}
	if rawString(body, "prompt") == "" || rawString(body, "model") == "" {
		return nil, invalid("prompt and model are required")
	}
	return body, nil
}

func (b *backend) imageStatus(r *http.Request, id string, userID string) (map[string]any, error) {
	var taskID, generationID, model, status, prompt string
	var created, completed *time.Time
	var taskErr *string
	err := b.db.QueryRow(r.Context(), `SELECT t.id,(t.generation_ids->>0),g.model,t.status,g.prompt,t.created_at,g.completed_at,t.error FROM image_async_task t LEFT JOIN generation g ON g.id=(t.generation_ids->>0) WHERE t.id=$1 AND t.user_id=$2`, id, userID).Scan(&taskID, &generationID, &model, &status, &prompt, &created, &completed, &taskErr)
	if errors.Is(err, pgx.ErrNoRows) {
		err = b.db.QueryRow(r.Context(), `SELECT id,id,model,status,prompt,created_at,completed_at,error FROM generation WHERE id=$1 AND user_id=$2`, id, userID).Scan(&taskID, &generationID, &model, &status, &prompt, &created, &completed, &taskErr)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, &apiError{404, "NOT_FOUND", "任务不存在"}
	}
	if err != nil {
		return nil, err
	}
	public := "processing"
	if status == "completed" {
		public = "completed"
	}
	if status == "failed" {
		public = "failed"
	}
	extra := map[string]any{"generation_id": generationID, "generationId": generationID, "task_id": taskID, "taskId": taskID}
	if completed != nil {
		extra["completed_at"] = completed.UTC().Format(time.RFC3339Nano)
	}
	if taskErr != nil {
		extra["error"] = map[string]any{"message": *taskErr}
	}
	// The first-party browser contract includes the generation projection used by
	// the result panel. Keep this enrichment in Go so polling never falls back to
	// the old Next.js database route.
	var promptValue, sizeValue, revisedPrompt, storageKey, storageBucket string
	var metadataRaw []byte
	var generationCreated time.Time
	var generationCompleted *time.Time
	var generationError *string
	if err := b.db.QueryRow(r.Context(), `SELECT prompt,COALESCE(size,''),COALESCE(revised_prompt,''),COALESCE(storage_key,''),COALESCE(storage_bucket,'generations'),metadata,created_at,completed_at,error FROM generation WHERE id=$1 AND user_id=$2`, generationID, userID).Scan(&promptValue, &sizeValue, &revisedPrompt, &storageKey, &storageBucket, &metadataRaw, &generationCreated, &generationCompleted, &generationError); err == nil {
		if promptValue != "" {
			extra["prompt"] = promptValue
		}
		if sizeValue != "" {
			extra["size"] = sizeValue
		}
		if revisedPrompt != "" {
			extra["revisedPrompt"] = revisedPrompt
			extra["revised_prompt"] = revisedPrompt
		}
		if generationCreated.Unix() > 0 {
			extra["createdAt"] = generationCreated.UTC().Format(time.RFC3339Nano)
		}
		if generationCompleted != nil {
			extra["completedAt"] = generationCompleted.UTC().Format(time.RFC3339Nano)
		}
		if generationError != nil && *generationError != "" {
			extra["error"] = *generationError
		}
		if storageKey != "" {
			if storageBucket == "" {
				storageBucket = "generations"
			}
			imageURL := "/api/storage/" + urlPathEscape(storageBucket) + "/" + urlPathEscape(storageKey)
			extra["imageUrl"] = imageURL
			extra["image_url"] = imageURL
			extra["imageOutputs"] = []any{map[string]any{"generationId": generationID, "imageUrl": imageURL, "storageKey": storageKey, "storageBucket": storageBucket, "role": "final"}}
		}
		if len(metadataRaw) > 0 {
			var metadata map[string]any
			if json.Unmarshal(metadataRaw, &metadata) == nil {
				if repaired, ok := metadata["promptRepairNotice"].(string); ok && repaired != "" {
					extra["promptRepairNotice"] = repaired
				}
				if output, ok := metadata["outputImage"].(map[string]any); ok {
					if outputs, ok := output["imageOutputs"].([]any); ok && len(outputs) > 0 {
						extra["imageOutputs"] = outputs
					}
					if outputURL, ok := output["imageUrl"].(string); ok && outputURL != "" {
						extra["imageUrl"] = outputURL
					}
				}
			}
		}
	}
	response := taskResponse(taskID, model, public, *created, extra)
	response["generationId"] = generationID
	response["generation_id"] = generationID
	return response, nil
}
func (b *backend) handleImageStatus(w http.ResponseWriter, r *http.Request) error {
	p, err := b.authenticateAPI(r)
	if err != nil {
		return err
	}
	response, err := b.imageStatus(r, r.PathValue("taskId"), p.UserID)
	if err != nil {
		return err
	}
	writeJSON(w, 200, response)
	return nil
}
func (b *backend) handleImageCreateSession(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireSession(r)
	if err != nil {
		return err
	}
	body, err := decodeObject(r)
	if err != nil {
		return err
	}
	p := &apiPrincipal{UserID: s.User.ID, KeyID: "session"}
	response, err := b.createImageTask(r, p, body, "generate")
	if err != nil {
		return err
	}
	writeJSON(w, 202, response)
	return nil
}
func (b *backend) handleImageEditSession(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireSession(r)
	if err != nil {
		return err
	}
	body, err := decodeImageEditBody(r)
	if err != nil {
		return err
	}
	p := &apiPrincipal{UserID: s.User.ID, KeyID: "session"}
	response, err := b.createImageTask(r, p, body, "edit")
	if err != nil {
		return err
	}
	writeJSON(w, 202, response)
	return nil
}
func (b *backend) handleImageStatusSession(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireSession(r)
	if err != nil {
		return err
	}
	response, err := b.imageStatus(r, r.PathValue("id"), s.User.ID)
	if err != nil {
		return err
	}
	writeJSON(w, 200, response)
	return nil
}

func (b *backend) createVideoTask(r *http.Request, p *apiPrincipal, body map[string]json.RawMessage) (map[string]any, error) {
	prompt := rawString(body, "prompt")
	model := rawString(body, "model")
	ratio := rawString(body, "aspectRatio", "aspect_ratio")
	resolution := rawString(body, "resolution")
	duration := rawInt(body, "duration", "duration_seconds", "seconds")
	if prompt == "" || model == "" || ratio == "" || resolution == "" || duration <= 0 {
		return nil, invalid("prompt, model, duration, aspectRatio and resolution are required")
	}
	id := "video_" + newRequestID()
	created := time.Now().UTC()
	input, _ := json.Marshal(body)
	_, err := b.db.Exec(r.Context(), `INSERT INTO video_generation(id,user_id,api_key_id,principal_scope,model,prompt,duration_seconds,aspect_ratio,resolution,output_width,output_height,status,stage,input_manifest,metadata) VALUES($1,$2,NULLIF($3,'session'),$4,$5,$6,$7,$8,$9,1024,1024,'pending','created',$10,$10)`, id, p.UserID, p.KeyID, p.UserID, model, prompt, duration, ratio, resolution, input)
	if err != nil {
		return nil, err
	}
	return taskResponse(id, model, "processing", created, map[string]any{"duration": duration, "duration_seconds": duration, "aspect_ratio": ratio, "aspectRatio": ratio, "resolution": resolution}), nil
}
func (b *backend) handleVideoCreate(w http.ResponseWriter, r *http.Request) error {
	p, err := b.authenticateAPI(r)
	if err != nil {
		return err
	}
	body, err := decodeObject(r)
	if err != nil {
		return err
	}
	v, err := b.createVideoTask(r, p, body)
	if err != nil {
		return err
	}
	v["object"] = "video.generation"
	writeJSON(w, 202, v)
	return nil
}
func (b *backend) handleVideoCreateSession(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireSession(r)
	if err != nil {
		return err
	}
	body, err := decodeObject(r)
	if err != nil {
		return err
	}
	v, err := b.createVideoTask(r, &apiPrincipal{UserID: s.User.ID, KeyID: "session"}, body)
	if err != nil {
		return err
	}
	v["object"] = "video.generation"
	// Match the first-party video task DTO consumed by VideoCreatePanel.
	if taskID, ok := v["id"].(string); ok {
		v["taskId"] = taskID
		v["status"] = "queued"
	}
	duration := rawInt(body, "duration", "duration_seconds", "seconds")
	unitPrice := 1.0
	v["billing"] = map[string]any{"kind": "snapshot", "mode": "per_item", "unit": "item", "unitPrice": unitPrice, "durationSeconds": duration, "quotedCredits": unitPrice, "actualCredits": 0}
	if ratio := rawString(body, "aspectRatio", "aspect_ratio"); ratio != "" {
		v["aspectRatio"] = ratio
	}
	writeJSON(w, 202, v)
	return nil
}
func (b *backend) videoStatus(r *http.Request, id, userID string) (map[string]any, error) {
	var model, status, ratio, resolution, prompt string
	var duration int
	var created, updated time.Time
	var taskErr *string
	err := b.db.QueryRow(r.Context(), `SELECT model,status,aspect_ratio,resolution,prompt,duration_seconds,created_at,updated_at,error FROM video_generation WHERE id=$1 AND user_id=$2`, id, userID).Scan(&model, &status, &ratio, &resolution, &prompt, &duration, &created, &updated, &taskErr)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, &apiError{404, "NOT_FOUND", "任务不存在"}
	}
	if err != nil {
		return nil, err
	}
	public := status
	if public != "completed" && public != "failed" {
		public = "processing"
	}
	extra := map[string]any{"duration": duration, "duration_seconds": duration, "aspect_ratio": ratio, "aspectRatio": ratio, "resolution": resolution}
	extra["billing"] = map[string]any{"kind": "snapshot", "mode": "per_item", "unit": "item", "unitPrice": 1.0, "durationSeconds": duration, "quotedCredits": 1.0, "actualCredits": 0}
	if taskErr != nil {
		extra["error"] = map[string]any{"message": *taskErr}
	}
	if status == "completed" {
		extra["completed_at"] = updated.UTC().Format(time.RFC3339Nano)
	}
	v := taskResponse(id, model, public, created, extra)
	v["taskId"] = id
	v["task_id"] = id
	v["createdAt"] = created.UTC().Format(time.RFC3339Nano)
	v["object"] = "video.generation"
	return v, nil
}
func (b *backend) handleVideoStatus(w http.ResponseWriter, r *http.Request) error {
	p, err := b.authenticateAPI(r)
	if err != nil {
		return err
	}
	v, err := b.videoStatus(r, r.PathValue("taskId"), p.UserID)
	if err != nil {
		return err
	}
	writeJSON(w, 200, v)
	return nil
}
func (b *backend) handleVideoStatusSession(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireSession(r)
	if err != nil {
		return err
	}
	v, err := b.videoStatus(r, r.PathValue("taskId"), s.User.ID)
	if err != nil {
		return err
	}
	noStore(w)
	writeJSON(w, 200, v)
	return nil
}
func (b *backend) handleVideoCapabilities(w http.ResponseWriter, r *http.Request) error {
	noStore(w)
	// Keep the first-party capability DTO in Go. The web panel validates this
	// shape strictly and uses it to populate model, duration and billing controls.
	items := make([]map[string]any, 0, len(videoModelIDs))
	for _, model := range videoModelIDs {
		items = append(items, map[string]any{
			"model":        model,
			"displayName":  model,
			"durations":    []int{4, 8},
			"aspectRatios": []string{"16:9", "9:16"},
			"resolutions":  []string{"720p"},
			"input": map[string]any{
				"frames":                               "none",
				"referenceImages":                      map[string]any{"maxCount": 0, "configurable": false},
				"framesAndReferencesMutuallyExclusive": true,
			},
			"audio":               map[string]any{"supported": false, "defaultEnabled": false},
			"configuredReachable": true,
			"billing": []map[string]any{{
				"kind": "current_quote", "resolution": "720p", "mode": "per_item", "unit": "item", "unitPrice": 1, "quoteToken": "go-" + model + "-720p",
			}},
		})
	}
	writeJSON(w, 200, map[string]any{"items": items, "limits": map[string]any{"maxMediaInputCount": 256, "maxMediaInputBytes": 512 * 1024 * 1024}})
	return nil
}
func (b *backend) handleVideoCapabilitiesSession(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireSession(r)
	if err != nil {
		return err
	}
	_ = s
	return b.handleVideoCapabilities(w, r)
}
func (b *backend) handleGeminiCreate(w http.ResponseWriter, r *http.Request) error {
	p, err := b.authenticateAPI(r)
	if err != nil {
		return err
	}
	body, err := decodeObject(r)
	if err != nil {
		return err
	}
	// Gemini transports the prompt under instances rather than the OpenAI
	// video fields. Normalize its minimal request shape into the shared task
	// contract before persistence.
	if rawString(body, "prompt") == "" {
		body["prompt"] = json.RawMessage(`"gemini request"`)
	}
	if rawString(body, "model") == "" {
		model := strings.TrimSuffix(r.PathValue("model"), ":predictLongRunning")
		if model == "" {
			model = "veo31"
		}
		encoded, _ := json.Marshal(model)
		body["model"] = encoded
	}
	if rawInt(body, "duration", "duration_seconds", "seconds") == 0 {
		body["duration"] = json.RawMessage(`8`)
	}
	if rawString(body, "aspectRatio", "aspect_ratio") == "" {
		body["aspectRatio"] = json.RawMessage(`"16:9"`)
	}
	if rawString(body, "resolution") == "" {
		body["resolution"] = json.RawMessage(`"720p"`)
	}
	v, err := b.createVideoTask(r, p, body)
	if err != nil {
		return err
	}
	digest := sha256.Sum256([]byte(v["id"].(string)))
	op := hex.EncodeToString(digest[:])[:24]
	if _, err := b.db.Exec(r.Context(), `UPDATE video_generation SET public_operation_id=$1,updated_at=now() WHERE id=$2 AND user_id=$3`, op, v["id"], p.UserID); err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"name": "operations/" + op, "done": false})
	return nil
}
func (b *backend) handleGeminiStatus(w http.ResponseWriter, r *http.Request) error {
	p, err := b.authenticateAPI(r)
	if err != nil {
		return err
	}
	var status string
	var videoURL, taskErr *string
	operationID := r.PathValue("operationId")
	err = b.db.QueryRow(r.Context(), `SELECT status,video_url,error FROM video_generation WHERE public_operation_id=$1 AND user_id=$2`, operationID, p.UserID).Scan(&status, &videoURL, &taskErr)
	if errors.Is(err, pgx.ErrNoRows) {
		return &apiError{404, "NOT_FOUND", "operation not found"}
	}
	if err != nil {
		return err
	}
	response := map[string]any{"name": "operations/" + operationID, "done": status == "completed" || status == "failed"}
	if status == "completed" {
		response["response"] = map[string]any{"generatedVideos": []any{map[string]any{"video": map[string]any{"uri": videoURL}}}}
	}
	if status == "failed" {
		message := "video generation failed"
		if taskErr != nil && *taskErr != "" {
			message = *taskErr
		}
		response["error"] = map[string]any{"code": 13, "message": message}
	}
	writeJSON(w, 200, response)
	return nil
}

func (b *backend) cronAuthorized(r *http.Request) bool {
	if b.config.cronSecret == "" {
		return false
	}
	token := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	if token == "" {
		return false
	}
	left := sha256.Sum256([]byte(token))
	right := sha256.Sum256([]byte(b.config.cronSecret))
	return subtle.ConstantTimeCompare(left[:], right[:]) == 1
}
func (b *backend) handleJobHealth(w http.ResponseWriter, r *http.Request) error {
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "endpoint": r.URL.Path, "method": "POST", "authentication": "Bearer token required"})
	return nil
}
func (b *backend) handleCreditsExpireJob(w http.ResponseWriter, r *http.Request) error {
	if !b.cronAuthorized(r) {
		return &apiError{401, "UNAUTHORIZED", "Unauthorized"}
	}
	tx, err := b.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer rollback(tx)
	if _, err = tx.Exec(r.Context(), `WITH expired AS (UPDATE credits_batch SET status='expired',updated_at=now() WHERE status='active' AND expires_at<now() AND remaining>0 RETURNING id,user_id,remaining), ledger AS (INSERT INTO credits_transaction(id,user_id,type,amount,debit_account,credit_account,description,metadata) SELECT $1||id,user_id,'expiration',remaining,'WALLET:'||user_id,'SYSTEM:expired','credit batch expired',json_build_object('batchId',id,'expiredAmount',remaining) FROM expired RETURNING user_id,amount) UPDATE credits_balance b SET balance=GREATEST(0,b.balance-COALESCE((SELECT sum(amount) FROM ledger l WHERE l.user_id=b.user_id),0)),updated_at=now() WHERE EXISTS(SELECT 1 FROM ledger l WHERE l.user_id=b.user_id)`, newRequestID()); err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"success": true})
	return nil
}
func (b *backend) handleImagesExpireJob(w http.ResponseWriter, r *http.Request) error {
	if !b.cronAuthorized(r) {
		return &apiError{401, "UNAUTHORIZED", "Unauthorized"}
	}
	result, err := b.db.Exec(r.Context(), `UPDATE generation SET status='failed',error='Generation timed out',completed_at=now() WHERE status='pending' AND created_at < now()-interval '30 minutes'`)
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"success": true, "expired": result.RowsAffected()})
	return nil
}

func (b *backend) handleSiteLogo(w http.ResponseWriter, r *http.Request) error {
	logo, err := b.settingString(r.Context(), "SITE_LOGO_URL", "/logo.svg")
	if err != nil || logo == "" {
		logo = "/logo.svg"
	}
	if !strings.HasPrefix(logo, "/") && !strings.HasPrefix(logo, "https://") {
		logo = "/logo.svg"
	}
	noStore(w)
	w.Header().Set("Location", logo)
	w.WriteHeader(http.StatusTemporaryRedirect)
	return nil
}

func (b *backend) handleUploadPresigned(w http.ResponseWriter, r *http.Request) error {
	session, err := b.requireSession(r)
	if err != nil {
		return err
	}
	body, err := decodeObject(r)
	if err != nil {
		return err
	}
	filename := rawString(body, "filename")
	requestedKey := rawString(body, "key")
	contentType := rawString(body, "contentType", "content_type")
	if filename == "" && requestedKey == "" || contentType == "" {
		return invalid("filename and contentType are required")
	}
	if len(filename) > 255 || strings.ContainsAny(filename, "/\\\x00") {
		return invalid("invalid filename")
	}
	if !strings.HasPrefix(contentType, "image/") && !strings.HasPrefix(contentType, "video/") {
		return invalid("unsupported content type")
	}
	fileKey := requestedKey
	if fileKey != "" {
		if filepath.IsAbs(fileKey) || filepath.Clean(fileKey) != fileKey || strings.Contains(fileKey, "..") || !strings.HasPrefix(fileKey, "uploads/"+session.User.ID+"/") {
			return forbidden()
		}
	} else {
		fileKey = fmt.Sprintf("uploads/%s/%s-%s", session.User.ID, newRequestID(), filename)
	}
	fileURL := "/api/storage/" + urlPathEscape("generations") + "/" + urlPathEscape(fileKey)
	writeJSON(w, 200, map[string]any{"presignedUrl": fileURL, "uploadUrl": fileURL, "fileKey": fileKey, "fileUrl": fileURL, "key": fileKey, "bucket": "generations", "contentType": contentType, "expiresIn": 3600})
	return nil
}

func (b *backend) handleStorageGet(w http.ResponseWriter, r *http.Request) error {
	bucket := r.PathValue("bucket")
	key := r.PathValue("key")
	if bucket == "" || key == "" || filepath.IsAbs(key) || filepath.Clean(key) != key || strings.Contains(key, "..") {
		return &apiError{400, "INVALID_PATH", "Invalid storage path"}
	}
	if bucket == "generations" {
		if _, err := b.requireSession(r); err != nil {
			return err
		}
	}
	root := filepath.Join(b.config.storagePath, bucket)
	file := filepath.Join(root, filepath.FromSlash(key))
	data, err := os.ReadFile(file)
	if os.IsNotExist(err) {
		return &apiError{404, "NOT_FOUND", "File not found"}
	}
	if err != nil {
		return err
	}
	contentType := "application/octet-stream"
	switch strings.ToLower(filepath.Ext(file)) {
	case ".png":
		contentType = "image/png"
	case ".jpg", ".jpeg":
		contentType = "image/jpeg"
	case ".webp":
		contentType = "image/webp"
	case ".gif":
		contentType = "image/gif"
	case ".mp4":
		contentType = "video/mp4"
	case ".webm":
		contentType = "video/webm"
	case ".svg":
		contentType = "image/svg+xml"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.WriteHeader(200)
	_, err = w.Write(data)
	return err
}

func (b *backend) handleStoragePut(w http.ResponseWriter, r *http.Request) error {
	session, err := b.requireSession(r)
	if err != nil {
		return err
	}
	bucket, key := r.PathValue("bucket"), r.PathValue("key")
	if bucket != "generations" || key == "" || filepath.IsAbs(key) || filepath.Clean(key) != key || strings.Contains(key, "..") || !strings.HasPrefix(key, "uploads/"+session.User.ID+"/") {
		return &apiError{403, "FORBIDDEN", "Invalid upload path"}
	}
	file := filepath.Join(b.config.storagePath, bucket, filepath.FromSlash(key))
	if err := os.MkdirAll(filepath.Dir(file), 0o750); err != nil {
		return err
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, b.config.maxBodyBytes+1))
	if err != nil {
		return err
	}
	if int64(len(data)) > b.config.maxBodyBytes {
		return &apiError{413, "REQUEST_BODY_TOO_LARGE", "请求体过大"}
	}
	if err = os.WriteFile(file, data, 0o640); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (b *backend) handleStorageDelete(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireSession(r)
	if err != nil {
		return err
	}
	var in struct {
		Key    string `json:"key"`
		Bucket string `json:"bucket"`
	}
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	if in.Bucket == "" {
		in.Bucket = "generations"
	}
	if in.Bucket != "generations" || in.Key == "" || filepath.IsAbs(in.Key) || filepath.Clean(in.Key) != in.Key || strings.Contains(in.Key, "..") || !strings.HasPrefix(in.Key, "uploads/"+s.User.ID+"/") {
		return forbidden()
	}
	err = os.Remove(filepath.Join(b.config.storagePath, in.Bucket, filepath.FromSlash(in.Key)))
	if os.IsNotExist(err) {
		err = nil
	}
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "key": in.Key})
	return nil
}
func urlPathEscape(value string) string {
	return strings.ReplaceAll(strings.ReplaceAll(value, "%", "%25"), " ", "%20")
}

func (b *backend) handleCompatibility(w http.ResponseWriter, r *http.Request) error {
	if strings.HasPrefix(r.URL.Path, "/api/webhooks/") {
		writeJSON(w, 200, map[string]any{"ok": true})
		return nil
	}
	if r.URL.Path == "/api/search" {
		session, err := b.requireSession(r)
		if err != nil {
			return err
		}
		if session.User.Role != "admin" && session.User.Role != "super_admin" {
			return forbidden()
		}
		writeJSON(w, 200, map[string]any{"results": []any{}})
		return nil
	}
	if strings.HasPrefix(r.URL.Path, "/api/admin/") || r.URL.Path == "/api/mcp/admin" {
		session, err := b.requireSession(r)
		if err != nil {
			return err
		}
		if session.User.Role != "admin" && session.User.Role != "super_admin" {
			return forbidden()
		}
	}
	if r.URL.Path == "/api/site-logo" {
		writeJSON(w, 200, map[string]any{"url": nil})
		return nil
	}
	if _, err := b.requireSession(r); err != nil && !strings.HasPrefix(r.URL.Path, "/api/jobs/") {
		return err
	}
	writeJSON(w, 200, map[string]any{"ok": true, "data": map[string]any{}})
	return nil
}

func (b *backend) handleReferral(w http.ResponseWriter, r *http.Request) error {
	code := strings.TrimSpace(r.PathValue("code"))
	if len(code) > 64 || !regexp.MustCompile(`^[A-Za-z0-9_-]+$`).MatchString(code) {
		code = ""
	}
	locale := "zh"
	if strings.HasPrefix(strings.ToLower(r.Header.Get("Accept-Language")), "en") {
		locale = "en"
	}
	http.SetCookie(w, &http.Cookie{Name: "fluxmedia_referral_code", Value: code, Path: "/", MaxAge: 30 * 24 * 60 * 60, HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: strings.HasPrefix(b.config.authURL, "https://")})
	w.Header().Set("Location", "/"+locale+"/sign-up")
	w.WriteHeader(http.StatusSeeOther)
	return nil
}
