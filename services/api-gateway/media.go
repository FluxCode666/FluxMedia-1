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
	"encoding/base64"
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
	"net/url"
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
		for _, path := range []string{"/chat/completions", "/responses", "/agents/images"} {
			mux.HandleFunc("POST "+prefix+path, b.externalEndpoint(b.handleRetiredConversation))
			mux.HandleFunc("OPTIONS "+prefix+path, b.externalEndpoint(b.handleRetiredConversation))
		}
		mux.HandleFunc("POST "+prefix+"/ppts", b.externalEndpoint(b.handleRetiredEditableFile))
		mux.HandleFunc("OPTIONS "+prefix+"/ppts", b.externalEndpoint(b.handleRetiredEditableFile))
		mux.HandleFunc("POST "+prefix+"/psds", b.externalEndpoint(b.handleRetiredEditableFile))
		mux.HandleFunc("OPTIONS "+prefix+"/psds", b.externalEndpoint(b.handleRetiredEditableFile))
		mux.HandleFunc("GET "+prefix+"/editable-file-tasks/{taskId}", b.externalEndpoint(b.handleRetiredEditableFile))
		mux.HandleFunc("OPTIONS "+prefix+"/editable-file-tasks/{taskId}", b.externalEndpoint(b.handleRetiredEditableFile))
	}
	for _, prefix := range []string{"/api/v1beta", "/v1beta"} {
		mux.HandleFunc("POST "+prefix+"/models/{model}/predictLongRunning", b.geminiEndpoint(b.handleGeminiCreate))
		mux.HandleFunc("OPTIONS "+prefix+"/models/{model}/predictLongRunning", b.geminiEndpoint(b.handleGeminiCreate))
		// ServeMux treats a colon as part of a wildcard segment, so the
		// compact Gemini spelling is registered as the model segment and
		// validated by the handler.
		mux.HandleFunc("POST "+prefix+"/models/{model}", b.geminiEndpoint(b.handleGeminiCreate))
		mux.HandleFunc("OPTIONS "+prefix+"/models/{model}", b.geminiEndpoint(b.handleGeminiCreate))
		mux.HandleFunc("GET "+prefix+"/models/{model}/operations/{operationId}", b.geminiEndpoint(b.handleGeminiStatus))
		mux.HandleFunc("OPTIONS "+prefix+"/models/{model}/operations/{operationId}", b.geminiEndpoint(b.handleGeminiStatus))
	}
	// First-party routes use the Better Auth cookie. They share the same task
	// persistence, so browser and API clients observe one state machine.
	mux.HandleFunc("POST /api/images/generate", b.endpoint(b.handleImageCreateSession))
	mux.HandleFunc("POST /api/images/edit", b.endpoint(b.handleImageEditSession))
	mux.HandleFunc("POST /api/images/chat", b.endpoint(b.handleRetiredConversation))
	mux.HandleFunc("POST /api/images/chat/web-select", b.endpoint(b.handleRetiredConversation))
	mux.HandleFunc("POST /api/editable-file/generate", b.endpoint(b.handleRetiredEditableFile))
	mux.HandleFunc("GET /api/images/status/{id}", b.endpoint(b.handleImageStatusSession))
	mux.HandleFunc("POST /api/image-generation/async", b.endpoint(b.handleImageAsyncCreate))
	mux.HandleFunc("POST /api/image-generation/async/{taskId}/process", b.endpoint(b.handleImageAsyncProcess))
	mux.HandleFunc("POST /api/image-generation/inputs/stage", b.endpoint(b.handleImageInputsStage))
	mux.HandleFunc("POST /api/image-generation/inputs/cleanup", b.endpoint(b.handleImageInputsCleanup))
	mux.HandleFunc("GET /api/image-generation/async/{taskId}", b.endpoint(b.handleImageAsyncStatus))
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
	mux.HandleFunc("POST /api/storage/object", b.endpoint(b.handleStorageObjectRead))
	mux.HandleFunc("PUT /api/storage/object", b.endpoint(b.handleStorageObjectPut))
	mux.HandleFunc("DELETE /api/storage/object", b.endpoint(b.handleStorageObjectDelete))
	mux.HandleFunc("POST /api/storage/signed-read-url", b.endpoint(b.handleStorageSignedReadURL))
	mux.HandleFunc("GET /api/jobs/credits/expire", b.endpoint(b.handleJobHealth))
	mux.HandleFunc("GET /api/jobs/images/expire-pending", b.endpoint(b.handleJobHealth))
	mux.HandleFunc("POST /api/jobs/credits/expire", b.endpoint(b.handleCreditsExpireJob))
	mux.HandleFunc("POST /api/jobs/images/expire-pending", b.endpoint(b.handleImagesExpireJob))
	mux.HandleFunc("POST /api/jobs/images/retention", b.endpoint(b.handleImageRetention))
	mux.HandleFunc("POST /api/jobs/media/recover", b.endpoint(b.handleMediaRecoveryJob))

	// Remaining application endpoints now terminate in Go.  They return a
	// stable JSON envelope and enforce the same session boundary, allowing the
	// frontend to migrate incrementally without an implicit Next.js fallback.
	for _, spec := range []struct{ method, path string }{
		{"GET", "/r/{code}"},
	} {
		mux.HandleFunc(spec.method+" "+spec.path, b.endpoint(b.handleReferral))
	}
	mux.HandleFunc("POST /api/credits/purchase-checkout", b.endpoint(b.handleCreditPackageCheckout))
	mux.HandleFunc("GET /api/credits/purchase-checkout", b.endpoint(b.handleCreditPackageCheckoutMethod))
	mux.HandleFunc("GET /api/credits/packages", b.endpoint(b.handleCreditPackages))
	// Referral links are read-only. Make unsupported methods explicit so they
	// never produce the generic route_not_migrated envelope.
	mux.HandleFunc("POST /r/{code}", b.endpoint(b.handleUnsupportedReferralMethod))
	mux.HandleFunc("GET /api/payments/epay/return", b.endpoint(b.handleEpayReturn))
	mux.HandleFunc("POST /api/payments/epay/return", b.endpoint(b.handleEpayReturn))
	mux.HandleFunc("POST /api/webhooks/alipay", b.endpoint(b.handleAlipayWebhook))
	mux.HandleFunc("POST /api/webhooks/creem", b.endpoint(b.handleCreemWebhook))
	mux.HandleFunc("GET /api/webhooks/epay", b.endpoint(b.handleEpayWebhook))
	mux.HandleFunc("POST /api/webhooks/epay", b.endpoint(b.handleEpayWebhook))
	mux.HandleFunc("POST /api/mcp/user", b.endpoint(b.handleRetiredMCP))
	mux.HandleFunc("POST /api/mcp/admin", b.endpoint(b.handleRetiredMCP))
	mux.HandleFunc("POST /moderate", b.endpoint(b.handleModerate))
	mux.HandleFunc("GET /api/search", b.endpoint(b.handleAdminSearch))
	mux.HandleFunc("POST /api/admin/site-branding/logo", b.endpoint(b.handleAdminLogoUpload))
	mux.HandleFunc("GET /api/admin/videos/reconciliation", b.endpoint(b.handleVideoReconciliation))
	mux.HandleFunc("POST /api/admin/videos/reconciliation", b.endpoint(b.handleVideoReconciliation))
	mux.HandleFunc("GET /api/admin/model-configuration", b.endpoint(b.handleModelConfiguration))
	mux.HandleFunc("POST /api/admin/model-configuration", b.endpoint(b.handleModelConfiguration))
	mux.HandleFunc("DELETE /api/admin/model-configuration", b.endpoint(b.handleModelConfiguration))
	// Older dashboard bundles used the plural resource spelling. Keep it on
	// the same Go handler so stale clients never fall through to the 501 guard.
	mux.HandleFunc("GET /api/admin/model-configurations", b.endpoint(b.handleModelConfiguration))
	mux.HandleFunc("POST /api/admin/model-configurations", b.endpoint(b.handleModelConfiguration))
	mux.HandleFunc("DELETE /api/admin/model-configurations", b.endpoint(b.handleModelConfiguration))
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

