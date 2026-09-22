package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type imageProcessingRequest struct {
	ImageBase64      string `json:"imageBase64"`
	RequestedSize    string `json:"requestedSize"`
	RepairPrompt     string `json:"repairPrompt"`
	Final            bool   `json:"final"`
	Restore          bool   `json:"restore"`
	Repair           string `json:"repair"`
	SuperResolution  bool   `json:"superResolution"`
	TransparentMatte bool   `json:"transparentMatte"`
}
type imageProcessingMessage struct {
	Type        string `json:"type"`
	ImageBase64 string `json:"imageBase64"`
	MaskBase64  string `json:"maskBase64"`
	Prompt      string `json:"prompt"`
	Width       int    `json:"width"`
	Height      int    `json:"height"`
	Index       int    `json:"index"`
}

func (w *mediaWorker) postprocessImageOutput(ctx context.Context, taskID, generationID, userID string, index int, item map[string]any, data []byte) ([]byte, string, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Minute)
	defer cancel()
	b := w.backend
	var inputRaw, metadataRaw []byte
	var size string
	if err := b.db.QueryRow(ctx, `SELECT COALESCE(t.generation_input,t.generation_inputs->0,'{}'::json),COALESCE(g.metadata,'{}'::json),COALESCE(g.size,'1024x1024') FROM image_async_task t JOIN generation g ON g.id=$2 AND g.user_id=t.user_id WHERE t.id=$1 AND t.user_id=$3`, taskID, generationID, userID).Scan(&inputRaw, &metadataRaw, &size); err != nil {
		return nil, "", err
	}
	var input, metadata map[string]any
	if json.Unmarshal(inputRaw, &input) != nil || json.Unmarshal(metadataRaw, &metadata) != nil {
		return nil, "", errors.New("invalid image postprocessing input")
	}
	request := imageProcessingRequest{ImageBase64: base64.StdEncoding.EncodeToString(data), RequestedSize: size, RepairPrompt: extractString(input, "repairPrompt", "repair_prompt"), Final: extractString(item, "outputRole", "role") != "choice", TransparentMatte: metadata["transparentMatteRequired"] == true}
	if request.Final {
		if boolOrDefault(input["hdRepair"], boolOrDefault(input["hd_repair"], false)) {
			enabled, err := b.settingBool(ctx, "IMAGE_RESTORATION_ENABLED", false)
			if err != nil {
				return nil, "", err
			}
			request.Restore = enabled
		}
		if boolOrDefault(input["blockRepair"], boolOrDefault(input["block_repair"], false)) {
			mask, err := b.settingBool(ctx, "IMAGE_MASK_OUTPAINT_ENABLED", false)
			if err != nil {
				return nil, "", err
			}
			whole, err := b.settingBool(ctx, "IMAGE_BLOCK_REPAIR_ENABLED", false)
			if err != nil {
				return nil, "", err
			}
			if mask {
				request.Repair = "mask"
			} else if whole {
				request.Repair = "whole"
			}
		}
		var err error
		request.SuperResolution, err = b.settingBool(ctx, "IMAGE_SUPER_RESOLUTION_ENABLED", false)
		if err != nil {
			return nil, "", err
		}
	}
	if !request.Restore && request.Repair == "" && !request.SuperResolution && !request.TransparentMatte {
		return data, http.DetectContentType(data), nil
	}
	result, err := b.processImageWithRuntime(ctx, request, func(message imageProcessingMessage) ([]byte, error) {
		data, err := b.runImageRepairEdit(ctx, taskID, generationID, userID, index, message)
		if err != nil {
			b.logger.WarnContext(ctx, "image repair step failed", "generation_id", generationID, "output_index", index, "tile_index", message.Index, "error", err)
		}
		return data, err
	})
	if err != nil {
		if ctx.Err() != nil {
			return nil, "", ctx.Err()
		}
		if request.TransparentMatte {
			return nil, "", err
		}
		b.logger.WarnContext(ctx, "image postprocessing failed; using original output", "generation_id", generationID, "error", err)
		return data, http.DetectContentType(data), nil
	}
	return result, http.DetectContentType(result), nil
}

