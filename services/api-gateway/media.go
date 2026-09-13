package main

// Native media and compatibility endpoints.  The handlers deliberately keep
// the HTTP contract small: PostgreSQL is the source of truth for task state,
// while workers can claim the queued rows independently of this process.

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/draw"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	nativewebp "github.com/HugoSmits86/nativewebp"
	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5"
	xdraw "golang.org/x/image/draw"
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
	mux.HandleFunc("GET /api/image-generation/page-data", b.endpoint(b.handleImageGenerationPageData))
	mux.HandleFunc("GET /api/model-marketplace/public", b.endpoint(b.handlePublicModelMarketplace))
	mux.HandleFunc("GET /api/model-marketplace/runtime-catalog", b.endpoint(b.handleRuntimeModelCatalog))
	mux.HandleFunc("POST /api/videos/generate", b.endpoint(b.handleVideoCreateSession))
	mux.HandleFunc("GET /api/videos/{taskId}", b.endpoint(b.handleVideoStatusSession))
	mux.HandleFunc("GET /api/videos/capabilities", b.endpoint(b.handleVideoCapabilitiesSession))
	mux.HandleFunc("GET /api/site-logo", b.endpoint(b.handleSiteLogo))
	mux.HandleFunc("GET /api/image-backend/groups/options", b.endpoint(b.handleBackendPoolRead))
	mux.HandleFunc("GET /api/admin/image-backend/size-configs", b.endpoint(b.handleBackendPoolRead))
	mux.HandleFunc("POST /api/admin/image-backend/size-configs", b.endpoint(b.handleBackendPoolSizeConfigWrite))
	mux.HandleFunc("DELETE /api/admin/image-backend/size-configs/{id}", b.endpoint(b.handleBackendPoolSizeConfigDelete))
	mux.HandleFunc("GET /api/admin/image-backend/pool", b.endpoint(b.handleBackendPoolAdmin))
	mux.HandleFunc("GET /api/admin/image-backend/groups", b.endpoint(b.handleBackendPoolAdmin))
	mux.HandleFunc("POST /api/admin/image-backend/groups", b.endpoint(b.handleBackendPoolAdmin))
	mux.HandleFunc("DELETE /api/admin/image-backend/groups/{id}", b.endpoint(b.handleBackendPoolAdmin))
	mux.HandleFunc("GET /api/admin/image-backend/members", b.endpoint(b.handleBackendPoolAdmin))
	mux.HandleFunc("POST /api/admin/image-backend/members", b.endpoint(b.handleBackendPoolAdmin))
	mux.HandleFunc("DELETE /api/admin/image-backend/members/{id}", b.endpoint(b.handleBackendPoolAdmin))
	mux.HandleFunc("POST /api/admin/image-backend/members/{id}/enabled", b.endpoint(b.handleBackendPoolAdmin))
	mux.HandleFunc("POST /api/admin/image-backend/members/{id}/reset-status", b.endpoint(b.handleBackendPoolAdmin))
	mux.HandleFunc("POST /api/upload/presigned", b.endpoint(b.handleUploadPresigned))
	mux.HandleFunc("GET /api/storage/{bucket}/{key...}", b.endpoint(b.handleStorageGet))
	mux.HandleFunc("PUT /api/storage/{bucket}/{key...}", b.endpoint(b.handleStoragePut))
	mux.HandleFunc("DELETE /api/storage/{bucket}/{key...}", b.endpoint(b.handleStorageDeletePath))
	mux.HandleFunc("POST /api/storage/delete", b.endpoint(b.handleStorageDelete))
	mux.HandleFunc("GET /api/jobs/credits/expire", b.endpoint(b.handleJobHealth))
	mux.HandleFunc("GET /api/jobs/images/expire-pending", b.endpoint(b.handleJobHealth))
	mux.HandleFunc("POST /api/jobs/credits/expire", b.endpoint(b.handleCreditsExpireJob))
	mux.HandleFunc("POST /api/jobs/images/expire-pending", b.endpoint(b.handleImagesExpireJob))
	mux.HandleFunc("POST /api/jobs/media/recover", b.endpoint(b.handleMediaRecoveryJob))

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
	// Redis is only a wake-up hint; PostgreSQL remains the durable queue and
	// the Go worker's periodic scan recovers lost publications.
	if b.redis != nil {
		_ = b.redis.Publish(r.Context(), "fluxmedia:media:wakeup", id).Err()
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
	body, err := b.decodeImageEditBody(r)
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
func (b *backend) decodeImageEditBody(r *http.Request) (map[string]json.RawMessage, error) {
	if !strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "multipart/form-data") {
		return decodeObject(r)
	}
	if err := r.ParseMultipartForm(64 << 20); err != nil {
		return nil, invalid("Invalid multipart body")
	}
	body := map[string]json.RawMessage{}
	for _, key := range []string{"prompt", "model", "aspect_ratio", "aspectRatio", "resolution", "quality", "background", "moderation", "thinking", "output_format", "outputFormat", "output_compression", "outputCompression", "transparentMatte", "transparent_matte", "hdRepair", "hd_repair", "blockRepair", "block_repair", "repairPrompt", "repair_prompt", "generationId", "generation_id", "backendGroupId", "backend_group_id", "apiPrompt", "promptOptimization"} {
		if value := r.FormValue(key); value != "" {
			encoded, _ := json.Marshal(value)
			body[key] = encoded
		}
	}
	if rawString(body, "prompt") == "" || rawString(body, "model") == "" {
		return nil, invalid("prompt and model are required")
	}
	session, err := b.requireSession(r)
	if err != nil {
		return nil, err
	}
	_, bucket, err := b.storageBuckets(r.Context())
	if err != nil {
		return nil, err
	}
	refs := make([]map[string]any, 0, 4)
	for _, field := range []string{"image", "image[]", "image_1", "image_2", "image_3", "image_4"} {
		for _, fileHeaders := range r.MultipartForm.File[field] {
			ref, putErr := b.stageMultipartImage(r, session.User.ID, bucket, fileHeaders)
			if putErr != nil {
				return nil, putErr
			}
			refs = append(refs, ref)
		}
	}
	if len(refs) == 0 {
		return nil, invalid("At least one source image is required")
	}
	encoded, _ := json.Marshal(refs)
	body["images"] = encoded
	if maskHeaders := r.MultipartForm.File["mask"]; len(maskHeaders) > 0 {
		ref, putErr := b.stageMultipartImage(r, session.User.ID, bucket, maskHeaders[0])
		if putErr != nil {
			return nil, putErr
		}
		encoded, _ = json.Marshal(ref)
		body["mask"] = encoded
	}
	return body, nil
}

