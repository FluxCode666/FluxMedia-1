//go:build integration

package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func schedulerImageTask(t *testing.T, b *backend, user, model string, cfg providerConfig) (string, context.Context) {
	t.Helper()
	id, generation := seedModerationImageTask(t, b, user, model, nil)
	token := newWorkerToken()
	opsFixtureExec(t, b, `UPDATE image_async_task SET claim_token=$2,claim_expires_at=now()+interval '5 minutes' WHERE id=$1`, id, token)
	opsFixtureExec(t, b, `UPDATE generation SET api_adapter_member_id=$2,api_adapter_version_id=$3 WHERE id=$1`, generation, cfg.memberID, cfg.versionID)
	return id, context.WithValue(context.Background(), imageWorkerClaimKey{}, token)
}

func schedulerCounts(t *testing.T, b *backend, member string) (int, int, int, string) {
	t.Helper()
	var acquired, success, failed int
	var health string
	if err := b.db.QueryRow(context.Background(), `SELECT lease_acquired_count,success_count,fail_count,health_status FROM image_backend_member WHERE id=$1`, member).Scan(&acquired, &success, &failed, &health); err != nil {
		t.Fatal(err)
	}
	return acquired, success, failed, health
}

func TestMediaSchedulerLeaseReceiptSurvivesConcurrentRenewalAndRollback(t *testing.T) {
	b := integrationBackend(t)
	ctx := context.Background()
	user, _ := seedAuthUser(t, b)
	group := seedImagePricingGroup(t, b, true, nil, nil)
	model := "scheduler-" + newRequestID()
	member := seedImagePricingMember(t, b, group, model, "https://provider.example", false, 1)
	opsFixtureExec(t, b, `UPDATE image_backend_member SET concurrency=1 WHERE id=$1`, member)
	cfg, err := b.pickImageProvider(ctx, model, imageGroupSnapshot{ID: group}, member, false)
	if err != nil {
		t.Fatal(err)
	}
	id, claim := schedulerImageTask(t, b, user, model, cfg)
	if err := b.acquireImageProviderLease(context.WithValue(ctx, imageWorkerClaimKey{}, "stale"), id, cfg); !errors.Is(err, errImageClaimLost) {
		t.Fatalf("stale worker acquired lease: %v", err)
	}
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := b.acquireImageProviderLease(claim, id, cfg); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if a, s, f, _ := schedulerCounts(t, b, member); a != 1 || s != 0 || f != 0 {
		t.Fatalf("renewal counted as work: %d/%d/%d", a, s, f)
	}
	blocked, blockedClaim := schedulerImageTask(t, b, user, model, cfg)
	if err = b.acquireImageProviderLease(blockedClaim, blocked, cfg); !errors.Is(err, errImageProviderCapacity) {
		t.Fatalf("capacity: %v", err)
	}
	if a, _, _, _ := schedulerCounts(t, b, member); a != 1 {
		t.Fatal("rejection incremented leases")
	}
	opsFixtureExec(t, b, `UPDATE image_backend_member_lease SET expires_at=now()-interval '1 second' WHERE member_id=$1`, member)
	if err = b.acquireImageProviderLease(claim, id, cfg); err != nil {
		t.Fatal(err)
	}
	if a, _, _, _ := schedulerCounts(t, b, member); a != 1 {
		t.Fatal("expired recovery incremented leases")
	}
	var acquired, rejected int
	if err = b.db.QueryRow(ctx, `SELECT COALESCE(sum(event_count) FILTER(WHERE outcome='acquired'),0),COALESCE(sum(event_count) FILTER(WHERE outcome='capacity_rejected'),0) FROM image_backend_member_scheduler_metric WHERE group_id=$1`, group).Scan(&acquired, &rejected); err != nil {
		t.Fatal(err)
	}
	if acquired != 1 || rejected != 1 {
		t.Fatalf("metrics=%d/%d", acquired, rejected)
	}
	// A failed metric write must roll back both the capacity lease and the
	// idempotency receipt; retry can then commit precisely once.
	opsFixtureExec(t, b, `DELETE FROM image_backend_member_lease WHERE member_id=$1`, member)
	opsFixtureExec(t, b, `CREATE FUNCTION scheduler_reject_metric() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''scheduler test rejection''; END'`)
	opsFixtureExec(t, b, `CREATE TRIGGER scheduler_reject_metric BEFORE INSERT ON image_backend_member_scheduler_metric FOR EACH ROW EXECUTE FUNCTION scheduler_reject_metric()`)
	err = b.acquireImageProviderLease(blockedClaim, blocked, cfg)
	opsFixtureExec(t, b, `DROP TRIGGER scheduler_reject_metric ON image_backend_member_scheduler_metric`)
	opsFixtureExec(t, b, `DROP FUNCTION scheduler_reject_metric()`)
	if err == nil {
		t.Fatal("injected metric failure accepted lease")
	}
	var n int
	if err = b.db.QueryRow(ctx, `SELECT count(*) FROM image_backend_member_lease WHERE id=$1`, "go-image:"+blocked).Scan(&n); err != nil || n != 0 {
		t.Fatalf("lease survived rollback: %d %v", n, err)
	}
	if err = b.acquireImageProviderLease(blockedClaim, blocked, cfg); err != nil {
		t.Fatal(err)
	}
	if a, _, _, _ := schedulerCounts(t, b, member); a != 2 {
		t.Fatalf("receipt survived rollback: %d", a)
	}
}

