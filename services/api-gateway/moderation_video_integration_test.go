//go:build integration

package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
)

func TestModerationVideoWorkerChecksFramesBeforeSubmissionAndSkipsPolling(t *testing.T) {
	for _, block := range []bool{false, true} {
		name := "allow then poll"
		if block {
			name = "block before submission"
		}
		t.Run(name, func(t *testing.T) {
			b := integrationBackend(t)
			userID, _ := seedAuthUser(t, b)
			id := newRequestID()
			var checks, submissions, polls atomic.Int32
			imageBytes := []byte("stored-video-frame")
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/v1/moderations":
					checks.Add(1)
					var payload struct {
						Input []map[string]any `json:"input"`
					}
					_ = json.NewDecoder(r.Body).Decode(&payload)
					if len(payload.Input) != 3 || payload.Input[0]["text"] != "video prompt" {
						t.Error("video prompt or first/last frames omitted")
					} else {
						for _, input := range payload.Input[1:] {
							image, _ := input["image_url"].(map[string]any)
							if image["url"] != "data:image/png;base64,"+base64.StdEncoding.EncodeToString(imageBytes) {
								t.Error("video frame bytes omitted")
							}
						}
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"results": []any{map[string]any{"flagged": block}}})
				case "/video":
					submissions.Add(1)
					_, _ = io.WriteString(w, `{"id":"upstream-task","status":"processing"}`)
				case "/poll/upstream-task":
					polls.Add(1)
					_, _ = io.WriteString(w, `{"status":"processing"}`)
				default:
					w.WriteHeader(404)
				}
			}))
			defer server.Close()
			configureModerationIntegration(t, b, server.URL)
			setStorageTestSetting(t, b, "SYSTEM_ASSETS_BUCKET_NAME", "system")
			setStorageTestSetting(t, b, "GENERATIONS_BUCKET_NAME", "generations")
			uniqueModel := seedModerationProvider(t, b, server.URL, true)
			if _, err := b.db.Exec(context.Background(), `UPDATE image_backend_member SET supported_model_ids='["veo31"]' WHERE supported_model_ids::jsonb @> jsonb_build_array($1::text)`, uniqueModel); err != nil {
				t.Fatal(err)
			}
			if _, err := b.db.Exec(context.Background(), `UPDATE image_backend_member_api_adapter_version SET configuration=jsonb_set(configuration::jsonb||'{"videoInputFormat":"base64"}'::jsonb,'{operations,videos.query,path}','"/poll/{task_id}"')::json WHERE member_id_snapshot IN (SELECT id FROM image_backend_member WHERE supported_model_ids::jsonb @> '["veo31"]'::jsonb) AND configuration->>'baseUrl'=$1`, server.URL); err != nil {
				t.Fatal(err)
			}
			manifest := map[string]any{}
			for _, slot := range []string{"firstFrame", "lastFrame"} {
				key := userID + "/video-inputs/" + id + "/" + slot + "/frame.png"
				file := filepath.Join(b.config.storagePath, "generations", filepath.FromSlash(key))
				if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(file, imageBytes, 0600); err != nil {
					t.Fatal(err)
				}
				manifest[slot] = map[string]any{"source": "storage", "storageBucket": "generations", "storageKey": key, "mimeType": "image/png", "byteLength": len(imageBytes)}
			}
			if _, err := b.db.Exec(context.Background(), `INSERT INTO video_generation(id,user_id,model,prompt,duration_seconds,aspect_ratio,resolution,status,stage,principal_scope,output_width,output_height,input_manifest) VALUES($1,$2,'veo31','video prompt',5,'16:9','720p','running','charged','user:'||$2,1280,720,$3)`, id, userID, mustJSON(manifest)); err != nil {
				t.Fatal(err)
			}
			worker := mediaWorker{backend: b}
			if err := worker.processVideo(context.Background(), id); err != nil {
				t.Fatal(err)
			}
			var stage string
			var completed bool
			if err := b.db.QueryRow(context.Background(), `SELECT stage,(metadata->'moderation'->>'completed')::boolean FROM video_generation WHERE id=$1`, id).Scan(&stage, &completed); err != nil {
				t.Fatal(err)
			}
			if checks.Load() != 1 || !completed {
				t.Fatal("video moderation evidence missing")
			}
			if block {
				if stage != "failed" || submissions.Load() != 0 {
					t.Fatal("blocked video submitted to upstream")
				}
			} else {
				if stage != "polling" || submissions.Load() != 1 {
					var failure string
					_ = b.db.QueryRow(context.Background(), `SELECT COALESCE(error,'') FROM video_generation WHERE id=$1`, id).Scan(&failure)
					t.Fatalf("allowed video did not start polling: %s calls=%d error=%s", stage, submissions.Load(), failure)
				}
				if err := worker.processVideo(context.Background(), id); err != nil {
					t.Fatal(err)
				}
				if checks.Load() != 1 || submissions.Load() != 1 || polls.Load() != 1 {
					t.Fatal("poll repeated moderation/submission")
				}
			}
		})
	}
}