func (b *backend) processImageWithRuntime(ctx context.Context, input imageProcessingRequest, edit func(imageProcessingMessage) ([]byte, error)) ([]byte, error) {
	origin := strings.TrimRight(strings.TrimSpace(os.Getenv("GO_MEDIA_PROCESSING_URL")), "/")
	if origin == "" {
		origin = "http://127.0.0.1:8091"
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return nil, errors.New("invalid media processing runtime origin")
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Minute)
	defer cancel()
	for {
		reader, writer := io.Pipe()
		encoder := json.NewEncoder(writer)
		initial := make(chan error, 1)
		go func() { initial <- encoder.Encode(input) }()
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, origin+"/process", reader)
		if err != nil {
			_ = reader.Close()
			_ = writer.Close()
			return nil, err
		}
		req.Header.Set("Content-Type", "application/x-ndjson")
		if token := os.Getenv("GO_MEDIA_PROCESSING_TOKEN"); token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			_ = reader.Close()
			_ = writer.Close()
			<-initial
			return nil, err
		}
		if response.StatusCode != http.StatusOK {
			_ = reader.Close()
			_ = writer.Close()
			_ = response.Body.Close()
			<-initial
			if response.StatusCode == http.StatusServiceUnavailable {
				timer := time.NewTimer(2 * time.Second)
				select {
				case <-ctx.Done():
					timer.Stop()
					return nil, ctx.Err()
				case <-timer.C:
					continue
				}
			}
			return nil, fmt.Errorf("media processing runtime status %d", response.StatusCode)
		}
		if err = <-initial; err != nil {
			_ = reader.Close()
			_ = writer.Close()
			_ = response.Body.Close()
			return nil, err
		}
		result, err := consumeImageProcessingStream(ctx, response.Body, encoder, edit)
		_ = writer.Close()
		_ = reader.Close()
		_ = response.Body.Close()
		return result, err
	}
}

func consumeImageProcessingStream(ctx context.Context, body io.Reader, encoder *json.Encoder, edit func(imageProcessingMessage) ([]byte, error)) ([]byte, error) {
	decoder := json.NewDecoder(io.LimitReader(body, 2<<30))
	edits := 0
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		var message imageProcessingMessage
		if err := decoder.Decode(&message); err != nil {
			return nil, err
		}
		switch message.Type {
		case "result":
			data, err := base64.StdEncoding.DecodeString(message.ImageBase64)
			if err != nil || len(data) == 0 || len(data) > imageProviderMaxResponse {
				return nil, errors.New("invalid processed image output")
			}
			return data, nil
		case "edit":
			if edits >= 16 || message.Index < 0 || message.Index >= 16 || message.Width < 1 || message.Height < 1 || message.Width > 1280 || message.Height > 1280 || len(message.Prompt) > 32000 {
				return nil, errors.New("invalid image repair step")
			}
			edits++
			result, err := edit(message)
			reply := map[string]any{"type": "editResult", "index": message.Index}
			if err != nil {
				if ctx.Err() != nil {
					return nil, ctx.Err()
				}
				reply["error"] = "repair failed"
			} else {
				reply["imageBase64"] = base64.StdEncoding.EncodeToString(result)
			}
			if err := encoder.Encode(reply); err != nil {
				return nil, err
			}
		default:
			return nil, errors.New("image processing runtime failed")
		}
	}
}

type imageRepairReceipt struct {
	Stage           string `json:"stage"`
	MemberID        string `json:"memberId"`
	VersionID       string `json:"versionId"`
	TaskID          string `json:"taskId,omitempty"`
	StorageKey      string `json:"storageKey,omitempty"`
	StorageBucket   string `json:"storageBucket,omitempty"`
	InputStorageKey string `json:"inputStorageKey,omitempty"`
}