func (b *backend) createImageTask(r *http.Request, p *apiPrincipal, rawBody map[string]json.RawMessage, operation string) (map[string]any, error) {
	body, requestDigest, err := normalizeImageTaskInput(rawBody, operation)
	if err != nil {
		return nil, err
	}
	prompt, model := rawString(body, "prompt"), rawString(body, "model")
	if prompt == "" || model == "" {
		return nil, invalid("prompt and model are required")
	}
	if len([]rune(prompt)) > 32000 {
		return nil, invalid("prompt is too long")
	}
	generationID, id := rawString(body, "generationId"), rawString(body, "taskId")
	if existing, err := existingImageTask(r.Context(), b.db, p, body, requestDigest); err != nil || existing != nil {
		return existing, err
	}
	quote, err := b.resolveImageBillingQuote(r.Context(), p, model, rawString(body, "resolution"), operation, body)
	if err != nil {
		return nil, err
	}
	staged, err := b.stageImageRequest(r, p, body, operation)
	if err != nil {
		return nil, err
	}
	adopted := false
	defer func() {
		if !adopted {
			for _, object := range staged.Objects {
				_ = b.deleteStorageObject(r.Context(), object.Bucket, object.Key)
			}
		}
	}()
	persistedInput, err := persistedImageTaskInput(body, operation)
	if err != nil {
		return nil, err
	}
	inputs, err := json.Marshal(persistedInput)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(inputs)
	inputDigest := "sha256:" + hex.EncodeToString(digest[:])
	tx, err := b.db.Begin(r.Context())
	if err != nil {
		return nil, err
	}
	defer rollback(tx)
	// Both natural keys are serialized. The second lookup sees a concurrent
	// winner and compares the full original input before any wallet mutation.
	for _, key := range []string{"image-generation:" + generationID, "image-task:" + id} {
		if _, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, key); err != nil {
			return nil, err
		}
	}
	if existing, err := existingImageTask(r.Context(), tx, p, body, requestDigest); err != nil || existing != nil {
		return existing, err
	}
	var generationExists bool
	if err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM generation WHERE id=$1)`, generationID).Scan(&generationExists); err != nil {
		return nil, err
	}
	if generationExists {
		return nil, imageTaskConflict()
	}
	userConcurrency, err := b.admitImageTask(r.Context(), tx, p.UserID)
	if err != nil {
		return nil, err
	}
	metadataDoc := map[string]any{"input": json.RawMessage(inputs), "requestDigest": requestDigest, "billingSnapshot": quote.Snapshot}
	if len(staged.References) > 0 {
		metadataDoc["inputImages"] = map[string]any{"images": staged.References}
	}
	if p.KeyID != "" {
		metadataDoc["externalApiKeyId"] = p.KeyID
	}
	if _, err = tx.Exec(r.Context(), `INSERT INTO generation(id,user_id,prompt,model,status,metadata,usage_log_visible,credits_consumed) VALUES($1,$2,$3,$4,'pending',$5,$6,$7)`, generationID, p.UserID, prompt, model, mustJSON(metadataDoc), p.KeyID != "", quote.Amount); err != nil {
		return nil, err
	}
	if err = b.chargeImageGenerationTx(r.Context(), tx, p.UserID, generationID, p.KeyID, quote, map[string]any{"operation": operation}); err != nil {
		return nil, err
	}
	var created time.Time
	if err = tx.QueryRow(r.Context(), `INSERT INTO image_async_task(id,user_id,api_key_id,plan,operation,generation_inputs,generation_ids,generation_input,input_digest,generation_id,response_format,callback_url,status,effective_user_concurrency,group_id_snapshot,group_priority_snapshot) VALUES($1,$2,$3,'default',$4,$5,$6,$7,$8,$9,$10,NULLIF($11,''),'queued',$12,$13,$14) RETURNING created_at`, id, p.UserID, imageTaskKeyID(p), operation, mustJSON([]any{json.RawMessage(inputs)}), mustJSON([]string{generationID}), inputs, inputDigest, generationID, rawString(body, "responseFormat"), rawString(body, "callbackUrl"), userConcurrency, quote.Snapshot["group"].(imageGroupSnapshot).ID, quote.Snapshot["group"].(imageGroupSnapshot).Priority).Scan(&created); err != nil {
		return nil, err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return nil, err
	}
	adopted = true
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
	return b.servePublicImage(w, r, p, body, "generate")
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
	return b.servePublicImage(w, r, p, body, "edit")
}
func (b *backend) decodeImageEditBody(r *http.Request) (map[string]json.RawMessage, error) {
	if !strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "multipart/form-data") {
		return decodeObject(r)
	}
	if err := r.ParseMultipartForm(64 << 20); err != nil {
		return nil, invalid("Invalid multipart body")
	}
	defer r.MultipartForm.RemoveAll()
	body := map[string]json.RawMessage{}
	for _, key := range []string{"prompt", "model", "aspect_ratio", "aspectRatio", "resolution", "quality", "background", "moderation", "thinking", "output_format", "outputFormat", "output_compression", "outputCompression", "transparentMatte", "transparent_matte", "hdRepair", "hd_repair", "blockRepair", "block_repair", "repairPrompt", "repair_prompt", "generationId", "generation_id", "backendGroupId", "backend_group_id", "apiPrompt", "promptOptimization", "prompt_optimization", "stream", "async", "responseFormat", "response_format", "callbackUrl", "callback_url"} {
		if value := r.FormValue(key); value != "" {
			encoded, _ := json.Marshal(value)
			body[key] = encoded
		}
	}
	if rawString(body, "prompt") == "" || rawString(body, "model") == "" {
		return nil, invalid("prompt and model are required")
	}
	refs := make([]map[string]any, 0, 4)
	for _, field := range []string{"image", "image[]", "image_1", "image_2", "image_3", "image_4"} {
		for _, fileHeaders := range r.MultipartForm.File[field] {
			ref, putErr := b.multipartImageReference(r, fileHeaders)
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
		ref, putErr := b.multipartImageReference(r, maskHeaders[0])
		if putErr != nil {
			return nil, putErr
		}
		encoded, _ = json.Marshal(ref)
		body["mask"] = encoded
	}
	return body, nil
}

func (b *backend) multipartImageReference(r *http.Request, header *multipart.FileHeader) (map[string]any, error) {
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
	contentType := http.DetectContentType(data)
	if contentType != "image/png" && contentType != "image/jpeg" && contentType != "image/webp" {
		return nil, invalid("source files must be PNG, JPEG, or WebP images")
	}
	// Staging is part of task creation after authentication/quote validation.
	// Parsing a multipart body must not leave orphaned storage objects.
	return map[string]any{"source": "data", "mimeType": contentType, "base64": base64.StdEncoding.EncodeToString(data), "byteLength": len(data)}, nil
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
	var creditsConsumed float64
	if err := b.db.QueryRow(r.Context(), `SELECT prompt,COALESCE(size,''),COALESCE(revised_prompt,''),COALESCE(storage_key,''),COALESCE(storage_bucket,'generations'),metadata,created_at,completed_at,error,credits_consumed FROM generation WHERE id=$1 AND user_id=$2`, generationID, userID).Scan(&promptValue, &sizeValue, &revisedPrompt, &storageKey, &storageBucket, &metadataRaw, &generationCreated, &generationCompleted, &generationError, &creditsConsumed); err == nil {
		extra["creditsConsumed"] = creditsConsumed
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
	if err := b.assertImageStatusScope(r, p, r.PathValue("taskId")); err != nil {
		return err
	}
	response, err := b.publicImageTask(r.Context(), p, r.PathValue("taskId"))
	if err != nil {
		return err
	}
	writeJSON(w, 200, response)
	return nil
}
func (b *backend) handleImageCreateSession(w http.ResponseWriter, r *http.Request) error {
	p, err := b.imageUOLPrincipal(r)
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
	writeJSON(w, 202, response)
	return nil
}
func (b *backend) handleImageEditSession(w http.ResponseWriter, r *http.Request) error {
	p, err := b.imageUOLPrincipal(r)
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
	writeJSON(w, 202, response)
	return nil
}
func (b *backend) handleImageStatusSession(w http.ResponseWriter, r *http.Request) error {
	p, err := b.imageUOLPrincipal(r)
	if err != nil {
		return err
	}
	if err := b.assertImageStatusScope(r, p, r.PathValue("id")); err != nil {
		return err
	}
	response, err := b.imageStatus(r, r.PathValue("id"), p.UserID)
	if err != nil {
		return err
	}
	writeJSON(w, 200, response)
	return nil
}

func (b *backend) createVideoTask(r *http.Request, p *apiPrincipal, body map[string]json.RawMessage) (map[string]any, error) {
	key, scope := p.KeyID, "external:"+p.UserID+":"+p.KeyID
	if key == "" || key == "session" {
		key = ""
		scope = "user:" + p.UserID
	}
	return b.createNativeVideoTask(r, p.UserID, key, scope, body)
}
func externalVideoTask(task map[string]any) map[string]any {
	result := map[string]any{}
	for key, value := range task {
		result[key] = value
	}
	result["object"] = "video.task"
	result["id"] = task["taskId"]
	result["task_id"] = task["taskId"]
	result["generation_id"] = task["taskId"]
	result["duration_seconds"] = task["duration"]
	result["aspect_ratio"] = task["aspectRatio"]
	result["generate_audio"] = task["generateAudio"]
	if message, ok := task["error"].(string); ok {
		result["error"] = map[string]any{"message": message}
	}
	return result
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
	if rawString(body, "geminiModel", "gemini_model", "geminiOperationId", "gemini_operation_id") != "" {
		return invalid("Gemini identity fields are not accepted by this endpoint")
	}
	task, err := b.createVideoTask(r, p, body)
	if err != nil {
		return err
	}
	noStore(w)
	writeJSON(w, 202, externalVideoTask(task))
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
	task, err := b.createNativeVideoTask(r, s.User.ID, "", "user:"+s.User.ID, body)
	if err != nil {
		return err
	}
	noStore(w)
	writeJSON(w, 202, videoGenerateResult(task))
	return nil
}
func (b *backend) videoStatus(r *http.Request, id, userID string) (map[string]any, error) {
	return b.readNativeVideoStatus(r, id, userID, "", "user:"+userID)
}
func (b *backend) handleVideoStatus(w http.ResponseWriter, r *http.Request) error {
	p, err := b.authenticateAPI(r)
	if err != nil {
		return err
	}
	task, err := b.readNativeVideoStatus(r, r.PathValue("taskId"), p.UserID, p.KeyID, "external:"+p.UserID+":"+p.KeyID)
	if err != nil {
		return err
	}
	noStore(w)
	writeJSON(w, 200, externalVideoTask(task))
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
	p, err := b.authenticateAPI(r)
	if err != nil {
		return err
	}
	return b.writeGoVideoCapabilities(w, r, p.UserID, p.KeyID, "external:"+p.UserID+":"+p.KeyID)
}
func (b *backend) handleVideoCapabilitiesSession(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireSession(r)
	if err != nil {
		return err
	}
	return b.writeGoVideoCapabilities(w, r, s.User.ID, "", "user:"+s.User.ID)
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
	body, err = parseGeminiNativeVideoRequest(r, "external:"+p.UserID+":"+p.KeyID, body)
	if err != nil {
		return err
	}
	task, err := b.createVideoTask(r, p, body)
	if err != nil {
		return err
	}
	noStore(w)
	writeJSON(w, 200, geminiNativeOperation(rawString(body, "geminiModel"), rawString(body, "geminiOperationId"), task))
	return nil
}
func (b *backend) handleGeminiStatus(w http.ResponseWriter, r *http.Request) error {
	p, err := b.authenticateAPI(r)
	if err != nil {
		return err
	}
	response, err := b.readNativeGeminiOperation(r, p.UserID, p.KeyID, "external:"+p.UserID+":"+p.KeyID, r.PathValue("model"), r.PathValue("operationId"))
	if err != nil {
		return err
	}
	noStore(w)
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
	usersProcessed, batchesExpired, err := b.processExpiredCredits(r.Context())
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"success": true, "usersProcessed": usersProcessed, "batchesExpired": batchesExpired})
	return nil
}

func (b *backend) handleImagesExpireJob(w http.ResponseWriter, r *http.Request) error {
	return b.handleImagePendingExpiry(w, r)
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
		b.logger.ErrorContext(r.Context(), "media recovery queue failed", "error", err)
		return err
	}
	delivered, callbackErr := b.deliverVideoCallbacks(r.Context())
	if callbackErr != nil {
		b.logger.ErrorContext(r.Context(), "media recovery callback delivery failed", "error", callbackErr)
		return callbackErr
	}
	deleted, cleanupErr := b.cleanupVideoInputs(r.Context())
	if cleanupErr != nil {
		b.logger.ErrorContext(r.Context(), "media recovery input cleanup failed", "error", cleanupErr)
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
	if filename == "" && requestedKey == "" {
		return invalid("filename or key is required")
	}
	if len(filename) > 255 || strings.ContainsAny(filename, "/\\\x00") {
		return invalid("invalid filename")
	}
	systemBucket, generationsBucket, bucketErr := b.storageBuckets(r.Context())
	if bucketErr != nil {
		return bucketErr
	}
	uploadBucket, err := b.settingString(r.Context(), "STORAGE_BUCKET_NAME", "gpt2image-uploads")
	if err != nil {
		return err
	}
	bucket := strings.TrimSpace(rawString(body, "bucket"))
	avatar := isOwnAvatarKey(session.User.ID, requestedKey)
	maxBytes := int64(10 * 1024 * 1024)
	documentType := documentContentType(filename)
	var contentLength int64
	if documentType != "" || bucket == "documents" {
		if documentType == "" {
			return invalid("Unsupported document type")
		}
		var size float64
		raw := body["fileSize"]
		if raw == nil {
			raw = body["contentLength"]
		}
		if json.Unmarshal(raw, &size) != nil || size <= 0 || size > float64(maxBytes) || size != float64(int64(size)) {
			return invalid("Invalid file size. Maximum size: 10MB")
		}
		contentLength = int64(size)
		contentType = documentType
		if bucket == "" {
			bucket = uploadBucket
		}
	} else {
		if contentType != "image/jpeg" && contentType != "image/png" && contentType != "image/gif" && contentType != "image/webp" && contentType != "video/mp4" && contentType != "video/webm" {
			return invalid("unsupported content type")
		}
		fileMB, err := b.settingInt(r, "MEDIA_MAX_FILE_SIZE_MB", 5, 1, 200)
		if err != nil {
			return err
		}
		maxBytes = int64(fileMB) * 1024 * 1024
		if bucket == "" {
			if avatar {
				bucket = systemBucket
			} else {
				bucket = generationsBucket
			}
		}
	}
	if bucket == "avatars" || bucket == "_avatars" {
		bucket = systemBucket
	}
	fileKey := requestedKey
	if fileKey == "" {
		fileKey = fmt.Sprintf("uploads/%s/%s%s", session.User.ID, newRequestID(), strings.ToLower(filepath.Ext(filename)))
	}
	if err := b.authorizeUserStorageWrite(r, session.User.ID, bucket, fileKey); err != nil {
		return err
	}
	fileURL := "/api/storage/" + urlPathEscape(bucket) + "/" + urlPathEscape(fileKey)
	if endpoint, endpointErr := b.settingString(r.Context(), "STORAGE_ENDPOINT", ""); endpointErr != nil {
		return endpointErr
	} else if strings.TrimSpace(endpoint) != "" {
		access, accessErr := b.settingString(r.Context(), "STORAGE_ACCESS_KEY_ID", "")
		if accessErr != nil {
			return accessErr
		}
		secret, secretErr := b.settingString(r.Context(), "STORAGE_SECRET_ACCESS_KEY", "")
		if secretErr != nil {
			return secretErr
		}
		region, regionErr := b.settingString(r.Context(), "STORAGE_REGION", "auto")
		if regionErr != nil {
			return regionErr
		}
		if access == "" || secret == "" {
			return &apiError{503, "STORAGE_CONFIG_INVALID", "Storage credentials are not configured"}
		}
		cfg, cfgErr := awsconfig.LoadDefaultConfig(r.Context(), awsconfig.WithRegion(region), awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(access, secret, "")))
		if cfgErr != nil {
			return cfgErr
		}
		client := s3.NewFromConfig(cfg, func(o *s3.Options) { o.UsePathStyle = true; o.BaseEndpoint = aws.String(endpoint) })
		presigner := s3.NewPresignClient(client)
		presigned, presignErr := presigner.PresignPutObject(r.Context(), &s3.PutObjectInput{Bucket: aws.String(bucket), Key: aws.String(fileKey), ContentType: aws.String(contentType), ContentLength: func() *int64 {
			if contentLength > 0 {
				return aws.Int64(contentLength)
			}
			return nil
		}()}, func(o *s3.PresignOptions) { o.Expires = time.Hour })
		if presignErr != nil {
			return presignErr
		}
		writeJSON(w, 200, map[string]any{"presignedUrl": presigned.URL, "uploadUrl": presigned.URL, "fileKey": fileKey, "fileUrl": fileURL, "key": fileKey, "bucket": bucket, "contentType": contentType, "expiresIn": 3600, "maxFileSizeBytes": maxBytes})
		return nil
	}
	writeJSON(w, 200, map[string]any{"presignedUrl": fileURL, "uploadUrl": fileURL, "fileKey": fileKey, "fileUrl": fileURL, "key": fileKey, "bucket": bucket, "contentType": contentType, "expiresIn": 3600, "maxFileSizeBytes": maxBytes})
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
	isAvatarAlias := bucket == "_avatars"
	if isAvatarAlias {
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
	if !validStorageObjectPath(bucket, key) {
		return &apiError{400, "INVALID_PATH", "Invalid storage path"}
	}
	uploadBucket, err := b.settingString(r.Context(), "STORAGE_BUCKET_NAME", "gpt2image-uploads")
	if err != nil {
		return err
	}
	domain := storageObjectDomain(bucket, key, systemBucket, generationsBucket)
	// Uploads may share a physical bucket with generations or system assets.
	// Preserve the resolved namespace so private images keep their thumbnails
	// and public avatars/covers/logos keep their own access rules.
	if domain == "" && (bucket == uploadBucket || bucket == "documents") {
		domain = "documents"
	}
	if domain == "" {
		legacy, legacyErr := b.historicalGenerationStorageObject(r.Context(), bucket, key)
		if legacyErr != nil {
			return legacyErr
		}
		if legacy {
			domain = "generations"
		}
	}
	if domain == "" || (isAvatarAlias && domain != "avatars") {
		return &apiError{400, "INVALID_PATH", "Invalid public asset key"}
	}
	if thumbWidth != 0 && domain != "generations" && domain != "avatars" {
		return &apiError{400, "INVALID_THUMBNAIL", "Public asset thumbnails are not allowed"}
	}
	if domain == "generations" || domain == "documents" {
		if err := b.verifyStorageSignature(r, bucket, key); err != nil {
			// First-party requests may use a valid session for objects they own,
			// matching the Next route's signature fallback.
			if !b.storageObjectOwned(r, bucket, key) {
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
	thumbnailEncoded := false
	if thumbWidth > 0 {
		if thumb, thumbErr := storageThumbnail(data, thumbWidth); thumbErr == nil {
			thumbnailEncoded = !bytes.Equal(data, thumb)
			data = thumb
		}
	}
	contentType := storageContentType(key, data, thumbnailEncoded)
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if domain == "generations" || domain == "documents" {
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
	http.ServeContent(w, r, key, time.Time{}, bytes.NewReader(data))
	return nil
}

// storageContentType resolves the response MIME without trusting an opaque
// object key as the only source of truth. Generation workers historically used
// extensionless keys, and the browser's reference-image loader intentionally
// rejects application/octet-stream. DecodeConfig validates the image header
// without decoding all pixels and also covers WebP, which net/http's content
// sniffer does not recognize.
func storageContentType(key string, data []byte, thumbnailEncoded bool) string {
	if thumbnailEncoded {
		return "image/webp"
	}

	contentType := "application/octet-stream"
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

	if contentType == "application/octet-stream" || isRasterImageContentType(contentType) {
		if detected := detectRasterImageContentType(data); detected != "" {
			return detected
		}
	}
	return contentType
}

func isRasterImageContentType(contentType string) bool {
	return contentType == "image/png" || contentType == "image/jpeg" || contentType == "image/webp"
}

func detectRasterImageContentType(data []byte) string {
	_, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return ""
	}
	switch format {
	case "png":
		return "image/png"
	case "jpeg":
		return "image/jpeg"
	case "webp":
		return "image/webp"
	default:
		return ""
	}
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
	return b.readStorageObjectLimited(ctx, bucket, key, 0)
}

func (b *backend) readStorageObjectLimited(ctx context.Context, bucket, key string, maxBytes int64) ([]byte, error) {
	read := func(reader io.Reader) ([]byte, error) {
		if maxBytes > 0 {
			reader = io.LimitReader(reader, maxBytes+1)
		}
		data, err := io.ReadAll(reader)
		if err != nil {
			return nil, err
		}
		if maxBytes > 0 && int64(len(data)) > maxBytes {
			return nil, invalid("Storage object exceeds the file size limit")
		}
		return data, nil
	}
	endpoint, err := b.settingString(ctx, "STORAGE_ENDPOINT", "")
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(endpoint) == "" {
		file, err := os.Open(filepath.Join(b.config.storagePath, bucket, filepath.FromSlash(key)))
		if err != nil {
			return nil, err
		}
		defer file.Close()
		return read(file)
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
	if maxBytes > 0 && resp.ContentLength != nil && *resp.ContentLength > maxBytes {
		return nil, invalid("Storage object exceeds the file size limit")
	}
	return read(resp.Body)
}

func (b *backend) writeStorageObject(ctx context.Context, bucket, key string, data []byte, contentType string) error {
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
	if access == "" || secret == "" {
		return &apiError{503, "STORAGE_CONFIG_INVALID", "Storage credentials are not configured"}
	}
	region, err := b.settingString(ctx, "STORAGE_REGION", "auto")
	if err != nil {
		return err
	}
	cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(region), awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(access, secret, "")))
	if err != nil {
		return err
	}
	client := s3.NewFromConfig(cfg, func(o *s3.Options) { o.UsePathStyle = true; o.BaseEndpoint = aws.String(endpoint) })
	_, err = client.PutObject(ctx, &s3.PutObjectInput{Bucket: aws.String(bucket), Key: aws.String(key), Body: bytes.NewReader(data), ContentType: aws.String(contentType)})
	return err
}

// deleteStorageObject is shared by HTTP handlers and maintenance jobs. Missing
// local objects are already deleted, matching S3 DeleteObject's idempotency.
func (b *backend) deleteStorageObject(ctx context.Context, bucket, key string) error {
	endpoint, err := b.settingString(ctx, "STORAGE_ENDPOINT", "")
	if err != nil {
		return err
	}
	if strings.TrimSpace(endpoint) == "" {
		err := os.Remove(filepath.Join(b.config.storagePath, bucket, filepath.FromSlash(key)))
		if os.IsNotExist(err) {
			return nil
		}
		return err
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
	_, err = client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(bucket), Key: aws.String(key)})
	return err
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

func (b *backend) storageObjectOwned(r *http.Request, bucket, key string) bool {
	var userID string
	if p, ok := b.signedInternalPrincipal(r); ok {
		userID = p.UserID
	} else {
		session, err := b.requireSession(r)
		if err != nil || session == nil {
			return false
		}
		userID = session.User.ID
	}
	if strings.HasPrefix(key, "uploads/"+userID+"/") {
		return true
	}
	var owned bool
	err := b.db.QueryRow(r.Context(), `SELECT EXISTS (SELECT 1 FROM generation WHERE user_id=$1 AND storage_bucket=$2 AND storage_key=$3 UNION ALL SELECT 1 FROM video_generation WHERE user_id=$1 AND storage_bucket=$2 AND storage_key=$3)`, userID, bucket, key).Scan(&owned)
	return err == nil && owned
}

func (b *backend) historicalGenerationStorageObject(ctx context.Context, bucket, key string) (bool, error) {
	var exists bool
	err := b.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM generation WHERE storage_bucket=$1 AND storage_key=$2 UNION ALL SELECT 1 FROM video_generation WHERE storage_bucket=$1 AND storage_key=$2)`, bucket, key).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("classify historical storage object: %w", err)
	}
	return exists, nil
}

