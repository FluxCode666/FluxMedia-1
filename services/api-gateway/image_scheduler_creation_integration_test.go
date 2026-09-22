//go:build integration

package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestImageCreationAndWorkerUseConfiguredSchedulingStrategy(t *testing.T) {
	for _, scenario := range []struct {
		name, strategy string
		wantA          bool
	}{
		{"priority", "priority", true},
		{"least acquired", "least_acquired", false},
		{"least load ratio", "least_load", true},
		{"available member first", "priority", false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			b := integrationBackend(t)
			ctx := context.Background()
			uid, _ := seedAuthUser(t, b)
			model := "scheduler-create-" + newRequestID()
			b.config.storagePath = t.TempDir()
			setStorageTestSetting(t, b, "STORAGE_ENDPOINT", "")
			setStorageTestSetting(t, b, "STORAGE_GENERATIONS_BUCKET", "generations")
			setStorageTestSetting(t, b, "CONTENT_MODERATION_ENABLED", false)
			setStorageTestSetting(t, b, "IMAGE_BACKEND_SCHEDULING_STRATEGY", scenario.strategy)
			seedImagePricingSettings(t, b, model)
			creditTestWallet(t, b, uid, 100)
			creditTestBatch(t, b, uid, "purchase", 100, nil)
			var callsA, callsB atomic.Int32
			provider := func(calls *atomic.Int32) *httptest.Server {
				return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls.Add(1)
					if r.URL.Path != "/generate" || r.Method != "POST" {
						t.Errorf("unexpected provider request %s %s", r.Method, r.URL.Path)
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]any{"b64_json": "b3V0cHV0"}}})
				}))
			}
			aServer, bServer := provider(&callsA), provider(&callsB)
			defer aServer.Close()
			defer bServer.Close()
			group := seedImagePricingGroup(t, b, true, nil, nil)
			a := seedImagePricingMember(t, b, group, model, aServer.URL, false, 1)
			second := seedImagePricingMember(t, b, group, model, bServer.URL, false, 10)
			opsFixtureExec(t, b, `UPDATE image_backend_member SET lease_acquired_count=100 WHERE id=$1`, a)
			if scenario.strategy == "least_load" {
				// A has more active requests but a lower utilization ratio than B.
				opsFixtureExec(t, b, `UPDATE image_backend_member SET concurrency=100,priority=10 WHERE id=$1`, a)
				opsFixtureExec(t, b, `UPDATE image_backend_member SET concurrency=2,priority=1 WHERE id=$1`, second)
				for _, member := range []string{a, a, second} {
					opsFixtureExec(t, b, `INSERT INTO image_backend_member_lease(id,member_id,owner_token,expires_at) VALUES($1,$2,'other-work',now()+interval '5 minutes')`, newRequestID(), member)
				}
			} else if scenario.name == "available member first" {
				opsFixtureExec(t, b, `UPDATE image_backend_member SET concurrency=1 WHERE id=$1`, a)
				opsFixtureExec(t, b, `INSERT INTO image_backend_member_lease(id,member_id,owner_token,expires_at) VALUES($1,$2,'other-work',now()+interval '5 minutes')`, newRequestID(), a)
			}
			task, err := b.createImageTask(httptest.NewRequest("POST", "http://localhost/api/images/generate", nil), &apiPrincipal{UserID: uid}, imagePricingInput(map[string]any{"model": model, "prompt": "actual scheduler admission", "backendGroupId": group, "resolution": "1k"}), "generate")
			if err != nil {
				t.Fatal(err)
			}
			id, generation := stringValue(task["id"]), stringValue(task["generationId"])
			want := second
			if scenario.wantA {
				want = a
			}
			var selected string
			if err = b.db.QueryRow(ctx, `SELECT metadata#>>'{billingSnapshot,providerMemberId}' FROM generation WHERE id=$1`, generation).Scan(&selected); err != nil || selected != want {
				t.Fatalf("admission member=%s want=%s err=%v", selected, want, err)
			}
			worker := mediaWorker{backend: b}
			if err = worker.processImage(ctx, id); err != nil {
				t.Fatal(err)
			}
			if err = worker.processImage(ctx, id); err != nil {
				t.Fatal(err)
			}
			var status string
			if err = b.db.QueryRow(ctx, `SELECT status,api_adapter_member_id FROM generation WHERE id=$1`, generation).Scan(&status, &selected); err != nil || status != "completed" || selected != want {
				t.Fatalf("worker status=%s member=%s err=%v", status, selected, err)
			}
			if scenario.wantA && (callsA.Load() != 1 || callsB.Load() != 0) || !scenario.wantA && (callsA.Load() != 0 || callsB.Load() != 1) {
				t.Fatalf("provider calls A=%d B=%d", callsA.Load(), callsB.Load())
			}
			var success int
			if err = b.db.QueryRow(ctx, `SELECT success_count FROM image_backend_member WHERE id=$1`, want).Scan(&success); err != nil || success != 1 {
				t.Fatalf("successful member counter=%d err=%v", success, err)
			}
		})
	}
}
