//go:build integration

package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestImageProviderAcceptedTaskResumesOriginalVersionWithoutResubmission(t *testing.T) {
	b := integrationBackend(t)
	ctx := context.Background()
	userID, _ := seedAuthUser(t, b)
	var submissions, polls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			submissions.Add(1)
			w.Header().Set("Retry-After", "12")
			_, _ = io.WriteString(w, `{"status":"processing","taskId":"accepted/id 1","poll_url":"https://must-not-be-used.example/task"}`)
			return
		}
		if r.URL.EscapedPath() != "/original/accepted%2Fid%201" || r.Header.Get("Authorization") != "Bearer rotated-key" {
			t.Errorf("accepted task changed adapter/credentials: %s", r.URL)
		}
		if polls.Add(1) == 1 {
			_, _ = io.WriteString(w, `{"status":"processing"}`)
		} else {
			_, _ = io.WriteString(w, `{"data":[{"b64_json":"b3V0cHV0"}]}`)
		}
	}))
	defer server.Close()
	configureModerationIntegration(t, b, server.URL)
	setStorageTestSetting(t, b, "CONTENT_MODERATION_ENABLED", false)
	model := seedModerationProvider(t, b, server.URL, true)
	var memberID, versionID string
	var raw []byte
	if err := b.db.QueryRow(ctx, `SELECT m.id,v.id,v.configuration FROM image_backend_member m JOIN image_backend_member_api_config c ON c.member_id=m.id JOIN image_backend_member_api_adapter_version v ON v.id=c.current_adapter_version_id WHERE m.supported_model_ids::jsonb @> jsonb_build_array($1::text)`, model).Scan(&memberID, &versionID, &raw); err != nil {
		t.Fatal(err)
	}
	var adapter map[string]any
	_ = json.Unmarshal(raw, &adapter)
	adapter["operations"].(map[string]any)["images.generate.query"] = map[string]any{"path": "/original/{task_id}"}
	if _, err := b.db.Exec(ctx, `UPDATE image_backend_member_api_adapter_version SET configuration=$2 WHERE id=$1`, versionID, mustJSON(adapter)); err != nil {
		t.Fatal(err)
	}
	taskID, generationID := seedModerationImageTask(t, b, userID, model, nil)
	body := map[string]any{"model": model, "prompt": "prompt", "generationId": generationID, "operation": "generate"}
	if _, err := b.db.Exec(ctx, `UPDATE image_async_task SET operation='generate',generation_input=$2,generation_inputs=$3 WHERE id=$1`, taskID, mustJSON(body), mustJSON([]any{body})); err != nil {
		t.Fatal(err)
	}
	first := mediaWorker{backend: b}
	if err := first.processImage(ctx, taskID); err != nil {
		t.Fatal(err)
	}
	var state imageProviderState
	var due time.Time
	var status string
	if err := b.db.QueryRow(ctx, `SELECT g.metadata->'apiImage',t.mq_delivery_due_at,t.status FROM generation g JOIN image_async_task t ON t.generation_id=g.id WHERE g.id=$1`, generationID).Scan(&raw, &due, &status); err != nil {
		t.Fatal(err)
	}
	_ = json.Unmarshal(raw, &state)
	if state.Stage != "polling" || state.TaskID != "accepted/id 1" || status != "running" || time.Until(due) < 10*time.Second {
		t.Fatalf("accepted state/due not persisted: %+v %s %s", state, status, due)
	}
	// Reconfiguration and group removal cannot redirect accepted work. Only the
	// original version with a same-scope rotated credential may query that task.
	newVersion := newRequestID()
	adapter["baseUrl"] = "https://must-not-be-called.example"
	if _, err := b.db.Exec(ctx, `INSERT INTO image_backend_member_api_adapter_version(id,member_id_snapshot,revision,credential_scope,configuration) VALUES($1,$2,2,'test',$3)`, newVersion, memberID, mustJSON(adapter)); err != nil {
		t.Fatal(err)
	}
	if _, err := b.db.Exec(ctx, `UPDATE image_backend_member_api_config SET current_adapter_version_id=$2,api_key='rotated-key' WHERE member_id=$1`, memberID, newVersion); err != nil {
		t.Fatal(err)
	}
	if _, err := b.db.Exec(ctx, `UPDATE image_backend_member SET is_enabled=false WHERE id=$1`, memberID); err != nil {
		t.Fatal(err)
	}
	if _, err := b.db.Exec(ctx, `DELETE FROM image_backend_member_group WHERE member_id=$1`, memberID); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		resumed := mediaWorker{backend: b}
		if err := resumed.processImage(ctx, taskID); err != nil {
			t.Fatal(err)
		}
	}
	if err := b.db.QueryRow(ctx, `SELECT status FROM generation WHERE id=$1`, generationID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "completed" || submissions.Load() != 1 || polls.Load() != 2 {
		t.Fatalf("wrong recovery: %s posts=%d polls=%d", status, submissions.Load(), polls.Load())
	}
	if err := first.processImage(ctx, taskID); err != nil {
		t.Fatal(err)
	}
	if submissions.Load() != 1 || polls.Load() != 2 {
		t.Fatal("terminal redelivery repeated provider request")
	}
}