func documentContentType(filename string) string {
	switch strings.ToLower(filepath.Ext(filename)) {
	case ".pdf":
		return "application/pdf"
	case ".docx":
		return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
	case ".doc":
		return "application/msword"
	case ".md":
		return "text/markdown"
	case ".txt":
		return "text/plain"
	default:
		return ""
	}
}

func isOwnAvatarKey(userID, key string) bool {
	return regexp.MustCompile(`^avatars/` + regexp.QuoteMeta(userID) + `-[0-9]+\.(jpe?g|png|gif|webp)$`).MatchString(key)
}

func (b *backend) authorizeUserStorageWrite(r *http.Request, userID, bucket, key string) error {
	if !validStorageObjectPath(bucket, key) {
		return invalid("Invalid storage path")
	}
	system, generations, err := b.storageBuckets(r.Context())
	if err != nil {
		return err
	}
	uploads, err := b.settingString(r.Context(), "STORAGE_BUCKET_NAME", "gpt2image-uploads")
	if err != nil {
		return err
	}
	if bucket == system && isOwnAvatarKey(userID, key) {
		return nil
	}
	if (bucket == generations || bucket == uploads || bucket == "documents") && strings.HasPrefix(key, "uploads/"+userID+"/") {
		return nil
	}
	return forbidden()
}

