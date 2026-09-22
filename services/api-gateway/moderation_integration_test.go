//go:build integration

package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func configureModerationIntegration(t *testing.T, b *backend, endpoint string) {
	t.Helper()
	t.Setenv("OPENAI_BASE_URL", endpoint+"/v1")
	b.config.storagePath = t.TempDir()
	for key, value := range map[string]any{
		"CONTENT_MODERATION_ENABLED": true, "CONTENT_MODERATION_FAIL_CLOSED": true,
		"CONTENT_MODERATION_PROVIDER": "openai", "CONTENT_MODERATION_PROXY_URL": "",
		"CONTENT_MODERATION_PROXY_SECRET": "test-proxy-secret", "CONTENT_MODERATION_PROXY_GATEWAY_SECRET": "",
		"OPENAI_MODERATION_API_KEY": "test-openai-secret", "OPENAI_MODERATION_MODEL": "omni-moderation-latest",
		"CONTENT_MODERATION_BLOCK_RISK_LEVEL": "high", "STORAGE_ENDPOINT": "",
		"STORAGE_SYSTEM_BUCKET": "system", "STORAGE_GENERATIONS_BUCKET": "generations",
	} {
		setStorageTestSetting(t, b, key, value)
	}
}

func seedModerationProvider(t *testing.T, b *backend, endpoint string, safety bool) string {
	t.Helper()
	ctx := context.Background()
	memberID, versionID, model := newRequestID(), newRequestID(), "moderation-"+newRequestID()
	var previousDefaults []string
	var previousRaw []byte
	if err := b.db.QueryRow(ctx, `SELECT COALESCE(json_agg(id),'[]'::json) FROM image_backend_group WHERE is_default`).Scan(&previousRaw); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(previousRaw, &previousDefaults); err != nil {
		t.Fatal(err)
	}
	if _, err := b.db.Exec(ctx, `UPDATE image_backend_group SET is_default=false WHERE is_default`); err != nil {
		t.Fatal(err)
	}
	groupID := newRequestID()
	var groupSafety any
	if !safety {
		groupSafety = false
	}
	if _, err := b.db.Exec(ctx, `INSERT INTO image_backend_group(id,name,is_default,is_enabled,content_safety_enabled) VALUES($1,'Moderation test',true,true,$2)`, groupID, groupSafety); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = b.db.Exec(ctx, `DELETE FROM image_backend_group WHERE id=$1`, groupID)
		_, _ = b.db.Exec(ctx, `UPDATE image_backend_group SET is_default=true WHERE id=ANY($1::text[])`, previousDefaults)
	})
	if _, err := b.db.Exec(ctx, `INSERT INTO image_backend_member(id,type,name,supported_model_ids,content_safety_enabled,is_enabled) VALUES($1,'api','Moderation test',$2,true,true)`, memberID, mustJSON([]string{model})); err != nil {
		t.Fatal(err)
	}
	if _, err := b.db.Exec(ctx, `INSERT INTO image_backend_member_group(id,member_id,group_id) VALUES($1,$2,$3)`, newRequestID(), memberID, groupID); err != nil {
		t.Fatal(err)
	}
	configuration := map[string]any{"baseUrl": endpoint, "videoSubmissionRetryCount": 0, "operations": map[string]any{"images.generate": map[string]any{"path": "/generate"}, "images.edit": map[string]any{"path": "/generate"}, "videos.generate": map[string]any{"path": "/video"}, "videos.query": map[string]any{"path": "/poll"}}}
	if _, err := b.db.Exec(ctx, `INSERT INTO image_backend_member_api_adapter_version(id,member_id_snapshot,revision,credential_scope,configuration) VALUES($1,$2,1,'test',$3)`, versionID, memberID, mustJSON(configuration)); err != nil {
		t.Fatal(err)
	}
	if _, err := b.db.Exec(ctx, `INSERT INTO image_backend_member_api_config(member_id,api_key,current_adapter_version_id,credential_scope) VALUES($1,'test',$2,'test')`, memberID, versionID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = b.db.Exec(ctx, `DELETE FROM generation WHERE api_adapter_member_id=$1`, memberID)
		_, _ = b.db.Exec(ctx, `DELETE FROM image_backend_member WHERE id=$1`, memberID)
		_, _ = b.db.Exec(ctx, `DELETE FROM image_backend_member_api_adapter_version WHERE member_id_snapshot=$1`, memberID)
	})
	return model
}