func (b *backend) stageMultipartImage(r *http.Request, userID, bucket string, header *multipart.FileHeader) (map[string]any, error) {
	if header == nil || header.Size <= 0 || header.Size > b.config.maxBodyBytes {
		return nil, invalid("image file is empty or too large")
	}
	file, err := header.Open()
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, b.config.maxBodyBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > b.config.maxBodyBytes {
		return nil, &apiError{413, "REQUEST_BODY_TOO_LARGE", "请求体过大"}
	}
	contentType := header.Header.Get("Content-Type")
	if contentType == "" || !strings.HasPrefix(strings.ToLower(contentType), "image/") {
		return nil, invalid("source files must be images")
	}
	ext := ".png"
	if strings.Contains(contentType, "jpeg") || strings.Contains(contentType, "jpg") {
		ext = ".jpg"
	} else if strings.Contains(contentType, "webp") {
		ext = ".webp"
	}
	key := fmt.Sprintf("%s/image-inputs/%s/%s%s", userID, newRequestID(), newRequestID(), ext)
	if err := b.putStorageObject(r.Context(), bucket, key, data, contentType); err != nil {
		return nil, err
	}
	return map[string]any{"source": "storage", "mimeType": contentType, "storageKey": key, "storageBucket": bucket, "byteLength": len(data)}, nil
}