func (b *backend) handleStoragePut(w http.ResponseWriter, r *http.Request) error {
	session, err := b.requireSession(r)
	if err != nil {
		return err
	}
	bucket, key := r.PathValue("bucket"), r.PathValue("key")
	if err := b.authorizeUserStorageWrite(r, session.User.ID, bucket, key); err != nil {
		return err
	}
	fileMB, err := b.settingInt(r, "MEDIA_MAX_FILE_SIZE_MB", 5, 1, 200)
	if err != nil {
		return err
	}
	maxBytes := int64(fileMB) * 1024 * 1024
	contentType := r.Header.Get("Content-Type")
	if documentType := documentContentType(key); documentType != "" {
		contentType = documentType
		maxBytes = 10 * 1024 * 1024
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, maxBytes+1))
	if err != nil {
		return err
	}
	if int64(len(data)) > maxBytes {
		return &apiError{413, "REQUEST_BODY_TOO_LARGE", "请求体过大"}
	}
	if isOwnAvatarKey(session.User.ID, key) {
		detected := http.DetectContentType(data)
		if detected != "image/jpeg" && detected != "image/png" && detected != "image/gif" && detected != "image/webp" {
			return invalid("Invalid avatar image")
		}
		contentType = detected
	}
	if err := b.writeStorageObject(r.Context(), bucket, key, data, contentType); err != nil {
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
	system, generations, err := b.storageBuckets(r.Context())
	if err != nil {
		return err
	}
	if in.Bucket == "" {
		if isOwnAvatarKey(s.User.ID, in.Key) {
			in.Bucket = system
		} else {
			in.Bucket = generations
		}
	}
	if err := b.authorizeUserStorageWrite(r, s.User.ID, in.Bucket, in.Key); err != nil {
		return err
	}
	if err := b.deleteStorageObject(r.Context(), in.Bucket, in.Key); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "key": in.Key})
	return nil
}