func seedModerationImageTask(t *testing.T, b *backend, userID, model string, images []any) (string, string) {
	t.Helper()
	ctx := context.Background()
	taskID, generationID := newRequestID(), newRequestID()
	body := map[string]any{"model": model, "prompt": "a landscape", "images": images, "effectiveBlockRiskLevel": "low", "generationId": generationID, "operation": "edit"}
	if _, err := b.db.Exec(ctx, `INSERT INTO generation(id,user_id,prompt,model,status) VALUES($1,$2,'a landscape',$3,'pending')`, generationID, userID, model); err != nil {
		t.Fatal(err)
	}
	if _, err := b.db.Exec(ctx, `INSERT INTO image_async_task(id,user_id,api_key_id,plan,operation,generation_inputs,generation_input,input_digest,generation_ids,generation_id,response_format,status) VALUES($1,$2,'site','free','edit',$3,$6,'md5:00000000000000000000000000000000',$4,$5,'url','running')`, taskID, userID, mustJSON([]any{body}), mustJSON([]string{generationID}), generationID, mustJSON(body)); err != nil {
		t.Fatal(err)
	}
	return taskID, generationID
}

func TestModerationImageWorkerUsesStoredImagesAndStopsBlockedOrFailedRequests(t *testing.T) {
	for _, scenario := range []string{"allow", "block", "provider failure", "fail open", "channel disabled"} {
		t.Run(scenario, func(t *testing.T) {
			b := integrationBackend(t)
			userID, _ := seedAuthUser(t, b)
			var moderationCalls, upstreamCalls atomic.Int32
			imageBytes := []byte("moderation-test-image-bytes")
			var endpoint string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/v1/moderations":
					moderationCalls.Add(1)
					var payload struct {
						Input []map[string]any `json:"input"`
					}
					if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
						t.Error(err)
					}
					if len(payload.Input) != 2 || payload.Input[0]["text"] != "a landscape" {
						t.Errorf("moderation missing prompt or image: %+v", payload)
					} else {
						imageURL, _ := payload.Input[1]["image_url"].(map[string]any)
						if imageURL["url"] != "data:image/png;base64,"+base64.StdEncoding.EncodeToString(imageBytes) {
							t.Error("stored image bytes omitted from moderation")
						}
					}
					if scenario == "provider failure" || scenario == "fail open" {
						w.WriteHeader(503)
						return
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"results": []any{map[string]any{"flagged": scenario == "block"}}})
				case "/generate":
					upstreamCalls.Add(1)
					_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]string{"url": endpoint + "/output"}}})
				case "/output":
					w.Header().Set("Content-Type", "image/png")
					_, _ = w.Write(imageBytes)
				default:
					w.WriteHeader(404)
				}
			}))
			defer server.Close()
			endpoint = server.URL
			configureModerationIntegration(t, b, endpoint)
			if scenario == "fail open" {
				setStorageTestSetting(t, b, "CONTENT_MODERATION_FAIL_CLOSED", false)
			}
			model := seedModerationProvider(t, b, endpoint, scenario != "channel disabled")
			key := "uploads/" + userID + "/input.png"
			file := filepath.Join(b.config.storagePath, "generations", filepath.FromSlash(key))
			if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(file, imageBytes, 0600); err != nil {
				t.Fatal(err)
			}
			taskID, generationID := seedModerationImageTask(t, b, userID, model, []any{map[string]any{"source": "storage", "storageKey": key, "storageBucket": "generations", "mimeType": "image/png"}})
			worker := mediaWorker{backend: b}
			if err := worker.processImage(context.Background(), taskID); err != nil {
				t.Fatal(err)
			}
			var taskStatus, generationStatus string
			var metadata []byte
			if err := b.db.QueryRow(context.Background(), `SELECT t.status,g.status,COALESCE(g.metadata,'{}'::json) FROM image_async_task t JOIN generation g ON g.id=t.generation_id WHERE t.id=$1`, taskID).Scan(&taskStatus, &generationStatus, &metadata); err != nil {
				t.Fatal(err)
			}
			wantStatus, wantUpstream := "completed", int32(1)
			if scenario == "block" || scenario == "provider failure" {
				wantStatus, wantUpstream = "failed", 0
			}
			if taskStatus != wantStatus || generationStatus != wantStatus || upstreamCalls.Load() != wantUpstream {
				t.Fatalf("status task=%s generation=%s upstream=%d; wanted %s/%d", taskStatus, generationStatus, upstreamCalls.Load(), wantStatus, wantUpstream)
			}
			wantModeration := int32(1)
			if scenario == "channel disabled" {
				wantModeration = 0
			}
			if moderationCalls.Load() != wantModeration {
				t.Fatal("channel moderation switch ignored")
			}
			var meta map[string]any
			_ = json.Unmarshal(metadata, &meta)
			if scenario == "channel disabled" {
				if _, exists := meta["moderation"]; exists {
					t.Fatal("skipped moderation recorded as completed")
				}
			} else {
				result, _ := meta["moderation"].(map[string]any)
				completed := scenario == "allow" || scenario == "block"
				if result["completed"] != completed {
					t.Fatalf("incorrect completion evidence: %v", result)
				}
			}
			// A terminal task redelivery must not invoke moderation or upstream again.
			if err := worker.processImage(context.Background(), taskID); err != nil {
				t.Fatal(err)
			}
			if upstreamCalls.Load() != wantUpstream || moderationCalls.Load() != wantModeration {
				t.Fatal("terminal task repeated outbound work")
			}
			_ = generationID
		})
	}
}

