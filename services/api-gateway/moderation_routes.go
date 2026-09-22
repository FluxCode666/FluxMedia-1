package main

import (
	"context"
	"net/http"
)

func (b *backend) registerModerationRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/moderation/providers", b.endpoint(b.handleModerationProviders))
	mux.HandleFunc("GET /api/moderation/enabled", b.endpoint(b.handleModerationEnabled))
	mux.HandleFunc("POST /api/moderation/check", b.endpoint(b.handleModerationCheck))
}
func (b *backend) handleModerationEnabled(w http.ResponseWriter, r *http.Request) error {
	enabled, err := b.settingBool(r.Context(), "CONTENT_MODERATION_ENABLED", true)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"enabled": enabled})
	return nil
}
func (b *backend) handleModerationProviders(w http.ResponseWriter, r *http.Request) error {
	if !b.cronAuthorized(r) {
		if _, err := b.requireAdmin(r, true); err != nil {
			return err
		}
	}
	cfg, err := b.moderationRuntime(r.Context())
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"providers": cfg.providers()})
	return nil
}
func (b *backend) handleModerationCheck(w http.ResponseWriter, r *http.Request) error {
	if !b.cronAuthorized(r) {
		return &apiError{http.StatusUnauthorized, "UNAUTHORIZED", "Unauthorized"}
	}
	in, err := decodeModerationRequest(r, true)
	if err != nil {
		return err
	}
	result, err := b.moderateContent(r.Context(), in)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, result)
	return nil
}

func decodeModerationRequest(r *http.Request, allowSkipProxy bool) (moderationInput, error) {
	var wire struct {
		moderationInput
		Prompt    *string `json:"prompt"`
		SkipProxy *bool   `json:"skipProxy"`
	}
	if err := decodeBody(r, &wire); err != nil {
		return moderationInput{}, err
	}
	if wire.Prompt == nil {
		return moderationInput{}, invalid("prompt is required")
	}
	if !allowSkipProxy && wire.SkipProxy != nil {
		return moderationInput{}, invalid("skipProxy is not accepted by the moderation proxy")
	}
	input := wire.moderationInput
	input.Prompt = *wire.Prompt
	if wire.SkipProxy != nil {
		input.SkipProxy = *wire.SkipProxy
	}
	return input, nil
}
func (b *backend) moderateContent(ctx context.Context, in moderationInput) (moderationResult, error) {
	cfg, err := b.moderationRuntime(ctx)
	if err != nil {
		return moderationResult{}, err
	}
	result, err := cfg.moderate(ctx, in)
	if err == nil && lenResultFailures(result) > 0 && b.logger != nil {
		b.logger.WarnContext(ctx, "moderation provider failure", "decision", result.Decision, "generation_id", in.GenerationID)
	}
	return result, err
}
func lenResultFailures(result moderationResult) int {
	if failures, ok := result.Details.([]map[string]string); ok {
		return len(failures)
	}
	// Proxy JSON decodes the same fail-open details into generic maps.
	if failures, ok := result.Details.([]any); ok {
		count := 0
		for _, failure := range failures {
			if item, ok := failure.(map[string]any); ok {
				if _, ok := item["error"].(string); ok {
					count++
				}
			}
		}
		return count
	}
	return 0
}