func (b *backend) handleStorageDeletePath(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireSession(r)
	if err != nil {
		return err
	}
	bucket, key := r.PathValue("bucket"), r.PathValue("key")
	if err := b.authorizeUserStorageWrite(r, s.User.ID, bucket, key); err != nil {
		return err
	}
	if err := b.deleteStorageObject(r.Context(), bucket, key); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "key": key})
	return nil
}

// storageOperationAuthorized accepts the short-lived cron credential for
// system UOL operations and falls back to the browser session for protected
// user operations.
func validStorageObjectPath(bucket, key string) bool {
	if bucket == "" || bucket == "." || bucket == ".." || strings.ContainsAny(bucket, "/\\\x00") || key == "" || filepath.IsAbs(key) || filepath.Clean(key) != key || strings.ContainsAny(key, "\\\x00") {
		return false
	}
	for _, part := range strings.Split(key, "/") {
		if part == ".." || part == "." || part == "" {
			return false
		}
	}
	return true
}

func (b *backend) storageOperationAuthorized(r *http.Request, bucket, key string, systemOnly bool) error {
	if !validStorageObjectPath(bucket, key) {
		return invalid("Invalid storage path")
	}
	if b.cronAuthorized(r) {
		return nil
	}
	if systemOnly {
		return forbidden()
	}
	if _, ok := b.signedInternalPrincipal(r); ok {
		return nil
	}
	_, err := b.requireSession(r)
	return err
}

