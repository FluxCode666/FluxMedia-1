//go:build integration

package main

import (
	"bytes"
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

func TestImageProviderWorkerDispatchesGenerateEditMaskAndPublicURL(t *testing.T) {
	for _, scenario := range []string{"generate", "edit", "mask", "public URL", "public URL rejects mask"} {
		t.Run(scenario, func(t *testing.T) {
			b := integrationBackend(t)
			userID, _ := seedAuthUser(t, b)
			outputBytes, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==")
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				expectedPath := "/images/edits"
				if scenario == "generate" {
					expectedPath = "/images/generations"
				}
				if r.URL.Path != expectedPath || r.Method != "POST" {
					t.Errorf("wrong operation: %s %s", r.Method, r.URL.Path)
				}
				if scenario == "generate" || scenario == "public URL" {
					var payload map[string]any
					if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
						t.Error(err)
					}
					if payload["model"] != "vendor-image" || payload["n"] != float64(1) || payload["response_format"] != "b64_json" {
						t.Errorf("wrong JSON parameters: %+v", payload)
					}
					if payload["userId"] != nil || payload["images"] != nil || payload["operation"] != nil {
						t.Error("internal task fields leaked upstream")
					}
					if scenario == "public URL" {
						urls, ok := payload["image_urls"].([]any)
						if !ok || len(urls) != 2 {
							t.Error("missing public image URLs")
							return
						}
						for _, raw := range urls {
							parsed, err := url.Parse(raw.(string))
							if err != nil || parsed.Host != "media.example.test" || parsed.Query().Get("sig") == "" {
								t.Error("reference is not a signed public URL")
							}
						}
					}
				} else {
					if err := r.ParseMultipartForm(1 << 20); err != nil {
						t.Error(err)
						return
					}
					defer r.MultipartForm.RemoveAll()
					if r.FormValue("model") != "vendor-image" || r.FormValue("n") != "1" || r.FormValue("response_format") != "b64_json" {
						t.Error("multipart parameters omitted")
					}
					expected := map[string][]string{"image[]": {"first-image", "second-image"}}
					if scenario == "mask" {
						expected = map[string][]string{"image": {"first-image"}, "mask": {"mask-image"}}
					}
					for field, wants := range expected {
						files := r.MultipartForm.File[field]
						if len(files) != len(wants) {
							t.Errorf("missing %s bytes", field)
							continue
						}
						for i, file := range files {
							reader, err := file.Open()
							if err != nil {
								t.Error(err)
								continue
							}
							data, _ := io.ReadAll(reader)
							_ = reader.Close()
							if string(data) != wants[i] {
								t.Error("stored bytes not sent")
							}
						}
					}
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]any{"b64_json": base64.StdEncoding.EncodeToString(outputBytes)}}})
			}))
			defer server.Close()
			configureModerationIntegration(t, b, server.URL)
			setStorageTestSetting(t, b, "CONTENT_MODERATION_ENABLED", false)
			b.config.publicAppURL = "https://media.example.test"
			model := seedModerationProvider(t, b, server.URL, true)
			var adapterRaw []byte
			var versionID string
			if err := b.db.QueryRow(context.Background(), `SELECT v.id,v.configuration FROM image_backend_member_api_adapter_version v JOIN image_backend_member_api_config c ON c.current_adapter_version_id=v.id JOIN image_backend_member m ON m.id=c.member_id WHERE m.supported_model_ids::jsonb @> jsonb_build_array($1::text)`, model).Scan(&versionID, &adapterRaw); err != nil {
				t.Fatal(err)
			}
			var adapter map[string]any
			_ = json.Unmarshal(adapterRaw, &adapter)
			adapter["operations"] = map[string]any{"images.generate": map[string]any{"path": ""}, "images.edit": map[string]any{"path": ""}}
			adapter["modelMappings"] = []any{map[string]any{"modelId": model, "upstreamModelId": "vendor-image"}}
			adapter["authentication"] = map[string]any{"mode": "none"}
			if strings.HasPrefix(scenario, "public URL") {
				adapter["convertReferenceImagesToPublicUrl"] = true
			}
			if _, err := b.db.Exec(context.Background(), `UPDATE image_backend_member_api_adapter_version SET configuration=$2 WHERE id=$1`, versionID, mustJSON(adapter)); err != nil {
				t.Fatal(err)
			}
			refs := []any{}
			for i, data := range []string{"first-image", "second-image", "mask-image"} {
				key := userID + "/image-inputs/" + newRequestID() + "/input.png"
				file := filepath.Join(b.config.storagePath, "generations", filepath.FromSlash(key))
				if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(file, []byte(data), 0600); err != nil {
					t.Fatal(err)
				}
				refs = append(refs, map[string]any{"source": "storage", "storageBucket": "generations", "storageKey": key, "mimeType": "image/png", "byteLength": len(data), "name": []string{"first.png", "second.png", "mask.png"}[i]})
			}
			taskID, generationID := seedModerationImageTask(t, b, userID, model, refs[:2])
			operation := "edit"
			body := map[string]any{"model": model, "prompt": "edit the image", "generationId": generationID, "operation": operation, "images": refs[:2]}
			if scenario == "generate" {
				operation = "generate"
				delete(body, "images")
			}
			if scenario == "mask" || scenario == "public URL rejects mask" {
				operation = "mask"
				body["images"] = refs[:1]
				body["mask"] = refs[2]
			}
			body["operation"] = operation
			if _, err := b.db.Exec(context.Background(), `UPDATE image_async_task SET operation=$2,generation_input=$3,generation_inputs=$4 WHERE id=$1`, taskID, operation, mustJSON(body), mustJSON([]any{body})); err != nil {
				t.Fatal(err)
			}
			worker := mediaWorker{backend: b}
			if err := worker.processImage(context.Background(), taskID); err != nil {
				t.Fatal(err)
			}
			var status string
			var key, bucket *string
			if err := b.db.QueryRow(context.Background(), `SELECT status,storage_key,storage_bucket FROM generation WHERE id=$1`, generationID).Scan(&status, &key, &bucket); err != nil {
				t.Fatal(err)
			}
			if scenario == "public URL rejects mask" {
				if status != "failed" || calls.Load() != 0 {
					t.Fatal("unsupported public URL mask sent to provider")
				}
				return
			}
			if status != "completed" || calls.Load() != 1 || key == nil || bucket == nil {
				t.Fatalf("worker failed: status=%s calls=%d", status, calls.Load())
			}
			stored, err := b.readStorageObject(context.Background(), *bucket, *key)
			if err != nil || !bytes.Equal(stored, outputBytes) {
				t.Fatalf("base64 output not persisted: %v", err)
			}
		})
	}
}
