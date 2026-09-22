package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func TestProviderResponsePermitSurroundsActualProviderRequest(t *testing.T) {
	for _, operation := range []string{"images.generate", "images.edit", "images.generate.query", "images.edit.query", "videos.generate", "videos.query"} {
		for _, scenario := range []string{"success", "saturated", "script_failed", "cancelled"} {
			t.Run(operation+"/"+scenario, func(t *testing.T) {
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				var mu sync.Mutex
				events := []string{}
				active := false
				record := func(event string) {
					mu.Lock()
					defer mu.Unlock()
					events = append(events, event)
				}
				const permit = "66b3b4f7-bff2-4b2e-9f03-5b5512b077a5"
				runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.Header.Get("Authorization") != "Bearer private-runtime" {
						t.Error("runtime request omitted its private credential")
					}
					switch r.Method + " " + r.URL.Path {
					case "POST /v1/response-permits":
						record("reserve")
						if scenario == "saturated" {
							w.Header().Set("Retry-After", "3")
							w.WriteHeader(http.StatusServiceUnavailable)
							return
						}
						mu.Lock()
						active = true
						mu.Unlock()
						_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"id": permit}})
					case "POST /v1/execute":
						record("response")
						var request scriptRuntimeRequest
						if json.NewDecoder(r.Body).Decode(&request) != nil || request.ResponsePermitID != permit || request.Stage != "response" || request.Operation != operation {
							t.Error("response adaptation did not use the reserved permit")
						}
						content, _ := json.Marshal([]any{request.Input, request.Context})
						if strings.Contains(string(content), permit) {
							t.Error("permit leaked into script-visible data")
						}
						if scenario == "script_failed" {
							w.WriteHeader(http.StatusUnprocessableEntity)
							_, _ = io.WriteString(w, `{"error":{"code":"SCRIPT_EXECUTION_FAILED","message":"Script execution failed"}}`)
							return
						}
						_, _ = io.WriteString(w, `{"data":{"output":{"status":"processing","taskId":"provider-task"}}}`)
					case "DELETE /v1/response-permits/" + permit:
						record("release")
						mu.Lock()
						active = false
						mu.Unlock()
						w.WriteHeader(http.StatusNoContent)
					default:
						t.Errorf("unexpected runtime endpoint %s %s", r.Method, r.URL.Path)
						w.WriteHeader(404)
					}
				}))
				defer runtime.Close()
				provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					record("provider")
					mu.Lock()
					reserved := active
					mu.Unlock()
					if !reserved {
						t.Error("provider contacted without reserved response capacity")
					}
					body, _ := io.ReadAll(r.Body)
					if strings.Contains(string(body), permit) || strings.Contains(r.Header.Get("Authorization"), "private-runtime") || strings.Contains(r.URL.String(), permit) {
						t.Error("private runtime data leaked to provider")
					}
					if scenario == "cancelled" {
						cancel()
						<-r.Context().Done()
						return
					}
					w.Header().Set("Content-Type", "application/json")
					_, _ = io.WriteString(w, `{"status":"processing","taskId":"provider-task"}`)
				}))
				defer provider.Close()
				cfg := providerConfig{baseURL: provider.URL, apiKey: "provider-key", operations: map[string]any{operation: map[string]any{"path": "/jobs/{task_id}", "responseScript": "return input.body;"}}}
				b := &backend{config: config{scriptRuntimeURL: runtime.URL, scriptRuntimeToken: "private-runtime"}}
				var err error
				if strings.HasPrefix(operation, "videos.") {
					ctx = context.WithValue(ctx, videoBeforeSendContextKey{}, func() error { record("before-send"); return nil })
					_, err = b.executeVideoProvider(ctx, cfg, operation, provider.URL+"/jobs/provider-task", map[string]any{"model": "model"}, "provider-task", "model")
				} else if strings.HasSuffix(operation, ".query") {
					_, err = b.queryImageProvider(ctx, cfg, operation, "provider-task", "model")
				} else {
					cfg.operations[operation].(map[string]any)["path"] = "/jobs"
					_, err = b.callImageProvider(ctx, cfg, operation, map[string]any{"model": "model"}, "provider-task", "model")
				}
				if (err == nil) != (scenario == "success") {
					t.Fatalf("scenario %s error = %v", scenario, err)
				}
				want := []string{"reserve"}
				if scenario != "saturated" {
					if operation == "videos.generate" {
						want = append(want, "before-send")
					}
					want = append(want, "provider")
					if scenario != "cancelled" {
						want = append(want, "response")
					}
					want = append(want, "release")
				} else {
					var busy *scriptRuntimeUnavailableError
					if !errors.As(err, &busy) {
						t.Errorf("capacity failure was not classified as platform unavailability: %v", err)
					}
				}
				mu.Lock()
				defer mu.Unlock()
				if !reflect.DeepEqual(events, want) || active {
					t.Errorf("events=%v active=%v, want=%v and released permit", events, active, want)
				}
			})
		}
	}
}

func TestProviderResponsePermitIsNotRequiredWithoutScript(t *testing.T) {
	b := &backend{}
	for _, cfg := range []providerConfig{
		{},
		{adapter: map[string]any{"videoProtocolMode": "gemini"}, operations: map[string]any{"videos.generate": map[string]any{"responseScript": "ignored"}}},
		{adapter: map[string]any{"videoProtocolMode": "seedance"}, operations: map[string]any{"videos.generate": map[string]any{"responseScript": "ignored"}}},
	} {
		ctx, release, err := b.reserveProviderResponse(context.Background(), cfg, "videos.generate")
		if err != nil || providerResponsePermitID(ctx) != "" || release == nil {
			t.Fatalf("built-in provider unexpectedly needs script runtime: %v", err)
		}
		release()
	}
}