func (b *backend) runImageRepairEdit(ctx context.Context, taskID, generationID, userID string, outputIndex int, input imageProcessingMessage) (resultData []byte, resultErr error) {
	ctx = context.WithValue(ctx, imagePreviewContextKey{}, nil)
	data, err := base64.StdEncoding.DecodeString(input.ImageBase64)
	if err != nil || len(data) == 0 || len(data) > 16<<20 {
		return nil, errors.New("invalid repair image")
	}
	var mask []byte
	if input.MaskBase64 != "" {
		mask, err = base64.StdEncoding.DecodeString(input.MaskBase64)
		if err != nil || len(mask) == 0 || len(mask) > 16<<20 {
			return nil, errors.New("invalid repair mask")
		}
	}
	step := fmt.Sprintf("%d:%d", outputIndex, input.Index)
	sourceRef := generationID + ":blockrepair-" + step
	var metadataRaw []byte
	var apiKeyID string
	if err = b.db.QueryRow(ctx, `SELECT g.metadata,COALESCE(t.api_key_id,'') FROM generation g JOIN image_async_task t ON t.id=$2 AND t.user_id=g.user_id WHERE g.id=$1 AND g.user_id=$3`, generationID, taskID, userID).Scan(&metadataRaw, &apiKeyID); err != nil {
		return nil, err
	}
	var metadata map[string]any
	if json.Unmarshal(metadataRaw, &metadata) != nil {
		return nil, errors.New("invalid repair billing snapshot")
	}
	if previous := goMapObject(goMapObject(metadata, "imageRepairSteps"), step); previous != nil {
		if previous["stage"] == "completed" {
			return b.readStorageObjectLimited(ctx, extractString(previous, "storageBucket"), extractString(previous, "storageKey"), imageProviderMaxResponse)
		}
		return nil, errors.New("repair submission already attempted")
	}
	snapshot := goMapObject(metadata, "billingSnapshot")
	var group imageGroupSnapshot
	if json.Unmarshal([]byte(mustJSON(snapshot["group"])), &group) != nil || group.ID == "" {
		return nil, errors.New("repair requires the original authorized group")
	}
	if _, err = b.db.Exec(ctx, `DELETE FROM image_backend_member_lease WHERE id=$1 AND owner_token=$2`, "go-image:"+taskID, ctx.Value(imageWorkerClaimKey{})); err != nil {
		return nil, err
	}
	cfg, err := b.pickImageRepairProvider(ctx, group, boolOrDefault(snapshot["moderationEnabled"], false), len(mask) > 0, input.Width, input.Height)
	if err != nil {
		return nil, err
	}
	leaseID := "go-image-repair:" + taskID + ":" + step
	repairContext, stop, err := b.acquireImageRepairLease(ctx, taskID, leaseID, cfg)
	if err != nil {
		return nil, err
	}
	defer stop()
	ctx = repairContext
	// Only errors observed while executing the upstream edit affect this member.
	// Local storage, image processing and credit settlement are separate stages.
	var providerErr error
	defer func() {
		if providerErr != nil {
			report, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			defer cancel()
			if err := b.recordImageSchedulerResult(report, taskID, cfg.memberID, leaseID, false, providerErr); err != nil {
				resultErr = errors.Join(resultErr, err)
			}
		}
	}()
	// Persist before submission: a crash must never cause another paid provider call.
	receipt := imageRepairReceipt{Stage: "submitting", MemberID: cfg.memberID, VersionID: cfg.versionID}
	if cfg.adapter["convertReferenceImagesToPublicUrl"] == true {
		_, bucket, err := b.storageBuckets(ctx)
		if err != nil {
			return nil, err
		}
		receipt.StorageBucket = bucket
		receipt.InputStorageKey = fmt.Sprintf("%s/generations/%s/repair-input-%s", userID, generationID, strings.ReplaceAll(step, ":", "-"))
		if err = b.putStorageObject(ctx, bucket, receipt.InputStorageKey, data, "image/png"); err != nil {
			return nil, err
		}
		defer func() {
			cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_ = b.deleteStorageObject(cleanup, bucket, receipt.InputStorageKey)
		}()
	}

	tx, err := b.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer rollback(tx)
	if err = assertImageRepairClaim(ctx, tx, taskID); err != nil {
		return nil, err
	}
	tag, err := tx.Exec(ctx, `UPDATE generation SET metadata=jsonb_set(COALESCE(metadata::jsonb,'{}'::jsonb),'{imageRepairSteps}',COALESCE(metadata::jsonb->'imageRepairSteps','{}'::jsonb)||jsonb_build_object($3::text,$4::jsonb))::json WHERE id=$1 AND user_id=$2 AND status='pending' AND NOT COALESCE(metadata::jsonb->'imageRepairSteps','{}'::jsonb) ? $3`, generationID, userID, step, mustJSON(receipt))
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() != 1 {
		return nil, errors.New("repair was already submitted")
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	body, err := imageProviderParameters(cfg, "gpt-image-2", map[string]any{"prompt": input.Prompt, "size": fmt.Sprintf("%dx%d", input.Width, input.Height), "aspectRatio": imageRepairAspectRatio(input.Width, input.Height), "resolution": "1k", "outputFormat": "png"})
	if err != nil {
		return nil, err
	}
	if cfg.adapter["convertReferenceImagesToPublicUrl"] == true {
		signed, err := b.storageSignedReadURL(ctx, receipt.StorageBucket, receipt.InputStorageKey, 3600)
		if err != nil {
			return nil, err
		}
		if strings.HasPrefix(signed, "/") {
			origin := b.config.publicAppURL
			if origin == "" {
				origin = b.config.authURL
			}
			signed = strings.TrimRight(origin, "/") + signed
		}
		parsed, err := url.Parse(signed)
		if err != nil || parsed.Host == "" {
			return nil, errors.New("repair image has no absolute URL")
		}
		body["image_urls"] = []string{signed}
	} else {
		body["image"] = &imageProviderFile{Name: "image.png", MIME: "image/png", Data: data}
		if len(mask) > 0 {
			body["mask"] = &imageProviderFile{Name: "mask.png", MIME: "image/png", Data: mask}
		}
		for key, value := range body {
			if _, ok := value.(*imageProviderFile); !ok {
				body[key] = fmt.Sprint(value)
			}
		}
	}
	output, err := b.callProvider(ctx, cfg, "images.edit", body, sourceRef, "gpt-image-2")
	if err != nil {
		providerErr = err
		return nil, err
	}
	for {
		pending, providerID, err := inspectImageProviderResult(output, receipt.TaskID)
		if err != nil {
			providerErr = err
			return nil, err
		}
		if !pending {
			break
		}
		receipt.TaskID = providerID
		timer := time.NewTimer(5 * time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
		output, err = b.queryImageProvider(ctx, cfg, "images.edit.query", providerID, "gpt-image-2")
		if err != nil {
			providerErr = err
			return nil, err
		}
	}
	outputs := imageProviderOutputItems(output)
	if len(outputs) == 0 {
		providerErr = errors.New("repair provider omitted output")
		return nil, providerErr
	}
	result, mimeType, err := readImageProviderOutput(ctx, outputs[0])
	if err != nil {
		providerErr = err
		return nil, err
	}
	_, bucket, err := b.storageBuckets(ctx)
	if err != nil {
		return nil, err
	}
	key := fmt.Sprintf("%s/generations/%s/repair-%s", userID, generationID, strings.ReplaceAll(step, ":", "-"))
	if err = b.putStorageObject(ctx, bucket, key, result, mimeType); err != nil {
		return nil, err
	}
	saved := false
	defer func() {
		if !saved {
			clean, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_ = b.deleteStorageObject(clean, bucket, key)
		}
	}()
	receipt.Stage, receipt.StorageKey, receipt.StorageBucket = "completed", key, bucket
	tx, err = b.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer rollback(tx)
	if err = assertImageRepairClaim(ctx, tx, taskID); err != nil {
		return nil, err
	}
	var createdAt time.Time
	if err = tx.QueryRow(ctx, `SELECT created_at FROM generation WHERE id=$1 AND user_id=$2 AND status='pending' FOR UPDATE`, generationID, userID).Scan(&createdAt); err != nil {
		return nil, err
	}
	prices := map[string]float64{}
	for field, value := range goMapObject(snapshot, "basePricing") {
		prices[field] = positiveNumber(value, 0)
	}
	priceKey := imageBillingPriceKey("", fmt.Sprintf("%dx%d", input.Width, input.Height), prices)
	amount := roundUpImageCredits(prices[priceKey])
	if amount <= 0 {
		return nil, errors.New("repair billing price missing")
	}
	request := (&http.Request{}).WithContext(ctx)
	wallet, err := b.lockCreditWallet(request, tx, userID)
	if err != nil {
		return nil, err
	}
	charge, err := b.consumeCreditTx(request, tx, wallet, creditMutation{UserID: userID, Amount: amount, ServiceName: "image_generation", SourceRef: sourceRef, Reason: "生成式修复", OperationType: "image_generation", OperationID: generationID, OperationCreatedAt: &createdAt, Metadata: map[string]any{"generationId": generationID, "blockRepair": true, "outputIndex": outputIndex, "tileIndex": input.Index}})
	if err != nil {
		return nil, err
	}
	if !charge.Replayed {
		if apiKeyID != "" && apiKeyID != "site" && apiKeyID != "session" && apiKeyID != "web:session" {
			tag, err := tx.Exec(ctx, `UPDATE external_api_key SET credits_used=credits_used+$3,last_used_at=now(),updated_at=now() WHERE id=$1 AND user_id=$2 AND is_active AND (credit_limit IS NULL OR credits_used+$3<=credit_limit)`, apiKeyID, userID, amount)
			if err != nil {
				return nil, err
			}
			if tag.RowsAffected() != 1 {
				return nil, &apiError{402, "API_KEY_CREDIT_LIMIT", "API key credit limit exceeded"}
			}
		}
		if _, err = tx.Exec(ctx, `UPDATE generation SET credits_consumed=credits_consumed+$2 WHERE id=$1`, generationID, amount); err != nil {
			return nil, err
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE generation SET metadata=jsonb_set(metadata::jsonb,$2,$3::jsonb)::json WHERE id=$1`, generationID, []string{"imageRepairSteps", step}, mustJSON(receipt)); err != nil {
		return nil, err
	}
	if err = mediaSchedulerOperationResultTx(ctx, tx, "image", taskID, cfg.memberID, leaseID, true, nil, false); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	saved = true
	return result, nil
}

func imageRepairAspectRatio(width, height int) string {
	divisor := width
	other := height
	for other != 0 {
		divisor, other = other, divisor%other
	}
	return strconv.Itoa(width/divisor) + ":" + strconv.Itoa(height/divisor)
}

func assertImageRepairClaim(ctx context.Context, tx pgx.Tx, taskID string) error {
	claim, _ := ctx.Value(imageWorkerClaimKey{}).(string)
	var valid bool
	if err := tx.QueryRow(ctx, `SELECT status='running' AND claim_token=$2 AND claim_expires_at>now() FROM image_async_task WHERE id=$1 FOR UPDATE`, taskID, claim).Scan(&valid); err != nil {
		return err
	}
	if claim == "" || !valid {
		return errImageClaimLost
	}
	return nil
}

func (b *backend) pickImageRepairProvider(ctx context.Context, group imageGroupSnapshot, safety, mask bool, width, height int) (providerConfig, error) {
	selection := mediaSchedulerSelection{GroupID: group.ID, StartedAt: time.Now()}
	strategy, err := b.mediaSchedulingStrategy(ctx)
	if err != nil {
		return providerConfig{}, err
	}
	selection.Strategy = strategy
	groups, err := reachableMediaGroupIDs(ctx, b.db, group.ID)
	if err != nil {
		return providerConfig{}, err
	}
	config, err := b.setting(ctx, "MODEL_MARKETPLACE_CONFIG", nil)
	if err != nil {
		return providerConfig{}, err
	}
	entry := goMapObject(goMapObject(config, "imageByModel"), "gpt-image-2")
	if entry["enabled"] == false {
		return providerConfig{}, errors.New("image repair model is disabled")
	}
	globalLimit, err := b.setting(ctx, "IMAGE_EDIT_MAX_REFERENCE_IMAGES", 16)
	if err != nil {
		return providerConfig{}, err
	}
	maxRefs := imageCreditValue(globalLimit, 16)
	if value, ok := entry["maxReferenceImages"].(float64); ok {
		maxRefs = value
	}

	rows, err := b.db.Query(ctx, `SELECT m.id FROM image_backend_member m JOIN image_backend_member_api_config c ON c.member_id=m.id JOIN image_backend_member_api_adapter_version v ON v.id=c.current_adapter_version_id AND v.member_id_snapshot=m.id AND v.credential_scope=c.credential_scope WHERE EXISTS(SELECT 1 FROM image_backend_member_group mg WHERE mg.member_id=m.id AND mg.group_id=ANY($1::text[])) AND m.is_enabled AND m.type='api' AND m.status<>'error' AND (m.cooldown_until IS NULL OR m.cooldown_until<=now()) AND (NOT $3 OR m.content_safety_enabled) AND v.configuration::jsonb->'operations' ? 'images.edit' AND (NOT COALESCE(m.supported_resolutions_by_model::jsonb,'{}'::jsonb) ? 'gpt-image-2' OR m.supported_resolutions_by_model::jsonb->'gpt-image-2' @> '["1k"]'::jsonb) AND (NOT $2 OR NOT COALESCE((v.configuration::jsonb->>'convertReferenceImagesToPublicUrl')::boolean,false)) AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(m.supported_model_ids::jsonb) models(id) WHERE lower(trim(models.id))='gpt-image-2') ORDER BY CASE WHEN m.concurrency>(SELECT count(*) FROM image_backend_member_lease l WHERE l.member_id=m.id AND l.expires_at>now()) THEN 0 ELSE 1 END,`+mediaSchedulingOrder(strategy), groups, mask, safety)
	if err != nil {
		return providerConfig{}, err
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return providerConfig{}, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return providerConfig{}, err
	}
	selection.Candidates = len(ids)
	for _, id := range ids {
		cfg, err := b.pickImageProvider(ctx, "gpt-image-2", group, id, safety)
		if err == nil {
			limit := maxRefs
			if value, ok := cfg.adapter["imageMaxReferenceImages"]; ok {
				limit = imageCreditValue(value, limit)
			}
			if value, ok := goMapObject(cfg.adapter, "imageMaxReferenceImagesByModel")["gpt-image-2"]; ok {
				limit = imageCreditValue(value, limit)
			}
			_, parameterErr := imageProviderParameters(cfg, "gpt-image-2", map[string]any{"size": fmt.Sprintf("%dx%d", width, height), "aspectRatio": imageRepairAspectRatio(width, height), "resolution": "1k"})
			if limit >= 1 && parameterErr == nil {
				cfg.scheduler = &selection
				return cfg, nil
			}
		}
	}
	if err = b.recordMediaSchedulerRejection(ctx, "image", "no_candidate", selection); err != nil {
		return providerConfig{}, err
	}
	return providerConfig{}, errors.New("authorized group has no image repair provider")
}

func (b *backend) acquireImageRepairLease(ctx context.Context, taskID, leaseID string, cfg providerConfig) (context.Context, func(), error) {
	tx, err := b.db.Begin(ctx)
	if err != nil {
		return nil, nil, err
	}
	defer rollback(tx)
	if err = assertImageRepairClaim(ctx, tx, taskID); err != nil {
		return nil, nil, err
	}
	// Main generation has finished; its member capacity is now available to the
	// independently selected repair call (which may use another member).
	claim, _ := ctx.Value(imageWorkerClaimKey{}).(string)
	if _, err = tx.Exec(ctx, `DELETE FROM image_backend_member_lease WHERE id=$1 AND owner_token=$2`, "go-image:"+taskID, claim); err != nil {
		return nil, nil, err
	}
	var capacity, active int
	if err = tx.QueryRow(ctx, `SELECT concurrency FROM image_backend_member WHERE id=$1 FOR UPDATE`, cfg.memberID).Scan(&capacity); err != nil {
		return nil, nil, err
	}
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM image_backend_member_lease WHERE member_id=$1 AND expires_at>now()`, cfg.memberID).Scan(&active); err != nil {
		return nil, nil, err
	}
	if capacity < 1 || active >= capacity {
		if cfg.scheduler != nil {
			if err = recordMediaSchedulerMetric(ctx, tx, "image", "capacity_rejected", "", *cfg.scheduler); err != nil {
				return nil, nil, err
			}
			if err = tx.Commit(ctx); err != nil {
				return nil, nil, err
			}
		}
		return nil, nil, errImageProviderCapacity
	}
	if _, err = tx.Exec(ctx, `INSERT INTO image_backend_member_lease(id,member_id,owner_token,expires_at,api_adapter_member_id,api_adapter_version_id) VALUES($1,$2,$3,now()+$4::interval,$2,$5)`, leaseID, cfg.memberID, claim, mediaWorkerClaimTTL.String(), cfg.versionID); err != nil {
		return nil, nil, err
	}
	if err = mediaSchedulerAcquiredTx(ctx, tx, "image", taskID, cfg.memberID, cfg.scheduler, leaseID); err != nil {
		return nil, nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, nil, err
	}
	leaseContext, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-leaseContext.Done():
				return
			case <-done:
				return
			case <-ticker.C:
				tag, err := b.db.Exec(leaseContext, `UPDATE image_backend_member_lease SET expires_at=now()+$3::interval,updated_at=now() WHERE id=$1 AND owner_token=$2 AND EXISTS(SELECT 1 FROM image_async_task WHERE id=$4 AND claim_token=$2 AND claim_expires_at>now() AND status='running')`, leaseID, claim, mediaWorkerClaimTTL.String(), taskID)
				if err != nil || tag.RowsAffected() != 1 {
					cancel()
					return
				}
			}
		}
	}()
	return leaseContext, func() {
		cancel()
		close(done)
		<-stopped
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, _ = b.db.Exec(cleanup, `DELETE FROM image_backend_member_lease WHERE id=$1 AND owner_token=$2`, leaseID, claim)
	}, nil
}