func (b *backend) putStorageObject(ctx context.Context, bucket, key string, data []byte, contentType string) error {
	endpoint, err := b.settingString(ctx, "STORAGE_ENDPOINT", "")
	if err != nil {
		return err
	}
	if strings.TrimSpace(endpoint) == "" {
		file := filepath.Join(b.config.storagePath, bucket, filepath.FromSlash(key))
		if err := os.MkdirAll(filepath.Dir(file), 0o750); err != nil {
			return err
		}
		return os.WriteFile(file, data, 0o640)
	}
	access, err := b.settingString(ctx, "STORAGE_ACCESS_KEY_ID", "")
	if err != nil {
		return err
	}
	secret, err := b.settingString(ctx, "STORAGE_SECRET_ACCESS_KEY", "")
	if err != nil {
		return err
	}
	region, err := b.settingString(ctx, "STORAGE_REGION", "auto")
	if err != nil {
		return err
	}
	if access == "" || secret == "" {
		return &apiError{503, "STORAGE_CONFIG_INVALID", "Storage credentials are not configured"}
	}
	cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(region), awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(access, secret, "")))
	if err != nil {
		return err
	}
	client := s3.NewFromConfig(cfg, func(o *s3.Options) { o.UsePathStyle = true; o.BaseEndpoint = aws.String(endpoint) })
	_, err = client.PutObject(ctx, &s3.PutObjectInput{Bucket: aws.String(bucket), Key: aws.String(key), Body: bytes.NewReader(data), ContentType: aws.String(contentType)})
	return err
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
	body, err := b.decodeImageEditBody(r)
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
	if b.redis != nil {
		_ = b.redis.Publish(r.Context(), "fluxmedia:media:wakeup", id).Err()
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
	expired, err := b.expireStaleImages(r.Context())
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"success": true, "expired": expired})
	return nil
}

// handleMediaRecoveryJob exposes the same bounded recovery pass used by the
// native scheduler for rollout environments where an external cron still
// drives maintenance. It is CRON_SECRET protected and idempotent.
func (b *backend) handleMediaRecoveryJob(w http.ResponseWriter, r *http.Request) error {
	if !b.cronAuthorized(r) {
		return &apiError{http.StatusUnauthorized, "UNAUTHORIZED", "Unauthorized"}
	}
	queue, err := b.recoverMediaQueue(r.Context())
	if err != nil {
		return err
	}
	delivered, callbackErr := b.deliverVideoCallbacks(r.Context())
	if callbackErr != nil {
		return callbackErr
	}
	deleted, cleanupErr := b.cleanupVideoInputs(r.Context())
	if cleanupErr != nil {
		return cleanupErr
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "queueRecovered": queue, "callbacksDelivered": delivered, "inputsDeleted": deleted})
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
	_, generationsBucket, bucketErr := b.storageBuckets(r.Context())
	if bucketErr != nil {
		return bucketErr
	}
	fileKey := requestedKey
	if fileKey != "" {
		if filepath.IsAbs(fileKey) || filepath.Clean(fileKey) != fileKey || strings.Contains(fileKey, "..") || !strings.HasPrefix(fileKey, "uploads/"+session.User.ID+"/") {
			return forbidden()
		}
	} else {
		fileKey = fmt.Sprintf("uploads/%s/%s-%s", session.User.ID, newRequestID(), filename)
	}
	fileURL := "/api/storage/" + urlPathEscape(generationsBucket) + "/" + urlPathEscape(fileKey)
	writeJSON(w, 200, map[string]any{"presignedUrl": fileURL, "uploadUrl": fileURL, "fileKey": fileKey, "fileUrl": fileURL, "key": fileKey, "bucket": generationsBucket, "contentType": contentType, "expiresIn": 3600})
	return nil
}