func TestModerationGenerationUsesTrustedPolicyAndSignsStorageReferences(t *testing.T) {
	b := integrationBackend(t)
	userID, _ := seedAuthUser(t, b)
	if _, err := b.db.Exec(context.Background(), `UPDATE "user" SET moderation_block_risk_level_override='medium' WHERE id=$1`, userID); err != nil {
		t.Fatal(err)
	}
	var seen moderationInput
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&seen); err != nil {
			t.Error(err)
		}
		_, _ = io.WriteString(w, `{"decision":"allow","provider":"aliyun"}`)
	}))
	defer server.Close()
	configureModerationIntegration(t, b, server.URL)
	setStorageTestSetting(t, b, "CONTENT_MODERATION_PROXY_URL", server.URL)
	setStorageTestSetting(t, b, "CONTENT_MODERATION_PROVIDER", "none")
	b.config.publicAppURL = "https://media.example.test"
	_, generationID := seedModerationImageTask(t, b, userID, "test", nil)
	key := "uploads/" + userID + "/input.png"
	body := map[string]any{"prompt": "safe prompt", "effectiveBlockRiskLevel": "low", "firstFrame": map[string]any{"source": "storage", "storageBucket": "generations", "storageKey": key, "mimeType": "image/png"}, "referenceImages": []any{map[string]any{"url": "https://cdn.example.test/ref.png", "mimeType": "image/png"}}}
	if err := b.moderateGeneration(context.Background(), userID, generationID, "image_generation", body); err != nil {
		t.Fatal(err)
	}
	if seen.EffectiveBlockRiskLevel != "medium" || seen.UserID != userID || len(seen.Images) != 2 || seen.Mode != "image" {
		t.Fatalf("untrusted policy or missing refs: %+v", seen)
	}
	u, err := url.Parse(seen.Images[1].URL)
	if err != nil || u.Host != "media.example.test" || !strings.HasSuffix(u.Path, key) || u.Query().Get("sig") == "" {
		t.Fatal("stored reference lacks public signed URL")
	}
	r := httptest.NewRequest(http.MethodGet, seen.Images[1].URL, nil)
	if err := b.verifyStorageSignature(r, "generations", key); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"../secret", "uploads/other-user/input.png"} {
		if _, err := b.generationModerationImage(context.Background(), userID, map[string]any{"storageBucket": "generations", "storageKey": bad}, moderationRuntime{}); err == nil {
			t.Fatalf("unauthorized storage reference accepted: %s", bad)
		}
	}
}

func TestModerationProxyRouteRequiresSecretAndExecutesLocalProvider(t *testing.T) {
	b := integrationBackend(t)
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = io.WriteString(w, `{"results":[{"flagged":true}]}`)
	}))
	defer server.Close()
	configureModerationIntegration(t, b, server.URL)
	for _, secret := range []string{"", "wrong", "test-proxy-secret"} {
		r := httptest.NewRequest(http.MethodPost, "http://localhost:3000/moderate", strings.NewReader(`{"prompt":"test","effectiveBlockRiskLevel":"high"}`))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Moderation-Proxy-Secret", secret)
		w := httptest.NewRecorder()
		b.handler().ServeHTTP(w, r)
		if secret != "test-proxy-secret" {
			if w.Code != 401 {
				t.Fatalf("unauthorized response=%d %s", w.Code, w.Body.String())
			}
		} else if w.Code != 200 || !strings.Contains(w.Body.String(), `"decision":"block"`) {
			t.Fatalf("provider not executed: %d %s", w.Code, w.Body.String())
		}
	}
	if calls.Load() != 1 {
		t.Fatal("unauthorized request contacted provider")
	}
}
