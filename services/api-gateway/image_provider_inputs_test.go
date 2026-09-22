package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func testImageProviderBody() map[string]any {
	return map[string]any{"model": "vendor-model", "prompt": "edit the image", "n": "1", "image[]": []any{&imageProviderFile{Name: "first.png", MIME: "image/png", Data: []byte("first-image")}, &imageProviderFile{Name: "second.webp", MIME: "image/webp", Data: []byte("second-image")}}, "mask": &imageProviderFile{Name: "mask.png", MIME: "image/png", Data: []byte("mask-image")}}
}

func TestImageProviderMultipartCarriesImageAndMaskBytes(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != "POST" || r.URL.Path != "/v1/images/edits" || r.Header.Get("X-Vendor-Key") != "secret" || r.Header.Get("Authorization") != "" {
			t.Error("incorrect edit operation or authentication")
		}
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Error(err)
			return
		}
		defer r.MultipartForm.RemoveAll()
		if r.FormValue("model") != "vendor-model" || r.FormValue("n") != "1" {
			t.Error("missing fields")
		}
		for field, wants := range map[string][]string{"image[]": {"first-image", "second-image"}, "mask": {"mask-image"}} {
			files := r.MultipartForm.File[field]
			if len(files) != len(wants) {
				t.Errorf("missing %s files", field)
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
					t.Error("file bytes changed")
				}
				if !strings.HasPrefix(file.Header.Get("Content-Type"), "image/") {
					t.Error("file MIME omitted")
				}
			}
		}
		_, _ = io.WriteString(w, `{"data":[{"b64_json":"b3V0cHV0"}]}`)
	}))
	defer server.Close()
	b := &backend{}
	cfg := providerConfig{baseURL: server.URL + "/v1", apiKey: "secret", adapter: map[string]any{"authentication": map[string]any{"mode": "custom_header", "headerName": "X-Vendor-Key"}}}
	result, err := b.callProvider(context.Background(), cfg, "images.edit", testImageProviderBody(), "task", "platform-model")
	if err != nil || calls.Load() != 1 {
		t.Fatalf("request failed: %v", err)
	}
	data, _, err := readImageProviderOutput(context.Background(), result)
	if err != nil || string(data) != "output" {
		t.Fatalf("base64 output unreadable: %v", err)
	}
}

func TestImageProviderRequestScriptRemapsFilesAndMergesEnvelope(t *testing.T) {
	for _, omitBody := range []bool{false, true} {
		t.Run(map[bool]string{false: "renamed body", true: "omitted body keeps files"}[omitBody], func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Query().Get("detail") != "true" || strings.Join(r.URL.Query()["ids"], ",") != "2,1" || r.Header.Get("X-Image-Mode") != "edit" {
					t.Error("query/header envelope ignored")
				}
				if err := r.ParseMultipartForm(1 << 20); err != nil {
					t.Error(err)
					return
				}
				defer r.MultipartForm.RemoveAll()
				key := "source_images"
				if omitBody {
					key = "image[]"
				}
				if len(r.MultipartForm.File[key]) != 2 || len(r.MultipartForm.File["mask"]) != 1 {
					t.Error("script rename or omitted body dropped files")
				}
				_, _ = io.WriteString(w, `{"data":[{"url":"https://example.test/output.png"}]}`)
			}))
			defer upstream.Close()
			runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var request scriptRuntimeRequest
				if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
					t.Error(err)
					return
				}
				input := request.Input.(map[string]any)
				body := input["body"].(map[string]any)
				ctx := request.Context.(map[string]any)
				if request.Operation != "images.edit" || ctx["contentType"] != "multipart/form-data" || ctx["upstreamModelId"] != "vendor-model" {
					t.Error("incorrect adapter context")
				}
				if token, ok := body["mask"].(string); !ok || !strings.HasPrefix(token, imageOpaquePrefix) {
					t.Error("mask bytes leaked to script")
				}
				encoded, _ := json.Marshal(input)
				if bytes.Contains(encoded, []byte("first-image")) || bytes.Contains(encoded, []byte("mask-image")) {
					t.Error("file data leaked to script")
				}
				envelope := map[string]any{"query": map[string]any{"detail": true, "ids": []any{2, 1}}, "headers": map[string]any{"X-Image-Mode": "edit"}}
				if !omitBody {
					body["source_images"] = body["image[]"]
					delete(body, "image[]")
					envelope["body"] = body
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"output": envelope}})
			}))
			defer runtime.Close()
			b := &backend{config: config{scriptRuntimeURL: runtime.URL}}
			cfg := providerConfig{baseURL: upstream.URL, apiKey: "secret", operations: map[string]any{"images.edit": map[string]any{"requestScript": "return request;"}}, adapter: map[string]any{"modelMappings": []any{map[string]any{"modelId": "platform-model", "upstreamModelId": "vendor-model"}}}}
			if _, err := b.callProvider(context.Background(), cfg, "images.edit", testImageProviderBody(), "task", "platform-model"); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestImageProviderRejectsBrokenTokensAndForbiddenScriptOverridesBeforeSend(t *testing.T) {
	for _, scenario := range []string{"drop", "duplicate", "nested", "query token", "forged", "method", "path", "authorization", "content-type", "custom auth"} {
		t.Run(scenario, func(t *testing.T) {
			var calls atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
			defer upstream.Close()
			runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var request scriptRuntimeRequest
				_ = json.NewDecoder(r.Body).Decode(&request)
				body := request.Input.(map[string]any)["body"].(map[string]any)
				envelope := map[string]any{"body": body}
				switch scenario {
				case "drop":
					delete(body, "mask")
				case "duplicate":
					body["copy"] = body["mask"]
				case "nested":
					body["mask"] = map[string]any{"data": body["mask"]}
				case "query token":
					envelope["query"] = map[string]any{"media": body["mask"]}
				case "forged":
					body["mask"] = imageOpaquePrefix + "forged"
				case "method":
					envelope["method"] = "GET"
				case "path":
					envelope["path"] = "https://other.example/"
				case "authorization", "content-type":
					envelope["headers"] = map[string]any{scenario: "forbidden"}
				case "custom auth":
					envelope["headers"] = map[string]any{"X-Vendor-Key": "forbidden"}
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"output": envelope}})
			}))
			defer runtime.Close()
			b := &backend{config: config{scriptRuntimeURL: runtime.URL}}
			cfg := providerConfig{baseURL: upstream.URL, apiKey: "secret", operations: map[string]any{"images.edit": map[string]any{"requestScript": "return request;"}}, adapter: map[string]any{"authentication": map[string]any{"mode": "custom_header", "headerName": "X-Vendor-Key"}}}
			if _, err := b.callProvider(context.Background(), cfg, "images.edit", testImageProviderBody(), "task", "platform-model"); err == nil {
				t.Fatal("invalid script output accepted")
			}
			if calls.Load() != 0 {
				t.Fatal("invalid script contacted provider")
			}
		})
	}
}

