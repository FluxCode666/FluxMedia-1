//go:build integration

package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestImageProviderFailureCategoryPreservesHealthAndSLA(t *testing.T) {
	for _, category := range []string{"invalid_request", "moderation", "capacity", "upstream", "untrusted-secret-category"} {
		t.Run(category, func(t *testing.T) {
			b := integrationBackend(t)
			ctx := context.Background()
			userID, _ := seedAuthUser(t, b)
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_ = json.NewEncoder(w).Encode(map[string]any{"status": "failed", "error": map[string]any{"category": category, "code": "private-secret-code", "adminDetails": "private-secret-details"}})
			}))
			defer provider.Close()
			configureModerationIntegration(t, b, provider.URL)
			setStorageTestSetting(t, b, "CONTENT_MODERATION_ENABLED", false)
			model := seedModerationProvider(t, b, provider.URL, true)
			var memberID string
			if err := b.db.QueryRow(ctx, `UPDATE image_backend_member SET failure_cooldown_enabled=true WHERE supported_model_ids::jsonb @> jsonb_build_array($1::text) RETURNING id`, model).Scan(&memberID); err != nil {
				t.Fatal(err)
			}
			taskID, generationID := seedModerationImageTask(t, b, userID, model, nil)
			body := map[string]any{"model": model, "prompt": "prompt", "operation": "generate", "generationId": generationID}
			if _, err := b.db.Exec(ctx, `UPDATE image_async_task SET operation='generate',generation_input=$2,generation_inputs=$3 WHERE id=$1`, taskID, mustJSON(body), mustJSON([]any{body})); err != nil {
				t.Fatal(err)
			}
			worker := &mediaWorker{backend: b}
			for range 2 {
				if err := worker.processImage(ctx, taskID); err != nil {
					t.Fatal(err)
				}
			}
			var failures, streak int
			var health, status, message, generationStatus string
			var cooling bool
			if err := b.db.QueryRow(ctx, `SELECT fail_count,fail_streak,health_status,status,cooldown_until IS NOT NULL FROM image_backend_member WHERE id=$1`, memberID).Scan(&failures, &streak, &health, &status, &cooling); err != nil {
				t.Fatal(err)
			}
			if err := b.db.QueryRow(ctx, `SELECT status,error FROM generation WHERE id=$1`, generationID).Scan(&generationStatus, &message); err != nil {
				t.Fatal(err)
			}
			if generationStatus != "failed" || strings.Contains(message, "secret") {
				t.Fatalf("provider failure lost or private details leaked: %s %s", generationStatus, message)
			}
			wantCategory := "platform"
			if category == "invalid_request" || category == "moderation" {
				wantCategory = "moderation"
				if category == "invalid_request" {
					wantCategory = "user_request"
				}
				if failures != 0 || streak != 0 || health != "healthy" || status != "active" || cooling {
					t.Fatalf("input rejection penalized provider: failures=%d streak=%d health=%s status=%s cooling=%v", failures, streak, health, status, cooling)
				}
			} else if failures != 1 || streak != 1 || health != "degraded" || status != "limited" || !cooling {
				t.Fatalf("provider failure was not counted once: failures=%d streak=%d health=%s status=%s cooling=%v", failures, streak, health, status, cooling)
			}
			if got := classifyGenerationError(&message); got != wantCategory {
				t.Fatalf("SLA attribution=%s, want %s", got, wantCategory)
			}
		})
	}
}
