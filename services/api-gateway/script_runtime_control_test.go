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
	"sync/atomic"
	"testing"
)

func TestScriptRuntimeDiagnosticsUsesAuthenticatedLiveSnapshot(t *testing.T) {
	want := scriptRuntimeDiagnostics{Lifecycle: "ready", WorkerCount: 3, LiveWorkerCount: 2, RequestQueueLength: 11, ResponseQueueLength: 4, ResponsePermitsInUse: 7, ResponsePermitCapacity: 48, SaturationCount: 9, ReplacementCount: 6}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/diagnostics" || r.Header.Get("Authorization") != "Bearer private-token" {
			t.Errorf("unexpected runtime request: %s %s", r.Method, r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": want})
	}))
	defer server.Close()
	got, err := newScriptRuntimeClient(server.URL, "private-token").diagnostics(context.Background())
	if err != nil || !reflect.DeepEqual(got, &want) {
		t.Fatalf("diagnostics=%+v err=%v", got, err)
	}
}

func TestScriptRuntimeDiagnosticsRejectsUntrustworthySnapshots(t *testing.T) {
	valid := `{"lifecycle":"ready","workerCount":1,"liveWorkerCount":1,"requestQueueLength":0,"responseQueueLength":0,"responsePermitsInUse":0,"responsePermitCapacity":16,"saturationCount":0,"replacementCount":0}`
	for _, body := range []string{
		`{"status":"ok","workers":1}`,
		`{"data":{}}`,
		`{"data":null}`,
		`{"data":` + strings.Replace(valid, `"saturationCount":0`, `"saturationCount":-1`, 1) + `}`,
		`{"data":` + strings.Replace(valid, `"workerCount":1`, `"workerCount":null`, 1) + `}`,
		`{"data":` + strings.Replace(valid, `"responsePermitsInUse":0`, `"responsePermitsInUse":17`, 1) + `}`,
		`{"data":` + strings.Replace(valid, `"lifecycle":"ready"`, `"lifecycle":"secret-stack"`, 1) + `}`,
		`{"data":` + valid + `}garbage`,
		strings.Repeat("x", 8193),
	} {
		t.Run(body[:min(65, len(body))], func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, body) }))
			defer server.Close()
			if _, err := newScriptRuntimeClient(server.URL, "").diagnostics(context.Background()); err == nil {
				t.Fatal("invalid snapshot accepted")
			}
		})
	}
}

func TestScriptRuntimePrivateControlsDoNotForwardTokenThroughRedirect(t *testing.T) {
	var called atomic.Bool
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called.Store(true) }))
	defer destination.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL, http.StatusTemporaryRedirect)
	}))
	defer server.Close()
	_, err := newScriptRuntimeClient(server.URL, "private-token").reserveResponse(context.Background())
	var unavailable *scriptRuntimeUnavailableError
	if called.Load() || !errors.As(err, &unavailable) {
		t.Fatalf("redirect followed=%v err=%v", called.Load(), err)
	}
}