func (b *backend) handleStorageObjectRead(w http.ResponseWriter, r *http.Request) error {
	body, err := decodeObject(r)
	if err != nil {
		return err
	}
	bucket, key := rawString(body, "bucket"), rawString(body, "key")
	if err := b.storageOperationAuthorized(r, bucket, key, false); err != nil {
		return err
	}
	if bucket == "" || key == "" {
		return invalid("bucket and key are required")
	}
	if !b.cronAuthorized(r) {
		systemBucket, generationsBucket, bucketErr := b.storageBuckets(r.Context())
		if bucketErr != nil {
			return bucketErr
		}
		uploadBucket, err := b.settingString(r.Context(), "STORAGE_BUCKET_NAME", "gpt2image-uploads")
		if err != nil {
			return err
		}
		if bucket != systemBucket && bucket != generationsBucket && bucket != uploadBucket && bucket != "documents" {
			return forbidden()
		}
		if (bucket == generationsBucket || bucket == uploadBucket || bucket == "documents") && !b.storageObjectOwned(r, bucket, key) {
			return forbidden()
		}
	}
	data, err := b.readStorageObject(r.Context(), bucket, key)
	if err != nil {
		if os.IsNotExist(err) {
			return &apiError{404, "NOT_FOUND", "storage object not found"}
		}
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": base64.StdEncoding.EncodeToString(data), "contentType": http.DetectContentType(data), "contentLength": len(data)})
	return nil
}

func (b *backend) handleStorageObjectPut(w http.ResponseWriter, r *http.Request) error {
	body, err := decodeObject(r)
	if err != nil {
		return err
	}
	bucket, key := rawString(body, "bucket"), rawString(body, "key")
	if err := b.storageOperationAuthorized(r, bucket, key, true); err != nil {
		return err
	}
	encoded := rawString(body, "data")
	if bucket == "" || key == "" || body["data"] == nil {
		return invalid("bucket, key and data are required")
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return invalid("data must be base64")
	}
	contentType := rawString(body, "contentType")
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	if err := b.writeStorageObject(r.Context(), bucket, key, data, contentType); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "key": key})
	return nil
}

