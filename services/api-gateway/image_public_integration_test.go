//go:build integration

package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func seedPublicImageKey(t *testing.T, b *backend, uid, group string) (string, string) {
	t.Helper()
	key, id := newRequestID(), newRequestID()
	hash := sha256.Sum256([]byte(key))
	if _, err := b.db.Exec(context.Background(), `INSERT INTO external_api_key(id,user_id,key_prefix,key_hash,last_four,generation_group_id) VALUES($1,$2,'test',$3,'last',$4)`, id, uid, hex.EncodeToString(hash[:]), group); err != nil {
		t.Fatal(err)
	}
	return key, id
}

func TestPublicImagesDeliveryPersistsAllOutputsAndIsKeyScoped(t *testing.T) {
	for _, mode := range []string{"json", "sse", "async"} {
		t.Run(mode, func(t *testing.T) {
			b := integrationBackend(t)
			ctx := context.Background()
			uid, _ := seedAuthUser(t, b)
			b.config.storagePath = t.TempDir()
			b.config.publicAppURL = "http://localhost:3000"
			setStorageTestSetting(t, b, "STORAGE_ENDPOINT", "")
			setStorageTestSetting(t, b, "GENERATIONS_BUCKET_NAME", "generations")
			setStorageTestSetting(t, b, "CONTENT_MODERATION_ENABLED", false)
			model := "public-" + newRequestID()
			seedImagePricingSettings(t, b, model)
			creditTestWallet(t, b, uid, 100)
			creditTestBatch(t, b, uid, "purchase", 100, nil)
			var posts atomic.Int32
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				posts.Add(1)
				_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]any{"b64_json": base64.StdEncoding.EncodeToString([]byte("first output")), "revised_prompt": "revised"}, map[string]any{"b64_json": base64.StdEncoding.EncodeToString([]byte("second output"))}}})
			}))
			defer provider.Close()
			group := seedImagePricingGroup(t, b, true, nil, nil)
			seedImagePricingMember(t, b, group, model, provider.URL, false, 1)
			key, keyID := seedPublicImageKey(t, b, uid, group)
			otherKey, _ := seedPublicImageKey(t, b, uid, group)
			body := map[string]any{"model": model, "prompt": "test"}
			if mode == "async" {
				body["async"] = true
				body["response_format"] = "url"
			}
			work, cancel := context.WithTimeout(ctx, 10*time.Second)
			defer cancel()
			done := make(chan error, 1)
			go func() {
				ticker := time.NewTicker(10 * time.Millisecond)
				defer ticker.Stop()
				for {
					var id string
					err := b.db.QueryRow(work, `SELECT id FROM image_async_task WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, uid).Scan(&id)
					if err == nil {
						worker := mediaWorker{backend: b}
						done <- worker.processImage(work, id)
						return
					}
					select {
					case <-work.Done():
						done <- work.Err()
						return
					case <-ticker.C:
					}
				}
			}()
			r := httptest.NewRequest("POST", "http://localhost:3000/v1/images/generations", strings.NewReader(mustJSON(body))).WithContext(work)
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Authorization", "Bearer "+key)
			if mode == "sse" {
				r.Header.Set("Accept", "text/event-stream")
			}
			w := httptest.NewRecorder()
			b.handler().ServeHTTP(w, r)
			if err := <-done; err != nil {
				t.Fatal(err)
			}
			if w.Code != 200 {
				t.Fatalf("delivery %d: %s", w.Code, w.Body.String())
			}
			var payload map[string]any
			if mode == "sse" {
				if !strings.Contains(w.Header().Get("Content-Type"), "text/event-stream") || !strings.Contains(w.Body.String(), "event: image_generation.completed") {
					t.Fatalf("missing stream: %s", w.Body.String())
				}
				for _, line := range strings.Split(w.Body.String(), "\n") {
					if strings.HasPrefix(line, "data: ") {
						if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &payload); err != nil {
							t.Fatal(err)
						}
					}
				}
			} else {
				if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
					t.Fatal(err)
				}
			}
			var id string
			if err := b.db.QueryRow(ctx, `SELECT id FROM image_async_task WHERE user_id=$1`, uid).Scan(&id); err != nil {
				t.Fatal(err)
			}
			if mode == "async" {
				payload, _ = b.publicImageTask(ctx, &apiPrincipal{UserID: uid, KeyID: keyID}, id)
			}
			data, ok := payload["data"].([]any)
			if !ok || len(data) != 2 {
				t.Fatalf("outputs lost: %v", payload)
			}
			if mode != "async" && data[1].(map[string]any)["b64_json"] != base64.StdEncoding.EncodeToString([]byte("second output")) {
				t.Fatalf("wrong second output: %v", data)
			}
			if mode == "async" {
				url := data[1].(map[string]any)["url"].(string)
				if !strings.HasPrefix(url, "http://localhost:3000/") {
					t.Fatalf("relative output %s", url)
				}
				read := httptest.NewRecorder()
				b.handler().ServeHTTP(read, httptest.NewRequest("GET", url, nil))
				if read.Code != 200 || read.Body.String() != "second output" {
					t.Fatalf("signed output unreadable: %d %s", read.Code, read.Body.String())
				}
			}
			worker := mediaWorker{backend: b}
			if err := worker.processImage(ctx, id); err != nil {
				t.Fatal(err)
			}
			var count, summary, leases int
			if err := b.db.QueryRow(ctx, `SELECT (SELECT sum(image_count) FROM user_output_usage_event WHERE user_id=$1),(SELECT total_image_count FROM user_usage_summary WHERE user_id=$1),(SELECT count(*) FROM image_backend_member_lease WHERE id=$2)`, uid, "go-image:"+id).Scan(&count, &summary, &leases); err != nil {
				t.Fatal(err)
			}
			if count != 2 || summary != 2 || leases != 0 || posts.Load() != 1 {
				t.Fatalf("duplicate/lost usage: count=%d summary=%d leases=%d posts=%d", count, summary, leases, posts.Load())
			}
			bad := httptest.NewRequest("GET", "http://localhost:3000/api/v1/images/"+id, nil)
			bad.Header.Set("Authorization", "Bearer "+otherKey)
			denied := httptest.NewRecorder()
			b.handler().ServeHTTP(denied, bad)
			if denied.Code != 404 {
				t.Fatalf("foreign key response: %d %s", denied.Code, denied.Body.String())
			}
		})
	}
}

func TestImageInvalidDeliveryAndRetiredAPIsDoNotCreateOrCharge(t *testing.T) {
	b := integrationBackend(t)
	uid, _ := seedAuthUser(t, b)
	ctx := context.Background()
	key, _ := seedPublicImageKey(t, b, uid, seedImagePricingGroup(t, b, true, nil, nil))
	for _, path := range []string{"/v1/chat/completions", "/api/v1/responses", "/v1/agents/images", "/api/images/chat", "/api/images/chat/web-select", "/api/editable-file/generate", "/v1/ppts", "/v1/psds"} {
		w := authRequest(t, b, "POST", path, `{"prompt":"should not be queued"}`)
		if w.Code != 410 {
			t.Fatalf("retired %s returned %d %s", path, w.Code, w.Body.String())
		}
	}
	r := httptest.NewRequest("POST", "http://localhost/v1/images/generations", strings.NewReader(`{"model":"unused","prompt":"test","async":true,"stream":true}`))
	r.Header.Set("Authorization", "Bearer "+key)
	w := httptest.NewRecorder()
	b.handler().ServeHTTP(w, r)
	if w.Code != 400 {
		t.Fatalf("contradictory modes: %d", w.Code)
	}
	var count int
	if err := b.db.QueryRow(ctx, `SELECT count(*) FROM generation WHERE user_id=$1`, uid).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("invalid request was charged/queued")
	}
}

func TestImageWorkerWaitsForSharedProviderCapacityWithoutChargingAgain(t *testing.T) {
	b := integrationBackend(t)
	ctx := context.Background()
	uid, _ := seedAuthUser(t, b)
	b.config.storagePath = t.TempDir()
	setStorageTestSetting(t, b, "STORAGE_ENDPOINT", "")
	setStorageTestSetting(t, b, "CONTENT_MODERATION_ENABLED", false)
	model := "capacity-" + newRequestID()
	seedImagePricingSettings(t, b, model)
	creditTestWallet(t, b, uid, 100)
	creditTestBatch(t, b, uid, "purchase", 100, nil)
	var posts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		posts.Add(1)
		_, _ = w.Write([]byte(`{"data":[{"b64_json":"b3V0cHV0"}]}`))
	}))
	defer server.Close()
	group := seedImagePricingGroup(t, b, true, nil, nil)
	member := seedImagePricingMember(t, b, group, model, server.URL, false, 1)
	if _, err := b.db.Exec(ctx, `UPDATE image_backend_member SET concurrency=1 WHERE id=$1`, member); err != nil {
		t.Fatal(err)
	}
	lease := "go-video:" + newRequestID()
	if _, err := b.db.Exec(ctx, `INSERT INTO image_backend_member_lease(id,member_id,owner_token,expires_at) VALUES($1,$2,'other-video',now()+interval '10 minutes')`, lease, member); err != nil {
		t.Fatal(err)
	}
	task, err := b.createImageTask(httptest.NewRequest("POST", "http://localhost/api/images/generate", nil), &apiPrincipal{UserID: uid}, imagePricingInput(map[string]any{"model": model, "prompt": "wait for provider", "backendGroupId": group}), "generate")
	if err != nil {
		t.Fatal(err)
	}
	id := task["id"].(string)
	worker := mediaWorker{backend: b}
	if err = worker.processImage(ctx, id); err != nil {
		t.Fatal(err)
	}
	var status string
	var count int
	if err = b.db.QueryRow(ctx, `SELECT g.status,(SELECT count(*) FROM credits_transaction WHERE user_id=$2) FROM image_async_task t JOIN generation g ON g.id=t.generation_id WHERE t.id=$1`, id, uid).Scan(&status, &count); err != nil {
		t.Fatal(err)
	}
	if status != "pending" || count != 1 || posts.Load() != 0 {
		t.Fatalf("capacity caused failure or repeat charge: %s %d %d", status, count, posts.Load())
	}
	if _, err = b.db.Exec(ctx, `DELETE FROM image_backend_member_lease WHERE id=$1`, lease); err != nil {
		t.Fatal(err)
	}
	if err = worker.processImage(ctx, id); err != nil {
		t.Fatal(err)
	}
	if posts.Load() != 1 {
		t.Fatalf("task did not resume exactly once: %d", posts.Load())
	}
}