func (b *backend) handleStorageGet(w http.ResponseWriter, r *http.Request) error {
	bucket := r.PathValue("bucket")
	key := r.PathValue("key")
	// The public avatar alias is a logical name, never a physical bucket.
	systemBucket, generationsBucket, err := b.storageBuckets(r.Context())
	if err != nil {
		return err
	}
	if bucket == "_avatars" {
		bucket = systemBucket
	}
	// A path width is accepted for parity with the Next route. Go currently
	// serves the original object when image processing is unavailable; keeping
	// the segment out of the object key is still essential for signed URLs.
	thumbWidth := 0
	if parts := strings.Split(key, "/"); len(parts) > 1 && strings.HasPrefix(parts[0], "w") {
		if _, parseErr := strconv.Atoi(strings.TrimPrefix(parts[0], "w")); parseErr == nil {
			thumbWidth, _ = strconv.Atoi(strings.TrimPrefix(parts[0], "w"))
			key = strings.Join(parts[1:], "/")
		}
	}
	if thumbWidth != 0 && (thumbWidth < 16 || thumbWidth > 1280) {
		return &apiError{400, "INVALID_THUMBNAIL_WIDTH", "Invalid thumbnail width"}
	}
	if bucket == "" || key == "" || filepath.IsAbs(key) || filepath.Clean(key) != key || strings.Contains(key, "..") || strings.Contains(key, "\\") {
		return &apiError{400, "INVALID_PATH", "Invalid storage path"}
	}
	if bucket != systemBucket && bucket != generationsBucket {
		return forbidden()
	}
	domain := storageObjectDomain(bucket, key, systemBucket, generationsBucket)
	if domain == "" {
		return &apiError{400, "INVALID_PATH", "Invalid public asset key"}
	}
	if thumbWidth != 0 && domain != "generations" && domain != "avatars" {
		return &apiError{400, "INVALID_THUMBNAIL", "Public asset thumbnails are not allowed"}
	}
	if domain == "generations" {
		if err := b.verifyStorageSignature(r, bucket, key); err != nil {
			// First-party requests may use a valid session for objects they own,
			// matching the Next route's signature fallback.
			if !b.storageObjectOwned(r, key) {
				return err
			}
		}
	}
	data, err := b.readStorageObject(r.Context(), bucket, key)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) || strings.Contains(strings.ToLower(err.Error()), "status code: 404") || strings.Contains(strings.ToLower(err.Error()), "nosuchkey") {
			return &apiError{404, "NOT_FOUND", "File not found"}
		}
		return err
	}
	if thumbWidth > 0 {
		if thumb, thumbErr := storageThumbnail(data, thumbWidth); thumbErr == nil {
			data = thumb
		}
	}
	contentType := "application/octet-stream"
	if thumbWidth > 0 {
		contentType = "image/webp"
	}
	switch strings.ToLower(filepath.Ext(key)) {
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
	if domain == "generations" {
		w.Header().Set("Cache-Control", "public, max-age=86400, s-maxage=2592000, immutable")
	} else {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}
	if contentType == "application/octet-stream" && domain != "logo" && domain != "model" {
		w.Header().Set("Content-Disposition", "attachment")
	}
	if domain == "logo" && contentType == "image/svg+xml" {
		w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	}
	w.WriteHeader(200)
	_, err = w.Write(data)
	return err
}