// Drop repair intermediates after the generation is terminal. Failed deletion
// leaves the receipt intact so maintenance can retry without losing evidence.
func (b *backend) cleanupImageRepairObjects(ctx context.Context) error {
	rows, err := b.db.Query(ctx, `SELECT id,metadata::jsonb->'imageRepairSteps' FROM generation WHERE status IN ('completed','failed') AND metadata::jsonb ? 'imageRepairSteps' LIMIT 100`)
	if err != nil {
		return err
	}
	type cleanup struct {
		id    string
		steps map[string]imageRepairReceipt
	}
	pending := []cleanup{}
	for rows.Next() {
		var id string
		var raw []byte
		if err = rows.Scan(&id, &raw); err != nil {
			rows.Close()
			return err
		}
		var steps map[string]imageRepairReceipt
		if json.Unmarshal(raw, &steps) != nil {
			rows.Close()
			return errors.New("invalid repair cleanup metadata")
		}
		pending = append(pending, cleanup{id, steps})
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, record := range pending {
		complete := true
		for _, step := range record.steps {
			if step.InputStorageKey != "" {
				if err = b.deleteStorageObject(ctx, step.StorageBucket, step.InputStorageKey); err != nil {
					complete = false
				}
			}
			if step.StorageKey != "" {
				if err = b.deleteStorageObject(ctx, step.StorageBucket, step.StorageKey); err != nil {
					complete = false
				}
			}
		}
		if complete {
			if _, err = b.db.Exec(ctx, `UPDATE generation SET metadata=(metadata::jsonb-'imageRepairSteps')::json WHERE id=$1 AND status IN ('completed','failed')`, record.id); err != nil {
				return err
			}
		}
	}
	return nil
}