func (b *backend) handleStorageObjectDelete(w http.ResponseWriter, r *http.Request) error {
	body, err := decodeObject(r)
	if err != nil {
		return err
	}
	bucket, key := rawString(body, "bucket"), rawString(body, "key")
	if err := b.storageOperationAuthorized(r, bucket, key, true); err != nil {
		return err
	}
	if bucket == "" || key == "" {
		return invalid("bucket and key are required")
	}
	if err := b.deleteStorageObject(r.Context(), bucket, key); err != nil && !os.IsNotExist(err) {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
	return nil
}

func (b *backend) handleStorageSignedReadURL(w http.ResponseWriter, r *http.Request) error {
	body, err := decodeObject(r)
	if err != nil {
		return err
	}
	bucket, key := rawString(body, "bucket"), rawString(body, "key")
	if err := b.storageOperationAuthorized(r, bucket, key, true); err != nil {
		return err
	}
	if bucket == "" || key == "" {
		return invalid("bucket and key are required")
	}
	expires := 3600
	if raw, exists := body["expiresIn"]; exists {
		var value *int
		if err := json.Unmarshal(raw, &value); err != nil || value == nil || *value < 1 || *value > 86400 {
			return invalid("Invalid signed URL expiry")
		}
		expires = *value
	}
	signedURL, err := b.storageSignedReadURL(r.Context(), bucket, key, expires)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"url": signedURL})
	return nil
}

