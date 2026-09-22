package main

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"path"
	"slices"
	"strings"
)

// The worker supplies the authenticated task owner. Client-supplied moderation
// policy fields never participate in resolving the effective block threshold.
func (b *backend) moderateGeneration(ctx context.Context, userID, generationID, operationType string, body map[string]any) error {
	cfg, err := b.moderationRuntime(ctx)
	if err != nil {
		return err
	}
	if !cfg.enabled || (len(cfg.providers()) == 0 && cfg.values["CONTENT_MODERATION_PROXY_URL"] == "") {
		return nil
	}
	var level string
	err = b.db.QueryRow(ctx, `SELECT CASE WHEN moderation_block_risk_level_override IN ('low','medium','high') THEN moderation_block_risk_level_override ELSE COALESCE((SELECT CASE WHEN value #>> '{}' IN ('low','medium','high') THEN value #>> '{}' ELSE 'high' END FROM system_setting WHERE key='CONTENT_MODERATION_BLOCK_RISK_LEVEL'),'high') END FROM "user" WHERE id=$1`, userID).Scan(&level)
	if err != nil {
		return err
	}
	in := moderationInput{Prompt: extractString(body, "prompt"), UserID: userID, GenerationID: generationID, EffectiveBlockRiskLevel: level, Mode: "text"}
	refs, err := generationModerationReferences(body)
	if err != nil {
		return err
	}
	for _, ref := range refs {
		image, err := b.generationModerationImage(ctx, userID, ref, cfg)
		if err != nil {
			return err
		}
		in.Images = append(in.Images, image)
	}
	if len(in.Images) > 0 {
		in.Mode = "image"
	}
	result, err := cfg.moderate(ctx, in)
	if err != nil {
		return err
	}
	if lenResultFailures(result) > 0 && b.logger != nil {
		b.logger.WarnContext(ctx, "generation moderation provider failure", "decision", result.Decision, "generation_id", generationID)
	}
	if result.Decision != "skipped" {
		table := "generation"
		if operationType == "video_generation" {
			table = "video_generation"
		}
		// Keep the audit outcome in the authoritative row before generation starts.
		// A fail-open outcome carries failures and is not a completed provider check.
		completed := (result.Decision == "allow" || result.Decision == "block") && lenResultFailures(result) == 0
		_, err = b.db.Exec(ctx, `UPDATE `+table+` SET metadata=(COALESCE(metadata,'{}'::json)::jsonb || $3::jsonb)::json WHERE id=$1 AND user_id=$2`, generationID, userID, mustJSON(map[string]any{"moderation": map[string]any{"decision": result.Decision, "completed": completed, "provider": result.Provider}}))
		if err != nil {
			return err
		}
	}
	switch result.Decision {
	case "block":
		return &apiError{http.StatusUnprocessableEntity, "CONTENT_MODERATION_BLOCKED", "Content failed moderation"}
	case "error":
		return &apiError{http.StatusServiceUnavailable, "CONTENT_MODERATION_UNAVAILABLE", "Content moderation is temporarily unavailable"}
	case "allow", "skipped":
		return nil
	default:
		return errors.New("content moderation returned an invalid decision")
	}
}

func generationModerationReferences(body map[string]any) ([]any, error) {
	refs := []any{}
	// These are the image fields accepted by image generation/edit and the video
	// input manifest. Audio/video references are not sent to image-only providers.
	for _, key := range []string{"images", "referenceImages"} {
		if value, exists := body[key]; exists && value != nil {
			switch values := value.(type) {
			case []any:
				refs = append(refs, values...)
			case []map[string]any:
				for _, ref := range values {
					refs = append(refs, ref)
				}
			default:
				return nil, invalid("Invalid moderation image references")
			}
		}
	}
	for _, key := range []string{"image", "image_url", "firstFrame", "lastFrame", "mask"} {
		if value, exists := body[key]; exists && value != nil {
			refs = append(refs, value)
		}
	}
	return refs, nil
}