func TestImageProviderParametersUseModelAndSizeSnapshots(t *testing.T) {
	cfg := providerConfig{adapter: map[string]any{"modelMappings": []any{map[string]any{"modelId": "platform", "upstreamModelId": "vendor"}}, "imageSizeConfigsByModel": map[string]any{"platform": map[string]any{"mappings": []any{map[string]any{"resolution": "2k", "aspectRatio": "16:9", "size": "2048x1152"}}}}}}
	out, err := imageProviderParameters(cfg, "platform", map[string]any{"prompt": "prompt", "aspectRatio": "16:9", "resolution": "2K", "outputFormat": "webp", "outputCompression": 82, "generationId": "internal", "userId": "private", "n": 99})
	if err != nil {
		t.Fatal(err)
	}
	if out["model"] != "vendor" || out["size"] != "2048x1152" || out["width"] != 2048 || out["n"] != 1 || out["output_format"] != "webp" || out["output_compression"] != 82 || out["aspect_ratio"] != nil || out["userId"] != nil || out["generationId"] != nil {
		t.Fatalf("invalid provider parameters: %+v", out)
	}
	if _, err := imageProviderParameters(cfg, "platform", map[string]any{"prompt": "prompt", "aspectRatio": "1:1", "resolution": "2K"}); err == nil {
		t.Fatal("unsupported configured size fell through")
	}
}

func TestImageProviderPathsRejectEscapesAndUseCorrectDefaults(t *testing.T) {
	for _, bad := range []string{"//evil.example/path", "https://evil.example/path", "/../outside", "/%252e%252e/outside", "/edit?token=x", "/edit#fragment", "/edit/{task_id}"} {
		cfg := providerConfig{baseURL: "https://example.test/v1", operations: map[string]any{"images.edit": map[string]any{"path": bad}}}
		if _, err := imageProviderURL(cfg, "images.edit"); err == nil {
			t.Fatalf("unsafe path accepted: %s", bad)
		}
	}
	u, err := imageProviderURL(providerConfig{baseURL: "https://example.test/v1"}, "images.generate")
	if err != nil || u.String() != "https://example.test/v1/images/generations" {
		t.Fatal("wrong generation default path")
	}
}

func TestImageProviderDecodesStandardAndScriptedBase64Outputs(t *testing.T) {
	for _, payload := range []map[string]any{{"data": []any{map[string]any{"b64_json": base64.StdEncoding.EncodeToString([]byte("result"))}}}, {"outputs": []any{map[string]any{"kind": "image", "base64": "data:image/png;base64,cmVzdWx0"}}}} {
		data, _, err := readImageProviderOutput(context.Background(), payload)
		if err != nil || string(data) != "result" {
			t.Fatalf("output not decoded: %v", err)
		}
	}
	if _, _, err := readImageProviderOutput(context.Background(), map[string]any{"data": []any{map[string]any{"b64_json": "invalid!"}}}); err == nil {
		t.Fatal("invalid image data accepted")
	}
}