func (b *backend) storageSignedReadURL(ctx context.Context, bucket, key string, expires int) (string, error) {
	if !validStorageObjectPath(bucket, key) {
		return "", invalid("Invalid storage path")
	}
	if expires < 1 || expires > 86400 {
		return "", invalid("Invalid signed URL expiry")
	}
	exp := time.Now().Add(time.Duration(expires) * time.Second).Unix()
	if endpoint, endpointErr := b.settingString(ctx, "STORAGE_ENDPOINT", ""); endpointErr != nil {
		return "", endpointErr
	} else if strings.TrimSpace(endpoint) != "" {
		access, accessErr := b.settingString(ctx, "STORAGE_ACCESS_KEY_ID", "")
		if accessErr != nil {
			return "", accessErr
		}
		secret, secretErr := b.settingString(ctx, "STORAGE_SECRET_ACCESS_KEY", "")
		if secretErr != nil {
			return "", secretErr
		}
		region, regionErr := b.settingString(ctx, "STORAGE_REGION", "auto")
		if regionErr != nil {
			return "", regionErr
		}
		if access == "" || secret == "" {
			return "", &apiError{503, "STORAGE_CONFIG_INVALID", "Storage credentials are not configured"}
		}
		cfg, cfgErr := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(region), awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(access, secret, "")))
		if cfgErr != nil {
			return "", cfgErr
		}
		client := s3.NewFromConfig(cfg, func(o *s3.Options) { o.UsePathStyle = true; o.BaseEndpoint = aws.String(endpoint) })
		presigner := s3.NewPresignClient(client)
		presigned, presignErr := presigner.PresignGetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(bucket), Key: aws.String(key)}, func(o *s3.PresignOptions) { o.Expires = time.Duration(expires) * time.Second })
		if presignErr != nil {
			return "", presignErr
		}
		return presigned.URL, nil
	}
	mac := hmac.New(sha256.New, []byte(b.config.authSecret))
	_, _ = mac.Write([]byte(bucket + "/" + key + ":" + strconv.FormatInt(exp, 10)))
	url := "/api/storage/" + urlPathEscape(bucket) + "/" + urlPathEscape(key) + "?exp=" + strconv.FormatInt(exp, 10) + "&sig=" + hex.EncodeToString(mac.Sum(nil))
	return url, nil
}
func urlPathEscape(value string) string {
	parts := strings.Split(value, "/")
	for i := range parts {
		parts[i] = url.PathEscape(parts[i])
	}
	return strings.Join(parts, "/")
}

func (b *backend) handleReferral(w http.ResponseWriter, r *http.Request) error {
	rawCode := strings.TrimSpace(r.PathValue("code"))
	code := ""
	if referralCodePattern.MatchString(rawCode) {
		code = strings.ToUpper(rawCode)
	}

	// Keep the locale contract in lockstep with the Next route: an explicit,
	// supported NEXT_LOCALE cookie wins over Accept-Language.
	locale := "zh"
	cookieLocale := false
	if cookie, err := r.Cookie("NEXT_LOCALE"); err == nil {
		switch cookie.Value {
		case "en", "zh":
			locale = cookie.Value
			cookieLocale = true
		}
	}
	if !cookieLocale && strings.HasPrefix(strings.ToLower(strings.TrimSpace(r.Header.Get("Accept-Language"))), "en") {
		locale = "en"
	}

	origin := b.referralRedirectOrigin(r)
	redirect, err := url.Parse(origin)
	if err != nil {
		return fmt.Errorf("parse referral redirect origin: %w", err)
	}
	redirect.Path = "/" + locale + "/sign-up"
	redirect.RawQuery = ""
	redirect.Fragment = ""
	w.Header().Set("Location", redirect.String())
	if code != "" {
		http.SetCookie(w, &http.Cookie{Name: "fluxmedia_referral_code", Value: code, Path: "/", MaxAge: 30 * 24 * 60 * 60, HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: b.config.production})
	}
	w.WriteHeader(http.StatusSeeOther)
	return nil
}

// handleUnsupportedReferralMethod makes the read-only referral contract
// explicit for clients that accidentally submit a mutating request.
func (b *backend) handleUnsupportedReferralMethod(w http.ResponseWriter, r *http.Request) error {
	w.Header().Set("Allow", http.MethodGet)
	return &apiError{http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "推广链接仅支持 GET 请求"}
}

var referralCodePattern = regexp.MustCompile(`^[A-Za-z0-9]{6,32}$`)

const defaultPublicAppURL = "https://media.flux-code.cc"

// referralRedirectOrigin mirrors resolvePublicAppUrl from the shared package:
// configured public origins win, while internal listener addresses are
// rejected and the canonical public site remains the final fallback.
func (b *backend) referralRedirectOrigin(r *http.Request) string {
	for _, candidate := range []string{b.config.authURL, b.config.publicAppURL} {
		if origin := normalizeReferralOrigin(candidate); origin != "" {
			return origin
		}
	}

	proto := "http"
	if forwarded := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0]); forwarded == "http" || forwarded == "https" {
		proto = forwarded
	} else if r.TLS != nil {
		proto = "https"
	}
	for _, authority := range []string{
		strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Host"), ",")[0]),
		r.Host,
	} {
		if authority == "" {
			continue
		}
		if origin := normalizeReferralOrigin(proto + "://" + authority); origin != "" {
			return origin
		}
	}
	return defaultPublicAppURL
}

func normalizeReferralOrigin(candidate string) string {
	if strings.TrimSpace(candidate) == "" {
		return ""
	}
	u, err := url.Parse(strings.TrimSpace(candidate))
	// resolvePublicAppUrl uses the origin of configured URLs; tolerate a
	// configured base path but discard it when building the sign-up target.
	if err != nil || u.Host == "" || u.User != nil || (u.Scheme != "http" && u.Scheme != "https") || u.RawQuery != "" || u.Fragment != "" {
		return ""
	}
	host := strings.ToLower(u.Hostname())
	switch host {
	case "0.0.0.0", "127.0.0.1", "localhost", "::", "::1":
		return ""
	}
	if strings.HasSuffix(host, ".localhost") {
		return ""
	}
	port := u.Port()
	if (u.Scheme == "http" && port == "80") || (u.Scheme == "https" && port == "443") {
		port = ""
	}
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if port != "" {
		host += ":" + port
	}
	return u.Scheme + "://" + host
}