func TestImageProviderUncertainSubmissionNeverPostsAgain(t *testing.T) {
	b := integrationBackend(t)
	ctx := context.Background()
	userID, _ := seedAuthUser(t, b)
	var posts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { posts.Add(1) }))
	defer server.Close()
	configureModerationIntegration(t, b, server.URL)
	setStorageTestSetting(t, b, "CONTENT_MODERATION_ENABLED", false)
	model := seedModerationProvider(t, b, server.URL, true)
	taskID, generationID := seedModerationImageTask(t, b, userID, model, nil)
	state := imageProviderState{Stage: "submitting", Operation: "images.generate", StartedAt: time.Now().Add(-time.Minute)}
	if _, err := b.db.Exec(ctx, `UPDATE generation SET metadata=$2 WHERE id=$1`, generationID, mustJSON(map[string]any{"apiImage": state})); err != nil {
		t.Fatal(err)
	}
	worker := mediaWorker{backend: b}
	if err := worker.processImage(ctx, taskID); err != nil {
		t.Fatal(err)
	}
	var status, reason string
	if err := b.db.QueryRow(ctx, `SELECT status,error FROM generation WHERE id=$1`, generationID).Scan(&status, &reason); err != nil {
		t.Fatal(err)
	}
	if status != "failed" || posts.Load() != 0 || !strings.Contains(reason, "refusing to submit") {
		t.Fatalf("uncertain submission retried: %s %d %s", status, posts.Load(), reason)
	}
}

func TestImageProviderPollingSeparatesTemporaryFailuresFromBadAdapters(t *testing.T) {
	for _, failure := range []string{"upstream unavailable", "runtime unavailable"} {
		t.Run(failure, func(t *testing.T) {
			b := integrationBackend(t)
			ctx := context.Background()
			userID, _ := seedAuthUser(t, b)
			var submissions atomic.Int32
			var unavailable atomic.Bool
			unavailable.Store(true)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodPost {
					submissions.Add(1)
					_, _ = io.WriteString(w, `{"status":"processing","taskId":"accepted"}`)
					return
				}
				if unavailable.Load() {
					w.Header().Set("Retry-After", "13")
					w.WriteHeader(http.StatusServiceUnavailable)
					return
				}
				_, _ = io.WriteString(w, "invalid JSON")
			}))
			defer server.Close()
			configureModerationIntegration(t, b, server.URL)
			setStorageTestSetting(t, b, "CONTENT_MODERATION_ENABLED", false)
			model := seedModerationProvider(t, b, server.URL, true)
			queryConfig := map[string]any{"path": "/jobs/{task_id}"}
			if failure == "runtime unavailable" {
				runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if unavailable.Load() {
						w.Header().Set("Retry-After", "13")
						w.WriteHeader(http.StatusServiceUnavailable)
						return
					}
					_, _ = io.WriteString(w, `{"data":{"output":{}}}`)
				}))
				defer runtime.Close()
				b.config.scriptRuntimeURL = runtime.URL
				queryConfig["requestScript"] = "return {};"
			}
			if _, err := b.db.Exec(ctx, `UPDATE image_backend_member_api_adapter_version v SET configuration=jsonb_set(v.configuration::jsonb,'{operations,images.generate.query}',$2::jsonb)::json FROM image_backend_member m WHERE v.member_id_snapshot=m.id AND m.supported_model_ids::jsonb @> jsonb_build_array($1::text)`, model, mustJSON(queryConfig)); err != nil {
				t.Fatal(err)
			}
			taskID, generationID := seedModerationImageTask(t, b, userID, model, nil)
			body := map[string]any{"model": model, "prompt": "prompt", "generationId": generationID, "operation": "generate"}
			if _, err := b.db.Exec(ctx, `UPDATE image_async_task SET operation='generate',generation_input=$2,generation_inputs=$3 WHERE id=$1`, taskID, mustJSON(body), mustJSON([]any{body})); err != nil {
				t.Fatal(err)
			}
			worker := mediaWorker{backend: b}
			if err := worker.processImage(ctx, taskID); err != nil {
				t.Fatal(err)
			}
			for range 4 {
				if err := worker.processImage(ctx, taskID); err != nil {
					t.Fatal(err)
				}
				var raw []byte
				var status string
				var due time.Time
				if err := b.db.QueryRow(ctx, `SELECT g.status,g.metadata->'apiImage',t.mq_delivery_due_at FROM generation g JOIN image_async_task t ON t.generation_id=g.id WHERE g.id=$1`, generationID).Scan(&status, &raw, &due); err != nil {
					t.Fatal(err)
				}
				var state imageProviderState
				_ = json.Unmarshal(raw, &state)
				if status != "pending" || state.Failures != 0 || time.Until(due) < 11*time.Second {
					t.Fatalf("temporary failure consumed budget or ignored Retry-After: %s %+v due=%s", status, state, due)
				}
			}
			unavailable.Store(false)
			for attempt := 1; attempt <= 3; attempt++ {
				if err := worker.processImage(ctx, taskID); err != nil {
					t.Fatal(err)
				}
				var status string
				if err := b.db.QueryRow(ctx, `SELECT status FROM generation WHERE id=$1`, generationID).Scan(&status); err != nil {
					t.Fatal(err)
				}
				want := "pending"
				if attempt == 3 {
					want = "failed"
				}
				if status != want || submissions.Load() != 1 {
					t.Fatalf("bad adapter did not exhaust exactly three queries: attempt=%d status=%s posts=%d", attempt, status, submissions.Load())
				}
			}
		})
	}
}

