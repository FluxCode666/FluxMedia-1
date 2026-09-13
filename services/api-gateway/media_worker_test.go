package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestProviderPollURLEscapesTaskIDAndUsesQueryAdapterPath(t *testing.T) {
	cfg := providerConfig{
		baseURL: "https://video.example.test/v1",
		operations: map[string]any{
			"videos.query": map[string]any{"path": "/tasks/{task_id}"},
		},
	}
	got := providerPollURL(cfg, "job/id 1")
	want := "https://video.example.test/v1/tasks/job%2Fid%201"
	if got != want {
		t.Fatalf("providerPollURL() = %q, want %q", got, want)
	}
}

func TestVideoLedgerSourceRefPreservesMigrationNamespace(t *testing.T) {
	if got := videoLedgerSourceRef("video-1", []byte(`{"videoLedgerNamespace":"video"}`)); got != "video:video-1" {
		t.Fatalf("canonical source ref = %q", got)
	}
	if got := videoLedgerSourceRef("legacy-1", []byte(`{}`)); got != "adobe-video:legacy-1" {
		t.Fatalf("legacy source ref = %q", got)
	}
}

func TestExtractMediaURLTraversesScriptedOutputs(t *testing.T) {
	got := extractMediaURL(map[string]any{
		"status":  "completed",
		"outputs": []any{map[string]any{"kind": "video", "url": "https://cdn.example.test/video.mp4"}},
	})
	if got != "https://cdn.example.test/video.mp4" {
		t.Fatalf("extractMediaURL() = %q", got)
	}
}

func TestApplyProviderResponseScriptUsesResponseStage(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request scriptRuntimeRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode runtime request: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if request.Stage != "response" || request.Operation != "videos.query" {
			t.Errorf("runtime request stage/operation = %s/%s", request.Stage, request.Operation)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": map[string]any{
				"output": map[string]any{
					"status":  "completed",
					"outputs": []any{map[string]any{"url": "https://cdn.example.test/video.mp4"}},
				},
			},
		})
	}))
	defer server.Close()

	b := &backend{config: config{scriptRuntimeURL: server.URL}}
	cfg := providerConfig{
		baseURL: server.URL,
		operations: map[string]any{
			"videos.query": map[string]any{"responseScript": `return { status: "completed", outputs: [{ url: response.body.output }] };`},
		},
	}
	got, err := b.applyProviderResponseScript(context.Background(), cfg, "videos.query", map[string]any{"output": "https://cdn.example.test/video.mp4"}, http.StatusOK, http.Header{"X-Provider": []string{"ok"}}, "task-1", "model-1")
	if err != nil {
		t.Fatalf("applyProviderResponseScript() error = %v", err)
	}
	if got["status"] != "completed" || extractMediaURL(got) == "" {
		t.Fatalf("unexpected normalized response: %#v", got)
	}
}

func TestQueryProviderRejectsUntrustedOrigin(t *testing.T) {
	b := &backend{}
	cfg := providerConfig{baseURL: "https://trusted.example.test", apiKey: "secret"}
	if _, err := b.queryProvider(context.Background(), cfg, "https://evil.example.test/task", "task-1", "model-1"); err == nil {
		t.Fatal("queryProvider accepted an untrusted polling origin")
	}
}

func TestQueryProviderRequestScriptMergesQueryAndHeaders(t *testing.T) {
	var seenURL string
	var seenHeader string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenURL = r.URL.String()
		seenHeader = r.Header.Get("X-Vendor-Mode")
		_, _ = w.Write([]byte(`{"status":"processing"}`))
	}))
	defer upstream.Close()
	runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": map[string]any{
				"output": map[string]any{
					"query":   map[string]any{"detail": "full"},
					"headers": map[string]any{"X-Vendor-Mode": "fast"},
				},
			},
		})
	}))
	defer runtime.Close()

	b := &backend{config: config{scriptRuntimeURL: runtime.URL}}
	cfg := providerConfig{
		baseURL: upstream.URL,
		operations: map[string]any{
			"videos.query": map[string]any{"requestScript": `return { query: { detail: "full" }, headers: { "X-Vendor-Mode": "fast" } };`},
		},
	}
	if _, err := b.queryProvider(context.Background(), cfg, upstream.URL+"/task?keep=true", "task-1", "model-1"); err != nil {
		t.Fatalf("queryProvider() error = %v", err)
	}
	if seenURL != "/task?detail=full&keep=true" || seenHeader != "fast" {
		t.Fatalf("request script envelope not applied: url=%q header=%q", seenURL, seenHeader)
	}
}