// storageThumbnail decodes a source image, scales it down while preserving
// aspect ratio, and encodes a lossless WebP thumbnail. Unsupported media is
// returned to the caller as an error so the storage endpoint can safely fall
// back to the original bytes, matching the historical Next route behavior.
func storageThumbnail(data []byte, width int) ([]byte, error) {
	src, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	bounds := src.Bounds()
	if bounds.Dx() <= 0 || bounds.Dy() <= 0 || bounds.Dx() <= width {
		return data, nil
	}
	height := bounds.Dy() * width / bounds.Dx()
	if height < 1 {
		height = 1
	}
	dst := image.NewNRGBA(image.Rect(0, 0, width, height))
	xdraw.CatmullRom.Scale(dst, dst.Bounds(), src, bounds, draw.Over, nil)
	var out bytes.Buffer
	if err := nativewebp.Encode(&out, dst, nil); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// readStorageObject reads from the configured S3-compatible provider when an
// endpoint is configured, otherwise from the local storage root. Credentials
// are loaded at request time so admin key rotation takes effect immediately.
func (b *backend) readStorageObject(ctx context.Context, bucket, key string) ([]byte, error) {
	endpoint, err := b.settingString(ctx, "STORAGE_ENDPOINT", "")
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(endpoint) == "" {
		return os.ReadFile(filepath.Join(b.config.storagePath, bucket, filepath.FromSlash(key)))
	}
	access, err := b.settingString(ctx, "STORAGE_ACCESS_KEY_ID", "")
	if err != nil {
		return nil, err
	}
	secret, err := b.settingString(ctx, "STORAGE_SECRET_ACCESS_KEY", "")
	if err != nil {
		return nil, err
	}
	if access == "" || secret == "" {
		return nil, &apiError{503, "STORAGE_CONFIG_INVALID", "Storage credentials are not configured"}
	}
	region, err := b.settingString(ctx, "STORAGE_REGION", "auto")
	if err != nil {
		return nil, err
	}
	cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(region), awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(access, secret, "")))
	if err != nil {
		return nil, err
	}
	client := s3.NewFromConfig(cfg, func(o *s3.Options) { o.UsePathStyle = true; o.BaseEndpoint = aws.String(endpoint) })
	resp, err := client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(bucket), Key: aws.String(key)})
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return io.ReadAll(resp.Body)
}

// storageBuckets resolves the runtime bucket settings used by the Next route.
// Keeping this in Go prevents a deploy-time environment value from silently
// diverging from the system settings selected by administrators.
func (b *backend) storageBuckets(ctx context.Context) (string, string, error) {
	system, err := b.settingString(ctx, "SYSTEM_ASSETS_BUCKET_NAME", "system")
	if err != nil {
		return "", "", err
	}
	generations, err := b.settingString(ctx, "GENERATIONS_BUCKET_NAME", "generations")
	if err != nil {
		return "", "", err
	}
	valid := func(value string) bool {
		if value == "" || value == "." || value == ".." || value == "_avatars" || len(value) > 255 {
			return false
		}
		for _, c := range value {
			if !(c == '-' || c == '_' || c == '.' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9') {
				return false
			}
		}
		return true
	}
	if !valid(system) || !valid(generations) || system == generations {
		return "", "", &apiError{503, "STORAGE_CONFIG_INVALID", "Storage bucket configuration invalid"}
	}
	return system, generations, nil
}

func storageObjectDomain(bucket, key, system, generations string) string {
	parts := strings.Split(key, "/")
	namespace := parts[0]
	if bucket == generations {
		return "generations"
	}
	if bucket != system {
		return ""
	}
	if namespace == "image" || namespace == "video" {
		if len(parts) == 3 && regexp.MustCompile(`^(image|video)/[a-f0-9]{64}/[a-f0-9]{64}\.webp$`).MatchString(key) && strings.HasPrefix(key, namespace+"/") {
			return "model"
		}
		return ""
	}
	if namespace == "logo" {
		if regexp.MustCompile(`^logo/[a-f0-9]{64}\.(png|svg|ico)$`).MatchString(key) {
			return "logo"
		}
		return ""
	}
	if namespace == "avatars" || (len(parts) == 1 && regexp.MustCompile(`^[A-Za-z0-9_-]+-[0-9]+\.(jpe?g|png|gif|webp)$`).MatchString(parts[0])) {
		return "avatars"
	}
	return ""
}