func TestMediaSchedulerHealthAndTerminalMetricsAreTransactional(t *testing.T) {
	b := integrationBackend(t)
	ctx := context.Background()
	user, _ := seedAuthUser(t, b)
	group := seedImagePricingGroup(t, b, true, nil, nil)
	model := "scheduler-" + newRequestID()
	member := seedImagePricingMember(t, b, group, model, "https://provider.example", false, 1)
	cfg, err := b.pickImageProvider(ctx, model, imageGroupSnapshot{ID: group}, member, false)
	if err != nil {
		t.Fatal(err)
	}
	opsFixtureExec(t, b, `UPDATE image_backend_member SET failure_cooldown_enabled=true WHERE id=$1`, member)
	for i := 0; i < 3; i++ {
		id, claim := schedulerImageTask(t, b, user, model, cfg)
		if err = b.acquireImageProviderLease(claim, id, cfg); err != nil {
			t.Fatal(err)
		}
		tx, e := b.db.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		if e = mediaSchedulerResultTx(ctx, tx, "image", id, member, false, errors.New("secret upstream failure https://private.example?key=credential"), true); e != nil {
			rollback(tx)
			t.Fatal(e)
		}
		if i == 0 {
			rollback(tx)
			if _, _, f, _ := schedulerCounts(t, b, member); f != 0 {
				t.Fatal("health changed despite rollback")
			}
			tx, e = b.db.Begin(ctx)
			if e != nil {
				t.Fatal(e)
			}
			if e = mediaSchedulerResultTx(ctx, tx, "image", id, member, false, errors.New("upstream failure"), true); e != nil {
				rollback(tx)
				t.Fatal(e)
			}
		}
		if e = tx.Commit(ctx); e != nil {
			t.Fatal(e)
		}
		// Replaying the result must not change either metric or health state.
		tx, e = b.db.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		if e = mediaSchedulerResultTx(ctx, tx, "image", id, member, false, errors.New("upstream failure"), true); e != nil {
			rollback(tx)
			t.Fatal(e)
		}
		if e = tx.Commit(ctx); e != nil {
			t.Fatal(e)
		}
	}
	if a, s, f, h := schedulerCounts(t, b, member); a != 3 || s != 0 || f != 3 || h != "unhealthy" {
		t.Fatalf("health=%d/%d/%d/%s", a, s, f, h)
	}
	var status, lastError string
	var cooling bool
	if err = b.db.QueryRow(ctx, `SELECT status,cooldown_until>now(),last_error FROM image_backend_member WHERE id=$1`, member).Scan(&status, &cooling, &lastError); err != nil {
		t.Fatal(err)
	}
	if status != "limited" || !cooling || lastError != "媒体上游调用失败" {
		t.Fatalf("cooldown/redaction %s %v %q", status, cooling, lastError)
	}
	for _, cause := range []error{&scriptRuntimeUnavailableError{}, &apiError{422, "CONTENT_MODERATION_BLOCKED", "blocked"}, &videoProviderError{code: "invalid_request", terminal: true}} {
		id, claim := schedulerImageTask(t, b, user, model, cfg)
		if err = b.acquireImageProviderLease(claim, id, cfg); err != nil {
			t.Fatal(err)
		}
		tx, e := b.db.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		if e = mediaSchedulerResultTx(ctx, tx, "image", id, member, false, cause, true); e != nil {
			rollback(tx)
			t.Fatal(e)
		}
		if e = tx.Commit(ctx); e != nil {
			t.Fatal(e)
		}
	}
	if _, _, f, _ := schedulerCounts(t, b, member); f != 3 {
		t.Fatal("platform/user failures penalized provider")
	}
	id, claim := schedulerImageTask(t, b, user, model, cfg)
	if err = b.acquireImageProviderLease(claim, id, cfg); err != nil {
		t.Fatal(err)
	}
	tx, err := b.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err = mediaSchedulerResultTx(ctx, tx, "image", id, member, true, nil); err != nil {
		rollback(tx)
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if _, s, f, h := schedulerCounts(t, b, member); s != 1 || f != 3 || h != "healthy" {
		t.Fatalf("success recovery=%d/%d/%s", s, f, h)
	}
	var reset bool
	if err = b.db.QueryRow(ctx, `SELECT status='active' AND cooldown_until IS NULL AND fail_streak=0 AND success_streak=1 AND last_error IS NULL AND last_acquired_at IS NOT NULL AND last_used_at IS NOT NULL FROM image_backend_member WHERE id=$1`, member).Scan(&reset); err != nil || !reset {
		t.Fatalf("success reset=%v %v", reset, err)
	}
	stats, err := b.adminBackendStats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if stats["successCount"] != int64(1) || stats["failCount"] != int64(3) {
		t.Fatalf("admin counters did not read actual outcomes: %+v", stats)
	}
}

func TestMediaSchedulerUsesConfiguredStrategiesAndLiveLeaseLoad(t *testing.T) {
	b := integrationBackend(t)
	ctx := context.Background()
	group := seedImagePricingGroup(t, b, true, nil, nil)
	model := "scheduler-" + newRequestID()
	a := seedImagePricingMember(t, b, group, model, "https://a.example", false, 1)
	z := seedImagePricingMember(t, b, group, model, "https://z.example", false, 5)
	opsFixtureExec(t, b, `UPDATE image_backend_member SET lease_acquired_count=10 WHERE id=$1`, a)
	for _, s := range []struct{ strategy, want string }{{"priority", a}, {"least_acquired", z}, {"invalid", a}} {
		setStorageTestSetting(t, b, "IMAGE_BACKEND_SCHEDULING_STRATEGY", s.strategy)
		cfg, err := b.pickImageProvider(ctx, model, imageGroupSnapshot{ID: group}, "", false)
		if err != nil || cfg.memberID != s.want {
			t.Fatalf("%s chose %s: %v", s.strategy, cfg.memberID, err)
		}
	}
	setStorageTestSetting(t, b, "IMAGE_BACKEND_SCHEDULING_STRATEGY", "least_load")
	opsFixtureExec(t, b, `INSERT INTO image_backend_member_lease(id,member_id,owner_token,expires_at) VALUES($1,$2,'load',now()+interval '1 minute')`, newRequestID(), a)
	cfg, err := b.pickImageProvider(ctx, model, imageGroupSnapshot{ID: group}, "", false)
	if err != nil || cfg.memberID != z {
		t.Fatalf("least_load chose %s: %v", cfg.memberID, err)
	}
	// The fixed provider of accepted work keeps its identity despite load.
	cfg, err = b.pickImageProvider(ctx, model, imageGroupSnapshot{ID: group}, a, false)
	if err != nil || cfg.memberID != a {
		t.Fatalf("pinned selection changed: %v", err)
	}
}

func TestMediaSchedulerRealVideoWorkerTracksSelectionFailureAndRecovery(t *testing.T) {
	b := integrationBackend(t)
	ctx := context.Background()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, `{"error":"temporary"}`, 500) }))
	defer server.Close()
	f := seedVideoWorkerFixture(t, b, server.URL, 0)
	opsFixtureExec(t, b, `UPDATE image_backend_member SET failure_cooldown_enabled=true WHERE id=$1`, f.member)
	id := seedVideoWorkerTask(t, b, f)
	baseline, _, err := b.adminSchedulerStats(ctx, time.Now().UTC().Add(-time.Hour), time.Now().UTC().Add(-24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	worker := mediaWorker{backend: b}
	if err := worker.processDurableVideo(ctx, id); err != nil {
		t.Fatal(err)
	}
	if a, s, failed, h := schedulerCounts(t, b, f.member); a != 1 || s != 0 || failed != 1 || h != "degraded" {
		t.Fatalf("actual worker health=%d/%d/%d/%s", a, s, failed, h)
	}
	if err := worker.processDurableVideo(ctx, id); err != nil {
		t.Fatal(err)
	}
	if a, _, failed, _ := schedulerCounts(t, b, f.member); a != 1 || failed != 1 {
		t.Fatalf("recovery double counted=%d/%d", a, failed)
	}
	stats, _, err := b.adminSchedulerStats(ctx, time.Now().UTC().Add(-time.Hour), time.Now().UTC().Add(-24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if stats["acquiredCount"].(int64)-baseline["acquiredCount"].(int64) != 1 || stats["noCandidateCount"].(int64)-baseline["noCandidateCount"].(int64) != 1 {
		t.Fatalf("live scheduler metrics=%+v", stats)
	}
}

func TestMediaSchedulerRealImageWorkerReportsFinalOutcomeOnce(t *testing.T) {
	for _, succeed := range []bool{true, false} {
		t.Run(map[bool]string{true: "success", false: "failure"}[succeed], func(t *testing.T) {
			b := integrationBackend(t)
			ctx := context.Background()
			user, _ := seedAuthUser(t, b)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if !succeed {
					http.Error(w, "upstream failure", 500)
					return
				}
				_, _ = io.WriteString(w, `{"data":[{"b64_json":"b3V0cHV0"}]}`)
			}))
			defer server.Close()
			configureModerationIntegration(t, b, server.URL)
			setStorageTestSetting(t, b, "CONTENT_MODERATION_ENABLED", false)
			model := seedModerationProvider(t, b, server.URL, true)
			var member string
			if err := b.db.QueryRow(ctx, `SELECT id FROM image_backend_member WHERE supported_model_ids::jsonb @> jsonb_build_array($1::text)`, model).Scan(&member); err != nil {
				t.Fatal(err)
			}
			id, generation := seedModerationImageTask(t, b, user, model, nil)
			body := map[string]any{"model": model, "prompt": "prompt", "generationId": generation, "operation": "generate"}
			opsFixtureExec(t, b, `UPDATE image_async_task SET generation_id=NULL,generation_input=NULL,input_digest=NULL,operation='generate',generation_inputs=$2 WHERE id=$1`, id, mustJSON([]any{body}))
			worker := mediaWorker{backend: b}
			if err := worker.processImage(ctx, id); err != nil {
				t.Fatal(err)
			}
			if err := worker.processImage(ctx, id); err != nil {
				t.Fatal(err)
			}
			a, success, failed, _ := schedulerCounts(t, b, member)
			if a != 1 || succeed && (success != 1 || failed != 0) || !succeed && (success != 0 || failed != 1) {
				t.Fatalf("worker counters=%d/%d/%d", a, success, failed)
			}
		})
	}
}

