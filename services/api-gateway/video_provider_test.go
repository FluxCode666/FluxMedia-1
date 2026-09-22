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
)

func TestVideoProviderPerModelInputsOverrideLegacyCapabilities(t *testing.T) {
	manifest := map[string]any{"referenceVideos": []any{map[string]any{"key": "video"}}}
	cfg := providerConfig{adapter: map[string]any{"videoInputCapabilities": map[string]any{"referenceVideos": true}}}
	if !videoProviderSupportsInputs(cfg, "model", manifest) {
		t.Fatal("legacy reference capability was discarded")
	}
	cfg.adapter["videoInputCapabilitiesByModel"] = map[string]any{" MODEL ": map[string]any{"referenceVideos": false}}
	if videoProviderSupportsInputs(cfg, "model", manifest) {
		t.Fatal("explicit per-model disabled capability was ignored")
	}
	if videoProviderSupportsInputs(providerConfig{}, "model", manifest) {
		t.Fatal("reference video accepted without a capability")
	}
}

func TestVideoProviderAuthenticationIsExplicitAndRedirectsDoNotCarryCredentials(t *testing.T) {
	var calls, redirects atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirects.Add(1) }))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("X-Vendor-Key") != "secret" {
			t.Error("custom authentication omitted")
		}
		w.Header().Set("Location", target.URL)
		w.WriteHeader(307)
	}))
	defer server.Close()
	b := &backend{}
	cfg := providerConfig{baseURL: server.URL, adapter: map[string]any{"authentication": map[string]any{"mode": "custom_header", "headerName": "X-Vendor-Key"}}}
	if _, err := b.callProvider(context.Background(), cfg, "videos.generate", map[string]any{"model": "video"}, "task", "video"); err == nil || calls.Load() != 0 {
		t.Fatal("missing configured credential was accepted")
	}
	cfg.apiKey = "secret"
	if _, err := b.callProvider(context.Background(), cfg, "videos.generate", map[string]any{"model": "video"}, "task", "video"); err == nil {
		t.Fatal("redirect treated as accepted video")
	}
	if calls.Load() != 1 || redirects.Load() != 0 {
		t.Fatal("video submission followed redirect with provider key")
	}
}

func TestVideoProviderRequestScriptsSeeTokensAndPreserveNestedMedia(t *testing.T) {
	var runtimeCalls, providerCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		providerCalls.Add(1)
		if r.URL.Query().Get("version") != "2" || r.Header.Get("X-Mode") != "video" || r.Header.Get("Authorization") != "Bearer secret" {
			t.Error("request envelope fields lost")
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		nested, _ := body["inputs"].(map[string]any)
		if nested["frame"] != "data:image/png;base64,cGl4ZWxz" || body["model"] != "upstream-video" {
			t.Errorf("media not restored to transport: %#v", body)
		}
		_, _ = io.WriteString(w, `{"id":"accepted","status":"processing"}`)
	}))
	defer server.Close()
	var duplicate atomic.Bool
	runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		runtimeCalls.Add(1)
		var in scriptRuntimeRequest
		_ = json.NewDecoder(r.Body).Decode(&in)
		input, _ := in.Input.(map[string]any)
		body, _ := input["body"].(map[string]any)
		token, _ := body["first_frame"].(string)
		if !strings.HasPrefix(token, imageOpaquePrefix) || strings.Contains(mustJSON(in.Input), "cGl4ZWxz") {
			t.Error("runtime received actual media")
		}
		runtimeContext, _ := in.Context.(map[string]any)
		if runtimeContext["upstreamModelId"] != "upstream-video" {
			t.Error("script context lost mapped model")
		}
		delete(body, "first_frame")
		body["inputs"] = map[string]any{"frame": token}
		if duplicate.Load() {
			body["duplicate"] = token
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"output": map[string]any{"body": body, "query": map[string]any{"version": 2}, "headers": map[string]any{"X-Mode": "video"}}}})
	}))
	defer runtime.Close()
	b := &backend{config: config{scriptRuntimeURL: runtime.URL}}
	cfg := providerConfig{baseURL: server.URL, apiKey: "secret", operations: map[string]any{"videos.generate": map[string]any{"requestScript": "return {body: request.body};"}}, adapter: map[string]any{"modelMappings": []any{map[string]any{"modelId": "video", "upstreamModelId": "upstream-video"}}}}
	body := map[string]any{"client_request_id": "idempotent", "model": "upstream-video", "first_frame": &videoProviderMedia{value: "data:image/png;base64,cGl4ZWxz"}}
	if _, err := b.callProvider(context.Background(), cfg, "videos.generate", body, "task", "video"); err != nil {
		t.Fatal(err)
	}
	duplicate.Store(true)
	if _, err := b.callProvider(context.Background(), cfg, "videos.generate", body, "task", "video"); err == nil {
		t.Fatal("script duplicated opaque media")
	}
	if providerCalls.Load() != 1 || runtimeCalls.Load() != 2 {
		t.Fatal("invalid script reached upstream")
	}
}