func (b *backend) verifyStorageSignature(r *http.Request, bucket, key string) error {
	sig := strings.TrimSpace(r.URL.Query().Get("sig"))
	expRaw := strings.TrimSpace(r.URL.Query().Get("exp"))
	exp, err := strconv.ParseInt(expRaw, 10, 64)
	if sig == "" || err != nil || exp <= 0 {
		return &apiError{403, "MISSING_SIGNATURE", "Missing signature"}
	}
	if time.Now().Unix() > exp {
		return &apiError{403, "SIGNATURE_EXPIRED", "Signature expired"}
	}
	mac := hmac.New(sha256.New, []byte(b.config.authSecret))
	_, _ = mac.Write([]byte(bucket + "/" + key + ":" + strconv.FormatInt(exp, 10)))
	expected := mac.Sum(nil)
	provided, decodeErr := hex.DecodeString(sig)
	if decodeErr != nil || len(provided) != len(expected) || !hmac.Equal(provided, expected) {
		return &apiError{403, "INVALID_SIGNATURE", "Invalid signature"}
	}
	return nil
}

func (b *backend) storageObjectOwned(r *http.Request, key string) bool {
	session, err := b.requireSession(r)
	if err != nil || session == nil {
		return false
	}
	var owner string
	if err := b.db.QueryRow(r.Context(), `SELECT user_id FROM generation WHERE storage_key=$1 LIMIT 1`, key).Scan(&owner); err == nil && owner == session.User.ID {
		return true
	}
	if err := b.db.QueryRow(r.Context(), `SELECT user_id FROM video_generation WHERE storage_key=$1 LIMIT 1`, key).Scan(&owner); err == nil && owner == session.User.ID {
		return true
	}
	return false
}

func (b *backend) handleStoragePut(w http.ResponseWriter, r *http.Request) error {
	session, err := b.requireSession(r)
	if err != nil {
		return err
	}
	bucket, key := r.PathValue("bucket"), r.PathValue("key")
	_, generationsBucket, bucketErr := b.storageBuckets(r.Context())
	if bucketErr != nil {
		return bucketErr
	}
	if bucket != generationsBucket || key == "" || filepath.IsAbs(key) || filepath.Clean(key) != key || strings.Contains(key, "..") || strings.Contains(key, "\\") || !strings.HasPrefix(key, "uploads/"+session.User.ID+"/") {
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
	_, generationsBucket, bucketErr := b.storageBuckets(r.Context())
	if bucketErr != nil {
		return bucketErr
	}
	if in.Bucket == "" {
		in.Bucket = generationsBucket
	}
	if in.Bucket != generationsBucket || in.Key == "" || filepath.IsAbs(in.Key) || filepath.Clean(in.Key) != in.Key || strings.Contains(in.Key, "..") || strings.Contains(in.Key, "\\") || !strings.HasPrefix(in.Key, "uploads/"+s.User.ID+"/") {
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

// DELETE /api/storage/{bucket}/{key...} is the path-oriented counterpart of
// the historical JSON delete action. It is used by migrated clients while the
// action endpoint remains available for compatibility.
func (b *backend) handleStorageDeletePath(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireSession(r)
	if err != nil {
		return err
	}
	_, generationsBucket, bucketErr := b.storageBuckets(r.Context())
	if bucketErr != nil {
		return bucketErr
	}
	bucket, key := r.PathValue("bucket"), r.PathValue("key")
	if bucket != generationsBucket || key == "" || filepath.IsAbs(key) || filepath.Clean(key) != key || strings.Contains(key, "..") || strings.Contains(key, "\\") || !strings.HasPrefix(key, "uploads/"+s.User.ID+"/") {
		return forbidden()
	}
	err = os.Remove(filepath.Join(b.config.storagePath, bucket, filepath.FromSlash(key)))
	if os.IsNotExist(err) {
		err = nil
	}
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "key": key})
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
