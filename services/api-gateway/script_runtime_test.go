package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestScriptRuntimeClientUsesPrivateJSONContract(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/execute" || r.Method != http.MethodPost {
			t.Fatalf("unexpected runtime request: %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer runtime-secret" {
			t.Fatal("runtime authorization header missing")
		}
		var input scriptRuntimeRequest
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			t.Fatal(err)
		}
		if input.Operation != "images.generate" || input.Stage != "request" {
			t.Fatalf("unexpected script invocation: %+v", input)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"output":{"body":{"ok":true}}}}`))
	}))
	defer server.Close()

	client := newScriptRuntimeClient(server.URL, "runtime-secret")
	output, err := client.execute(context.Background(), scriptRuntimeRequest{
		Script: "return input;", Operation: "images.generate", Stage: "request",
		Input:   map[string]any{"body": map[string]any{"prompt": "test"}},
		Context: map[string]any{"platformModelId": "model"},
	})
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(output, &decoded); err != nil || decoded["body"] == nil {
		t.Fatalf("unexpected runtime output: %s", output)
	}
}

func TestScriptRuntimeClientReady(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/healthz" {
			t.Fatalf("unexpected health path: %s", r.URL.Path)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	if err := newScriptRuntimeClient(server.URL, "").ready(context.Background()); err != nil {
		t.Fatal(err)
	}
}