func TestMediaSchedulerRepairStepsUseIndependentReceiptsAndRealStrategy(t *testing.T) {
	b := integrationBackend(t)
	ctx := context.Background()
	user, _ := seedAuthUser(t, b)
	b.config.storagePath = t.TempDir()
	setStorageTestSetting(t, b, "STORAGE_ENDPOINT", "")
	setStorageTestSetting(t, b, "GENERATIONS_BUCKET_NAME", "generations")
	setStorageTestSetting(t, b, "CONTENT_MODERATION_ENABLED", false)
	seedImagePricingSettings(t, b, "gpt-image-2")
	creditTestWallet(t, b, user, 100)
	creditTestBatch(t, b, user, "purchase", 100, nil)
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 3 {
			http.Error(w, "provider failed", 500)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]any{"b64_json": base64.StdEncoding.EncodeToString([]byte("repaired output"))}}})
	}))
	defer server.Close()
	group := seedImagePricingGroup(t, b, true, nil, nil)
	a := seedImagePricingMember(t, b, group, "gpt-image-2", server.URL, false, 1)
	z := seedImagePricingMember(t, b, group, "gpt-image-2", server.URL, false, 5)
	adapter := map[string]any{"baseUrl": server.URL, "operations": map[string]any{"images.generate": map[string]any{"path": "/generate"}, "images.edit": map[string]any{"path": "/edit"}}}
	for _, member := range []string{a, z} {
		opsFixtureExec(t, b, `UPDATE image_backend_member_api_adapter_version SET configuration=$2 WHERE member_id_snapshot=$1`, member, mustJSON(adapter))
	}
	input := imagePricingInput(map[string]any{"model": "gpt-image-2", "prompt": "repair test", "backendGroupId": group, "resolution": "1k"})
	task, err := b.createImageTask(httptest.NewRequest("POST", "http://localhost/api/images/generate", nil), &apiPrincipal{UserID: user}, input, "generate")
	if err != nil {
		t.Fatal(err)
	}
	taskID, generationID := stringValue(task["id"]), stringValue(task["generationId"])
	claim := newWorkerToken()
	opsFixtureExec(t, b, `UPDATE image_async_task SET status='running',claim_token=$2,claim_expires_at=now()+interval '5 minutes' WHERE id=$1`, taskID, claim)
	ctx = context.WithValue(ctx, imageWorkerClaimKey{}, claim)
	cfg, err := b.imageTaskProvider(ctx, generationID, user, "gpt-image-2")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.memberID != a {
		t.Fatal("main initial priority did not select a")
	}
	opsFixtureExec(t, b, `UPDATE generation SET api_adapter_member_id=$2,api_adapter_version_id=$3 WHERE id=$1`, generationID, a, cfg.versionID)
	if err = b.acquireImageProviderLease(ctx, taskID, cfg); err != nil {
		t.Fatal(err)
	}
	if err = b.recordImageSchedulerResult(ctx, taskID, a, "", true, nil); err != nil {
		t.Fatal(err)
	}
	setStorageTestSetting(t, b, "IMAGE_BACKEND_SCHEDULING_STRATEGY", "least_acquired")
	for step := range 3 {
		request := imageProcessingMessage{ImageBase64: base64.StdEncoding.EncodeToString([]byte("input")), Prompt: "restore", Width: 32, Height: 24, Index: step}
		_, err = b.runImageRepairEdit(ctx, taskID, generationID, user, 0, request)
		if (step < 2 && err != nil) || (step == 2 && err == nil) {
			t.Fatalf("step %d: %v", step, err)
		}
		_, _ = b.runImageRepairEdit(ctx, taskID, generationID, user, 0, request)
	}
	if calls.Load() != 3 {
		t.Fatalf("repair receipt replay repeated calls: %d", calls.Load())
	}
	if acquired, success, failed, _ := schedulerCounts(t, b, a); acquired != 2 || success != 2 || failed != 0 {
		t.Fatalf("main supplier was punished for another supplier: %d/%d/%d", acquired, success, failed)
	}
	if acquired, success, failed, _ := schedulerCounts(t, b, z); acquired != 2 || success != 1 || failed != 1 {
		t.Fatalf("repair steps collapsed: %d/%d/%d", acquired, success, failed)
	}
	var acquired, switched, terminal int
	if err = b.db.QueryRow(ctx, `SELECT COALESCE(sum(event_count) FILTER(WHERE outcome='acquired'),0),COALESCE(sum(event_count) FILTER(WHERE outcome='switched'),0),COALESCE(sum(event_count) FILTER(WHERE outcome='terminal_failure'),0) FROM image_backend_member_scheduler_metric WHERE group_id=$1`, group).Scan(&acquired, &switched, &terminal); err != nil {
		t.Fatal(err)
	}
	if acquired != 4 || switched != 0 || terminal != 1 {
		t.Fatalf("repair session metrics: %d/%d/%d", acquired, switched, terminal)
	}
}