func TestImageTransparentFallbackIsExplicitFencedAndNeverReplayed(t *testing.T) {
	b := integrationBackend(t)
	base := context.Background()
	userID, _ := seedAuthUser(t, b)
	var posts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if posts.Add(1) == 1 {
			if body["background"] != "transparent" {
				t.Error("initial request lost transparent background")
			}
			w.WriteHeader(400)
			_, _ = io.WriteString(w, `{"error":{"message":"Transparent background is not supported for this model"}}`)
			return
		}
		if body["background"] != nil {
			t.Error("opaque retry still requests transparency")
		}
		_, _ = io.WriteString(w, `{"data":[{"b64_json":"b3V0cHV0"}]}`)
	}))
	defer server.Close()
	configureModerationIntegration(t, b, server.URL)
	setStorageTestSetting(t, b, "CONTENT_MODERATION_ENABLED", false)
	model := seedModerationProvider(t, b, server.URL, true)
	taskID, generationID := seedModerationImageTask(t, b, userID, model, nil)
	token := newWorkerToken()
	ctx := context.WithValue(base, imageWorkerClaimKey{}, token)
	if _, err := b.db.Exec(ctx, `UPDATE image_async_task SET claim_token=$2,claim_expires_at=now()+interval '5 minutes' WHERE id=$1`, taskID, token); err != nil {
		t.Fatal(err)
	}
	body := map[string]any{"model": model, "prompt": "test", "background": "transparent", "transparentMatte": true}
	worker := mediaWorker{backend: b}
	output, pending, err := worker.executeImageProviderTask(ctx, taskID, generationID, userID, "generate", model, body)
	if err != nil || pending || !imageProviderHasOutput(output) || posts.Load() != 2 {
		t.Fatalf("explicit opaque fallback failed %v %v posts=%d", err, pending, posts.Load())
	}
	var matte bool
	var state string
	if err = b.db.QueryRow(ctx, `SELECT COALESCE((metadata->>'transparentMatteRequired')::boolean,false),metadata->'apiImage'->>'stage' FROM generation WHERE id=$1`, generationID).Scan(&matte, &state); err != nil {
		t.Fatal(err)
	}
	if !matte || state != "opaque_submitting" {
		t.Fatalf("fallback was not persisted %v %s", matte, state)
	}
	_, _, err = worker.executeImageProviderTask(ctx, taskID, generationID, userID, "generate", model, body)
	if err == nil || posts.Load() != 2 {
		t.Fatal("crash recovery submitted opaque request again")
	}
	for _, status := range []int{400, 500} {
		response := &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"error":{"message":"Transparent background is not supported for this model"}}`))}
		_, err = b.decodeImageProviderResponse(base, providerConfig{}, "images.generate", response, "", "model")
		if (err == errImageTransparentUnsupported) != (status == 400) {
			t.Fatalf("ambiguous response misclassified: %d %v", status, err)
		}
	}
}
