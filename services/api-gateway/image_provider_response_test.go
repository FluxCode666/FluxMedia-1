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
	"testing"
)

func TestImageProviderSSEKeepsFinalImageAndRejectsPartialOnlyOrError(t *testing.T) {
	for _, test := range []struct {
		name, stream, want string
		fail               bool
	}{
		{"final wins", "event: image_generation.partial_image\r\ndata: {\"partial_image_b64\":\"cGFydGlhbA==\"}\r\n\r\nevent: image_generation.completed\r\ndata: {\"b64_json\":\"ZmluYWw=\"}\r\n\r\ndata: [DONE]\r\n\r\n", "final", false},
		{"plain data fallback", "data: {\"data\":[{\"b64_json\":\"ZmluYWw=\"}]}\n\ndata: [DONE]\n\n", "final", false},
		{"partial only", "event: image_generation.partial_image\ndata: {\"b64_json\":\"cGFydGlhbA==\"}\n\n", "", true},
		{"upstream error", "event: error\ndata: {\"message\":\"secret provider failure\"}\n\n", "", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			result, err := parseImageProviderSSE([]byte(test.stream))
			if test.fail {
				if err == nil {
					t.Fatal("bad stream accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			data, _, err := readImageProviderOutput(context.Background(), result)
			if err != nil || string(data) != test.want {
				t.Fatalf("wrong stream output: %q %v", data, err)
			}
		})
	}
}

func TestImageProviderResponseScriptKeepsLargeImageOutsideRuntime(t *testing.T) {
	data := append([]byte{137, 80, 78, 71, 13, 10, 26, 10}, bytes.Repeat([]byte{0}, 3<<20)...)
	encoded := base64.StdEncoding.EncodeToString(data)
	runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		if len(raw) > 4096 {
			t.Error("large image entered script runtime")
		}
		var request scriptRuntimeRequest
		_ = json.Unmarshal(raw, &request)
		input := request.Input.(map[string]any)
		body := input["body"].(map[string]any)
		headers := input["headers"].(map[string]any)
		token, _ := body["vendor_image"].(string)
		if !strings.HasPrefix(token, imageOpaquePrefix) {
			t.Error("unknown image field not protected")
		}
		if headers["x-secret"] != nil || headers["retry-after"] != "12" {
			t.Error("response header boundary changed")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"output": map[string]any{"status": "completed", "outputs": []any{map[string]any{"kind": "image", "base64": token}}}}})
	}))
	defer runtime.Close()
	b := &backend{config: config{scriptRuntimeURL: runtime.URL}}
	cfg := providerConfig{operations: map[string]any{"images.generate": map[string]any{"responseScript": "return response;"}}}
	raw, _ := json.Marshal(map[string]any{"vendor_image": encoded})
	response := &http.Response{StatusCode: 200, Header: http.Header{"Retry-After": []string{"12"}, "X-Secret": []string{"must-not-leak"}}, Body: io.NopCloser(bytes.NewReader(raw))}
	result, err := b.decodeImageProviderResponse(context.Background(), cfg, "images.generate", response, "task", "model")
	if err != nil {
		t.Fatal(err)
	}
	got, _, err := readImageProviderOutput(context.Background(), result)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatal("script did not restore full image")
	}
}

func TestImageProviderQueryUsesFixedPathAndBodylessScriptEnvelope(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.EscapedPath() != "/v1/jobs/job%2Fid%201%3Fx" || r.URL.Query().Get("full") != "true" || r.Header.Get("X-Detail") != "yes" {
			t.Errorf("incorrect query %s %s", r.Method, r.URL)
		}
		body, _ := io.ReadAll(r.Body)
		if len(body) != 0 {
			t.Error("query sent a body")
		}
		_, _ = io.WriteString(w, `{"status":"processing","taskId":"job/id 1?x"}`)
	}))
	defer upstream.Close()
	runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input scriptRuntimeRequest
		_ = json.NewDecoder(r.Body).Decode(&input)
		if input.Operation != "images.edit.query" || input.Input.(map[string]any)["body"] != nil {
			t.Error("wrong query script input")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"output": map[string]any{"query": map[string]any{"full": true}, "headers": map[string]any{"X-Detail": "yes"}}}})
	}))
	defer runtime.Close()
	b := &backend{config: config{scriptRuntimeURL: runtime.URL}}
	cfg := providerConfig{baseURL: upstream.URL + "/v1", apiKey: "secret", operations: map[string]any{"images.edit.query": map[string]any{"path": "/jobs/{task_id}", "requestScript": "return request;"}}}
	result, err := b.queryImageProvider(context.Background(), cfg, "images.edit.query", "job/id 1?x", "model")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := inspectImageProviderResult(result, "other-task"); err == nil {
		t.Fatal("query task identity change accepted")
	}
}