func TestVideoProviderStrictResponseContracts(t *testing.T) {
	for _, test := range []struct {
		name, raw    string
		query, valid bool
	}{
		{"pending generation", `{"status":"pending","taskId":"accepted","pollAfterSeconds":3}`, false, true},
		{"pending query", `{"status":"processing","progress":12}`, true, true},
		{"video output", `{"status":"completed","outputs":[{"kind":"video","url":"https://cdn.test/a.mp4"}]}`, false, true},
		{"unknown property", `{"status":"processing","taskId":"id","poll_url":"https://evil.test"}`, false, false},
		{"wrong media kind", `{"status":"completed","outputs":[{"kind":"image","url":"https://cdn.test/a"}]}`, false, false},
		{"query retry", `{"status":"failed","error":{"category":"upstream","code":"failed"},"retryable":true}`, true, false},
		{"invalid category", `{"status":"failed","error":{"category":"vendor","code":"failed"}}`, false, false},
		{"relative script output", `{"status":"completed","outputs":[{"kind":"video","url":"/a.mp4"}]}`, false, false},
		{"invalid progress", `{"status":"processing","progress":"5"}`, true, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			var result map[string]any
			_ = json.Unmarshal([]byte(test.raw), &result)
			if err := validateScriptedVideoResult(result, test.query); (err == nil) != test.valid {
				t.Fatalf("validation err=%v valid=%v", err, test.valid)
			}
		})
	}
}

func TestVideoProviderNativeURLsAndAcceptedIdentity(t *testing.T) {
	for _, test := range []struct{ mode, base, identity, operation, want string }{
		{"gemini", "https://provider.test", "platform", "videos.generate", "https://provider.test/v1beta/models/veo-3:predictLongRunning"},
		{"gemini", "https://provider.test", "models/veo-3/operations/abc", "videos.query", "https://provider.test/v1beta/models/veo-3/operations/abc"},
		{"seedance", "https://provider.test/api/v3", "job/id 1", "videos.query", "https://provider.test/api/v3/contents/generations/tasks/job%2Fid%201"},
	} {
		cfg := providerConfig{baseURL: test.base, adapter: map[string]any{"videoProtocolMode": test.mode, "modelMappings": []any{map[string]any{"modelId": "platform", "upstreamModelId": "veo-3"}}}}
		got, err := videoProviderURL(cfg, test.operation, test.identity)
		if err != nil || got.String() != test.want {
			t.Fatalf("native route %v %v want %s", got, err, test.want)
		}
	}
	result := map[string]any{"name": "models/veo-3/operations/abc", "done": true, "response": map[string]any{"generateVideoResponse": map[string]any{"generatedSamples": []any{map[string]any{"video": map[string]any{"uri": "https://cdn.test/a.mp4"}}}}}}
	got, err := normalizeGeminiVideoResult(result, "models/veo-3/operations/abc", "veo-3", true)
	if err != nil || got["status"] != "completed" {
		t.Fatalf("Gemini final result %v %v", got, err)
	}
	if _, err := normalizeGeminiVideoResult(result, "models/other/operations/abc", "other", true); err == nil {
		t.Fatal("Gemini model mismatch accepted")
	}
	if _, _, err := inspectVideoProviderResult(providerConfig{baseURL: "https://provider.test"}, map[string]any{"status": "processing", "taskId": "other"}, "expected"); err == nil {
		t.Fatal("poll changed accepted job ID")
	}
}

func TestVideoRequestSnapshotRedactsTokensCredentialsAndSignedURLs(t *testing.T) {
	media := map[string]*videoProviderMedia{"opaque": {value: "data:image/png;base64,cGl4ZWxz"}}
	snapshot := mustJSON(videoRequestSnapshot(map[string]any{"inputs": map[string]any{"frame": "opaque"}, "signed": "https://cdn.test/path?signature=secret", "credential": "private", "prompt": "hello"}, media))
	for _, forbidden := range []string{"signature=", "secret", "private", "cGl4ZWxz"} {
		if strings.Contains(snapshot, forbidden) {
			t.Fatalf("request snapshot contains %s", forbidden)
		}
	}
	if !strings.Contains(snapshot, "[MEDIA]") || !strings.Contains(snapshot, "hello") {
		t.Fatal("snapshot lost inspectable request structure")
	}
}
