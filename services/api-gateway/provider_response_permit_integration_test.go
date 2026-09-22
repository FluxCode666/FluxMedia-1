//go:build integration

package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestImageResponsePermitWorkerWaitsBeforeSubmissionAndNeverResubmitsAfterSend(t *testing.T) {
	for _, failureStage := range []string{"admission", "response"} {
		t.Run(failureStage, func(t *testing.T) {
			b := integrationBackend(t)
			ctx := context.Background()
			userID, _ := seedAuthUser(t, b)
			var unavailable atomic.Bool
			unavailable.Store(true)
			var posts atomic.Int32
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodPost {
					posts.Add(1)
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{"status":"processing","taskId":"accepted"}`)
			}))
			defer provider.Close()
			runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.Method + " " + r.URL.Path {
				case "POST /v1/response-permits":
					if failureStage == "admission" && unavailable.Load() {
						w.Header().Set("Retry-After", "7")
						w.WriteHeader(http.StatusServiceUnavailable)
						return
					}
					_, _ = io.WriteString(w, `{"data":{"id":"66b3b4f7-bff2-4b2e-9f03-5b5512b077a5"}}`)
				case "DELETE /v1/response-permits/66b3b4f7-bff2-4b2e-9f03-5b5512b077a5":
					w.WriteHeader(http.StatusNoContent)
				case "POST /v1/execute":
					if failureStage == "response" && unavailable.Load() {
						w.WriteHeader(http.StatusServiceUnavailable)
						return
					}
					_, _ = io.WriteString(w, `{"data":{"output":{"status":"processing","taskId":"accepted"}}}`)
				default:
					w.WriteHeader(http.StatusNotFound)
				}
			}))
			defer runtime.Close()
			b.config.scriptRuntimeURL = runtime.URL
			configureModerationIntegration(t, b, provider.URL)
			setStorageTestSetting(t, b, "CONTENT_MODERATION_ENABLED", false)
			model := seedModerationProvider(t, b, provider.URL, true)
			var versionID string
			var raw []byte
			if err := b.db.QueryRow(ctx, `SELECT v.id,v.configuration FROM image_backend_member m JOIN image_backend_member_api_config c ON c.member_id=m.id JOIN image_backend_member_api_adapter_version v ON v.id=c.current_adapter_version_id WHERE m.supported_model_ids::jsonb @> jsonb_build_array($1::text)`, model).Scan(&versionID, &raw); err != nil {
				t.Fatal(err)
			}
			var adapter map[string]any
			_ = json.Unmarshal(raw, &adapter)
			ops := adapter["operations"].(map[string]any)
			ops["images.generate"].(map[string]any)["responseScript"] = "return input.body;"
			ops["images.generate.query"] = map[string]any{"path": "/query/{task_id}"}
			if _, err := b.db.Exec(ctx, `UPDATE image_backend_member_api_adapter_version SET configuration=$2 WHERE id=$1`, versionID, mustJSON(adapter)); err != nil {
				t.Fatal(err)
			}
			taskID, generationID := seedModerationImageTask(t, b, userID, model, nil)
			body := map[string]any{"model": model, "prompt": "prompt", "operation": "generate", "generationId": generationID}
			if _, err := b.db.Exec(ctx, `UPDATE image_async_task SET operation='generate',generation_input=$2,generation_inputs=$3 WHERE id=$1`, taskID, mustJSON(body), mustJSON([]any{body})); err != nil {
				t.Fatal(err)
			}
			worker := &mediaWorker{backend: b}
			if err := worker.processImage(ctx, taskID); err != nil {
				t.Fatal(err)
			}
			var generationStatus, taskStatus, stage string
			var settled bool
			if err := b.db.QueryRow(ctx, `SELECT g.status,t.status,COALESCE(g.metadata->'apiImage'->>'stage',''),COALESCE(g.metadata::jsonb ? 'billingSettlement',false) FROM generation g JOIN image_async_task t ON t.generation_id=g.id WHERE g.id=$1`, generationID).Scan(&generationStatus, &taskStatus, &stage, &settled); err != nil {
				t.Fatal(err)
			}
			if failureStage == "admission" {
				var due time.Time
				if err := b.db.QueryRow(ctx, `SELECT mq_delivery_due_at FROM image_async_task WHERE id=$1`, taskID).Scan(&due); err != nil {
					t.Fatal(err)
				}
				if generationStatus != "pending" || taskStatus != "running" || stage != "" || settled || posts.Load() != 0 || time.Until(due) < 5*time.Second {
					t.Fatalf("capacity wait became a failed/uncertain submission: generation=%s task=%s stage=%q settled=%v posts=%d due=%s", generationStatus, taskStatus, stage, settled, posts.Load(), due)
				}
			} else if generationStatus != "failed" || taskStatus != "failed" || stage != "submitting" || posts.Load() != 1 {
				t.Fatalf("post-send failure was not fenced: generation=%s task=%s stage=%q posts=%d", generationStatus, taskStatus, stage, posts.Load())
			}
			unavailable.Store(false)
			for range 2 {
				if err := worker.processImage(ctx, taskID); err != nil {
					t.Fatal(err)
				}
			}
			if posts.Load() != 1 {
				t.Fatalf("recovery submitted %d times", posts.Load())
			}
			if failureStage == "admission" {
				if err := b.db.QueryRow(ctx, `SELECT status,metadata->'apiImage'->>'stage' FROM generation WHERE id=$1`, generationID).Scan(&generationStatus, &stage); err != nil {
					t.Fatal(err)
				}
				if generationStatus != "pending" || stage != "polling" {
					t.Fatalf("capacity recovery did not resume accepted task: %s %s", generationStatus, stage)
				}
			}
		})
	}
}
