//go:build integration

package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestScriptRuntimeAdminDiagnosticsForwardsPrivateRuntimeSnapshot(t *testing.T) {
	b := integrationBackend(t)
	_, admin := paymentReadAdmin(t, b)
	_, email := seedAuthUser(t, b)
	user := signInTestUser(t, b, email)
	var calls atomic.Int32
	var offline atomic.Bool
	runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != "GET" || r.URL.Path != "/v1/diagnostics" || r.Header.Get("Authorization") != "Bearer diagnostics-private" {
			t.Error("invalid private diagnostics request")
		}
		if offline.Load() {
			w.WriteHeader(503)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": scriptRuntimeDiagnostics{Lifecycle: "ready", WorkerCount: 4, LiveWorkerCount: 3, RequestQueueLength: 5, ResponseQueueLength: 2, ResponsePermitsInUse: 7, ResponsePermitCapacity: 64, SaturationCount: 13, ReplacementCount: 8}})
	}))
	defer runtime.Close()
	b.config.scriptRuntimeURL = runtime.URL
	b.config.scriptRuntimeToken = "diagnostics-private"
	const path = "/api/admin/image-backend/script-runtime/diagnostics"
	requireCreditResponse(t, authRequest(t, b, "GET", path, ""), 401)
	requireCreditResponse(t, authRequest(t, b, "GET", path, "", user), 403)
	if calls.Load() != 0 {
		t.Fatal("unauthorized request reached private diagnostics")
	}
	out := requireCreditResponse(t, authRequest(t, b, "GET", path, "", admin), 200)
	if out["workerCount"] != float64(4) || out["liveWorkerCount"] != float64(3) || out["requestQueueLength"] != float64(5) || out["responseQueueLength"] != float64(2) || out["responsePermitsInUse"] != float64(7) || out["saturationCount"] != float64(13) || out["replacementCount"] != float64(8) || len(out) != 9 {
		t.Fatalf("not the live runtime snapshot: %v", out)
	}
	offline.Store(true)
	out = requireCreditResponse(t, authRequest(t, b, "GET", path, "", admin), 503)
	if out["lifecycle"] != nil {
		t.Fatal("runtime failure fabricated a healthy diagnostic snapshot")
	}
	b.config.scriptRuntimeURL = ""
	requireCreditResponse(t, authRequest(t, b, "GET", path, "", admin), 503)
}