func TestImageProviderExecutorRequestsAndConsumesSSE(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["stream"] != true || body["partial_images"] != float64(2) {
			t.Error("stream settings omitted")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "event: image_generation.partial_image\ndata: {\"partial_image_b64\":\"cGFydGlhbA==\"}\n\nevent: image_generation.completed\ndata: {\"b64_json\":\"ZmluYWw=\"}\n\ndata: [DONE]\n\n")
	}))
	defer server.Close()
	b := &backend{}
	cfg := providerConfig{baseURL: server.URL, apiKey: "secret", adapter: map[string]any{"useStream": true}}
	operation, body, err := b.prepareImageProviderInput(context.Background(), cfg, "user", "generate", "model", map[string]any{"prompt": "prompt"})
	if err != nil {
		t.Fatal(err)
	}
	result, err := b.callProvider(context.Background(), cfg, operation, body, "task", "model")
	if err != nil {
		t.Fatal(err)
	}
	data, _, err := readImageProviderOutput(context.Background(), result)
	if err != nil || string(data) != "final" {
		t.Fatalf("SSE executor failed: %s %v", data, err)
	}
}

func TestImageProviderScriptResultMatchesStrictContract(t *testing.T) {
	for _, test := range []struct {
		name, operation, result string
		fail                    bool
	}{
		{"accepted", "images.generate", `{"status":"pending","taskId":"job","pollAfterSeconds":12}`, false},
		{"query without ID", "images.generate.query", `{"status":"processing","progress":50}`, false},
		{"failed", "images.generate.query", `{"status":"failed","error":{"category":"rate_limit","code":"provider_busy"}}`, false},
		{"base64 with MIME", "images.edit", `{"status":"completed","outputs":[{"kind":"image","base64":"b3V0cHV0","mediaType":"image/png"}]}`, false},
		{"unknown result property", "images.generate", `{"status":"pending","taskId":"job","poll_url":"https://example.com"}`, true},
		{"changed task", "images.generate.query", `{"status":"pending","taskId":"other"}`, true},
		{"missing ID", "images.generate", `{"status":"pending"}`, true},
		{"invalid progress", "images.generate.query", `{"status":"pending","progress":"50"}`, true},
		{"fractional poll delay", "images.generate.query", `{"status":"pending","pollAfterSeconds":1.5}`, true},
		{"missing failure", "images.generate", `{"status":"failed"}`, true},
		{"invalid failure category", "images.generate", `{"status":"failed","error":{"category":"invented","code":"error"}}`, true},
		{"unsafe failure code", "images.generate", `{"status":"failed","error":{"category":"upstream","code":"secret details"}}`, true},
		{"retrying accepted task", "images.generate.query", `{"status":"failed","error":{"category":"upstream","code":"error"},"retryable":true}`, true},
		{"wrong media type", "images.generate", `{"status":"completed","outputs":[{"kind":"video","url":"https://example.com/a.mp4"}]}`, true},
		{"two output locations", "images.generate", `{"status":"completed","outputs":[{"kind":"image","url":"https://example.com/a.png","base64":"b3V0cHV0"}]}`, true},
		{"local output", "images.generate", `{"status":"completed","outputs":[{"kind":"image","url":"file:///etc/passwd"}]}`, true},
		{"MIME on URL", "images.generate", `{"status":"completed","outputs":[{"kind":"image","url":"https://example.com/a.png","mediaType":"image/png"}]}`, true},
		{"unknown output property", "images.generate", `{"status":"completed","outputs":[{"kind":"image","base64":"b3V0cHV0","extra":true}]}`, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			var result map[string]any
			if err := json.Unmarshal([]byte(test.result), &result); err != nil {
				t.Fatal(err)
			}
			err := validateImageProviderScriptResult(result, test.operation, "job")
			if (err != nil) != test.fail {
				t.Fatalf("unexpected validation: %v", err)
			}
		})
	}
}

func TestImageProviderOutputPreservesLargePayloadAndMediaType(t *testing.T) {
	data := bytes.Repeat([]byte{42}, 17<<20)
	result := map[string]any{"outputs": []any{map[string]any{"kind": "image", "base64": base64.StdEncoding.EncodeToString(data), "mediaType": "image/png"}}}
	got, mediaType, err := readImageProviderOutput(context.Background(), result)
	if err != nil || !bytes.Equal(data, got) || mediaType != "image/png" {
		t.Fatalf("large image contract changed: bytes=%d MIME=%s error=%v", len(got), mediaType, err)
	}
}