func (b *backend) generationModerationImage(ctx context.Context, userID string, ref any, cfg moderationRuntime) (moderationImage, error) {
	image := moderationImage{}
	var storageKey, bucket string
	switch value := ref.(type) {
	case string:
		image.URL = value
	case map[string]any:
		image.URL = extractString(value, "url", "imageUrl", "image_url")
		image.Type = extractString(value, "mimeType", "type")
		image.Name = extractString(value, "name")
		image.Data = extractString(value, "base64", "data")
		storageKey = extractString(value, "storageKey")
		bucket = extractString(value, "storageBucket")
	default:
		return image, invalid("Invalid moderation image reference")
	}
	if strings.HasPrefix(image.URL, "data:") {
		header, data, ok := strings.Cut(image.URL, ",")
		if !ok || !strings.HasSuffix(header, ";base64") {
			return image, invalid("Invalid moderation image data URL")
		}
		image.Type = strings.TrimSuffix(strings.TrimPrefix(header, "data:"), ";base64")
		image.Data, image.URL = data, ""
	}
	if storageKey != "" || bucket != "" {
		if err := b.validateModerationStorageOwner(ctx, userID, bucket, storageKey); err != nil {
			return image, err
		}
		// Local providers can use bytes without exposing a local-only app URL.
		// Aliyun and an outbound proxy receive a short-lived signed storage URL.
		if slices.Contains(cfg.providers(), "openai") {
			data, err := b.readStorageObject(ctx, bucket, storageKey)
			if err != nil {
				return image, errors.New("content moderation image could not be read")
			}
			image.Data = base64.StdEncoding.EncodeToString(data)
			if image.Type == "" {
				image.Type = http.DetectContentType(data)
			}
		}
		if slices.Contains(cfg.providers(), "aliyun") || cfg.values["CONTENT_MODERATION_PROXY_URL"] != "" {
			signedURL, err := b.storageSignedReadURL(ctx, bucket, storageKey, 3600)
			if err != nil {
				return image, errors.New("content moderation image URL could not be signed")
			}
			if strings.HasPrefix(signedURL, "/") {
				base := b.config.publicAppURL
				if base == "" {
					base = b.config.authURL
				}
				signedURL = strings.TrimRight(base, "/") + signedURL
			}
			image.URL = signedURL
		}
	}
	if image.URL == "" && image.Data == "" {
		return image, invalid("Moderation image reference is empty")
	}
	if image.Type != "" && !strings.HasPrefix(image.Type, "image/") {
		return image, invalid("Moderation reference must be an image")
	}
	if err := validateModerationInput(moderationInput{EffectiveBlockRiskLevel: "high", Images: []moderationImage{image}}); err != nil {
		return image, err
	}
	return image, nil
}

func (b *backend) validateModerationStorageOwner(ctx context.Context, userID, bucket, key string) error {
	if bucket == "" || key == "" || strings.ContainsAny(bucket, "/\\") || bucket == "." || bucket == ".." || path.IsAbs(key) || path.Clean(key) != key || strings.Contains(key, "..") || strings.Contains(key, "\\") {
		return invalid("Invalid moderation storage reference")
	}
	// Input assets use one of these owner-scoped paths. Historic outputs use
	// their authoritative generation rows instead of trusting a client prefix.
	if userID != "" && (strings.HasPrefix(key, "uploads/"+userID+"/") || strings.HasPrefix(key, userID+"/")) {
		return nil
	}
	var owned bool
	if err := b.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM generation WHERE user_id=$1 AND storage_bucket=$2 AND storage_key=$3 UNION ALL SELECT 1 FROM video_generation WHERE user_id=$1 AND storage_bucket=$2 AND storage_key=$3)`, userID, bucket, key).Scan(&owned); err != nil {
		return err
	}
	if !owned {
		return &apiError{http.StatusForbidden, "FORBIDDEN", "Moderation image is not owned by the task user"}
	}
	return nil
}
