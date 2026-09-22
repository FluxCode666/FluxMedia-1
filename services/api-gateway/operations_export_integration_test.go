//go:build integration

package main

import (
	"context"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func operationsExportFixture(t *testing.T) (*backend, string, *http.Cookie) {
	t.Helper()
	b := integrationBackend(t)
	b.config.storagePath = t.TempDir()
	opsFixtureExec(t, b, `INSERT INTO operations_analytics_epoch(id,app_date,starts_at,initialization_request_id) VALUES(1,'2020-01-01','2020-01-01 05:00:00','operations-export-test') ON CONFLICT DO NOTHING`)
	setStorageTestSetting(t, b, "APP_TIME_ZONE", "America/New_York")
	setStorageTestSetting(t, b, "STORAGE_ENDPOINT", "")
	setStorageTestSetting(t, b, "STORAGE_BUCKET_NAME", "operations-export-test")
	setStorageTestSetting(t, b, "LOCAL_STORAGE_PATH", b.config.storagePath)
	owner, email := seedAuthUser(t, b)
	opsFixtureExec(t, b, `UPDATE "user" SET role='admin' WHERE id=$1`, owner)
	return b, owner, signInTestUser(t, b, email)
}
func operationsExportTestQuery() map[string]any {
	return map[string]any{"granularity": "day", "range": map[string]any{"kind": "custom", "from": "2024-03-09", "to": "2024-03-11"}}
}
func operationsExportCreateFixture(t *testing.T, b *backend, owner, kind string) operationsExportSummary {
	t.Helper()
	opsFixtureExec(t, b, `UPDATE operations_export_task SET created_at=created_at-interval '3 seconds' WHERE created_by=$1`, owner)
	task, err := b.createOperationsExport(context.Background(), owner, operationsExportInput{ExportType: kind, Query: operationsExportTestQuery(), ClientRequestID: newRequestID()}, "")
	if err != nil {
		var clock, latest, zone string
		_ = b.db.QueryRow(context.Background(), `SELECT transaction_timestamp()::text,COALESCE(max(created_at)::text,''),current_setting('TimeZone') FROM operations_export_task WHERE created_by=$1`, owner).Scan(&clock, &latest, &zone)
		t.Logf("database clock=%s latest=%s zone=%s", clock, latest, zone)
		t.Fatal(err)
	}
	return task
}

func TestOperationsExportsSnapshotCSVAndOwnedDownloads(t *testing.T) {
	b, owner, cookie := operationsExportFixture(t)
	ctx := context.Background()
	user, _ := seedAuthUser(t, b)
	old, _ := seedAuthUser(t, b)
	first := opsFixtureTime("2024-03-09T17:00:00.123456Z")
	second := opsFixtureTime("2024-03-10T17:00:00.123456Z")
	opsFixtureExec(t, b, `UPDATE "user" SET created_at=$2,name='=FORMULA()' WHERE id=$1`, user, first)
	opsFixtureExec(t, b, `UPDATE "user" SET created_at='2019-01-01' WHERE id=$1`, old)
	opsFixtureExec(t, b, `INSERT INTO user_web_visit(user_id,app_date,first_visited_at) VALUES($1,'2024-03-10',$2)`, user, second)
	image := newRequestID()
	historyFixtureImage(t, b, user, image, "gpt-image-1", "completed", second, nil)
	opsFixtureExec(t, b, `INSERT INTO user_output_usage_event(output_kind,source_task_id,user_id,operation_created_at,image_count,video_seconds) VALUES('image',$1,$2,$3,2,0)`, image, user, second)
	order := newRequestID()
	opsFixtureExec(t, b, `INSERT INTO payment_order(id,user_id,client_request_id,provider,purpose,status,currency,amount,amount_minor,credits_amount,pricing_snapshot,created_at,fulfilled_at) VALUES($1,$2,$1,'epay','credit_top_up','fulfilled','BHD',1.234,1234,20,'{}',$3,$4)`, order, user, first, second)
	for _, event := range []string{"order_created", "payment_confirmed", "fulfillment_succeeded"} {
		opsFixtureExec(t, b, `INSERT INTO payment_lifecycle_event(id,payment_order_id,event_type,source_ref,occurred_at,timestamp_source,provider) VALUES($1,$2,$3,$1,$4,'server_generated','epay')`, newRequestID(), order, event, second)
	}
	tasks := map[string]operationsExportSummary{}
	for _, kind := range []string{"user_growth", "commercialization", "content_production"} {
		tasks[kind] = operationsExportCreateFixture(t, b, owner, kind)
	}
	var timezone string
	var watermarks []byte
	var snapshot time.Time
	if e := b.db.QueryRow(ctx, `SELECT time_zone,high_watermarks,snapshot_at FROM operations_export_task WHERE id=$1`, tasks["user_growth"].ID).Scan(&timezone, &watermarks, &snapshot); e != nil {
		t.Fatal(e)
	}
	if timezone != "America/New_York" {
		t.Fatal("snapshot timezone was lost")
	}
	if _, e := validateOperationsExportWatermarks(watermarks); e != nil {
		t.Fatal(e)
	}
	// Freeze facts at enqueue time even when orders mutate and delayed append
	// events for the same historical range arrive before the worker starts.
	opsFixtureExec(t, b, `UPDATE payment_order SET status='failed',fulfilled_at=NULL WHERE id=$1`, order)
	opsFixtureExec(t, b, `INSERT INTO payment_lifecycle_event(id,payment_order_id,event_type,source_ref,occurred_at,timestamp_source,provider) VALUES($1,$2,'fulfillment_failed_terminal',$1,$3,'server_generated','epay')`, newRequestID(), order, second)
	late := newRequestID()
	historyFixtureImage(t, b, user, late, "gpt-image-1", "completed", second.Add(time.Hour), nil)
	opsFixtureExec(t, b, `INSERT INTO user_output_usage_event(output_kind,source_task_id,user_id,operation_created_at,image_count,video_seconds) VALUES('image',$1,$2,$3,99,0)`, late, user, second.Add(time.Hour))
	opsFixtureExec(t, b, `INSERT INTO user_web_visit(user_id,app_date,first_visited_at) VALUES($1,'2024-03-10',$2)`, old, second)
	if count, e := b.processOperationsExports(ctx, 3); e != nil || count != 3 {
		t.Fatalf("process %d %v", count, e)
	}
	for kind, task := range tasks {
		var status, bucket, key, checksum string
		var rowCount, byteCount int64
		if e := b.db.QueryRow(ctx, `SELECT status,object_bucket,object_key,checksum_sha256,row_count,byte_count FROM operations_export_task WHERE id=$1`, task.ID).Scan(&status, &bucket, &key, &checksum, &rowCount, &byteCount); e != nil {
			t.Fatal(e)
		}
		if status != "completed" {
			t.Fatalf("%s task %s", kind, status)
		}
		data, e := os.ReadFile(filepath.Join(b.config.storagePath, bucket, filepath.FromSlash(key)))
		if e != nil {
			t.Fatal(e)
		}
		if len(data) < 3 || string(data[:3]) != "\xef\xbb\xbf" || !strings.Contains(string(data), "\r\n") {
			t.Fatal("CSV BOM/CRLF missing")
		}
		hash := sha256.Sum256(data)
		if byteCount != int64(len(data)) || checksum != hex.EncodeToString(hash[:]) {
			t.Fatal("CSV checksum/count mismatch")
		}
		rows, e := csv.NewReader(strings.NewReader(string(data[3:]))).ReadAll()
		if e != nil {
			t.Fatal(e)
		}
		if rowCount != int64(len(rows)-1) {
			t.Fatal("row stats mismatch")
		}
		counts := map[string]int{}
		for _, row := range rows[1:] {
			counts[row[0]]++
		}
		switch kind {
		case "user_growth":
			for section, want := range map[string]int{"cumulative_users": 2, "users": 1, "login_activity": 1, "creation_activity": 1, "payment_activity": 1, "retention_d1": 1, "retention_d7": 1, "retention_d30": 1} {
				if counts[section] != want {
					t.Fatalf("section %s=%d rows=%v", section, counts[section], rows)
				}
			}
			found := false
			for _, row := range rows[1:] {
				if row[0] == "retention_d1" {
					found = true
					if row[7] != "true" || row[2] != "'=FORMULA()" || row[4] != "2024-03-09T12:00:00.123-05:00" {
						t.Fatalf("growth row %v", row)
					}
				}
			}
			if !found {
				t.Fatal("retention omitted")
			}
		case "commercialization":
			if counts["orders"] != 1 || counts["fulfilled_orders"] != 1 || counts["payment_lifecycle"] != 3 {
				t.Fatalf("commercial rows %v", rows)
			}
			for _, row := range rows[1:] {
				if row[5] != "1.234" || row[6] != "fulfilled" {
					t.Fatalf("order snapshot %v", row)
				}
			}
		case "content_production":
			if len(rows) != 2 || rows[1][0] != image || rows[1][6] != "2" || rows[1][8] != "0.00" {
				t.Fatalf("content rows %v", rows)
			}
		}
	}
	task := tasks["user_growth"]
	prepared := requireCreditResponse(t, authRequest(t, b, "POST", "/api/admin/operations/exports/prepare-download", mustJSON(map[string]any{"taskId": task.ID}), cookie), 200)
	exp, e := time.Parse(time.RFC3339Nano, prepared["expiresAt"].(string))
	if e != nil || time.Until(exp) > 61*time.Second || time.Until(exp) < time.Second {
		t.Fatal("download TTL is not short")
	}
	localURL, e := url.Parse(prepared["downloadUrl"].(string))
	if e != nil || localURL.Host == "" {
		t.Fatal("download URL must be absolute")
	}
	localPath := localURL.RequestURI()
	down := authRequest(t, b, "GET", localPath, "", cookie)
	if down.Code != 200 || !strings.Contains(down.Header().Get("Content-Disposition"), "operations-user_growth-") {
		t.Fatalf("download %d %s", down.Code, down.Body.String())
	}
	other, email := seedAuthUser(t, b)
	opsFixtureExec(t, b, `UPDATE "user" SET role='super_admin' WHERE id=$1`, other)
	otherCookie := signInTestUser(t, b, email)
	requireCreditResponse(t, authRequest(t, b, "GET", localPath, "", otherCookie), 404)
	requireCreditResponse(t, authRequest(t, b, "POST", "/api/admin/operations/exports/prepare-download", mustJSON(map[string]any{"taskId": task.ID}), otherCookie), 404)
	list := requireCreditResponse(t, authRequest(t, b, "GET", "/api/admin/operations/exports?limit=1", "", cookie), 200)
	cursor := list["nextCursor"].(string)
	requireCreditResponse(t, authRequest(t, b, "GET", "/api/admin/operations/exports?limit=1&cursor="+url.QueryEscape(cursor), "", otherCookie), 400)
	for i := 0; i < 2; i++ {
		list = requireCreditResponse(t, authRequest(t, b, "GET", "/api/admin/operations/exports?limit=1&cursor="+url.QueryEscape(cursor), "", cookie), 200)
		if i == 0 {
			cursor = list["nextCursor"].(string)
		} else if list["nextCursor"] != nil {
			t.Fatal("last page has cursor")
		}
	}
	setStorageTestSetting(t, b, "STORAGE_ENDPOINT", "https://storage.example.test")
	setStorageTestSetting(t, b, "STORAGE_ACCESS_KEY_ID", "test")
	setStorageTestSetting(t, b, "STORAGE_SECRET_ACCESS_KEY", "test-secret")
	remote := requireCreditResponse(t, authRequest(t, b, "POST", "/api/admin/operations/exports/prepare-download", mustJSON(map[string]any{"taskId": task.ID}), cookie), 200)
	u, e := url.Parse(remote["downloadUrl"].(string))
	if e != nil || remote["mode"] != "redirect" || u.Query().Get("X-Amz-Expires") != "60" {
		t.Fatalf("remote permit %v", remote)
	}
	requireCreditResponse(t, authRequest(t, b, "GET", localPath, "", cookie), 409)
}

func TestOperationsExportsConcurrentCreateLimitsAndRetry(t *testing.T) {
	b, owner, _ := operationsExportFixture(t)
	ctx := context.Background()
	in := operationsExportInput{ExportType: "content_production", Query: map[string]any{}, ClientRequestID: newRequestID()}
	var wg sync.WaitGroup
	ids := make(chan string, 12)
	errs := make(chan error, 12)
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			task, e := b.createOperationsExport(ctx, owner, in, "")
			if e != nil {
				errs <- e
			} else {
				ids <- task.ID
			}
		}()
	}
	wg.Wait()
	close(ids)
	close(errs)
	for e := range errs {
		t.Fatal(e)
	}
	id := ""
	for got := range ids {
		if id != "" && got != id {
			t.Fatal("duplicate idempotent task")
		}
		id = got
	}
	var audits int
	if e := b.db.QueryRow(ctx, `SELECT count(*) FROM admin_audit_log WHERE action='operations.createExport' AND after->>'taskId'=$1`, id).Scan(&audits); e != nil || audits != 1 {
		t.Fatalf("audit %d %v", audits, e)
	}
	in.ClientRequestID = newRequestID()
	_, e := b.createOperationsExport(ctx, owner, in, "")
	var ae *apiError
	if !errors.As(e, &ae) || ae.status != 429 {
		t.Fatalf("rate limit %v", e)
	}
	for i := 0; i < 2; i++ {
		operationsExportCreateFixture(t, b, owner, "content_production")
	}
	in.ClientRequestID = newRequestID()
	_, e = b.createOperationsExport(ctx, owner, in, "")
	if !errors.As(e, &ae) || ae.code != "CAPACITY_EXCEEDED" {
		t.Fatalf("capacity %v", e)
	}
	opsFixtureExec(t, b, `UPDATE operations_export_task SET status='failed',created_at=created_at-interval '3 seconds' WHERE created_by=$1`, owner)
	setStorageTestSetting(t, b, "APP_TIME_ZONE", "Asia/Shanghai")
	retry, e := b.createOperationsExport(ctx, owner, operationsExportInput{ClientRequestID: newRequestID()}, id)
	if e != nil {
		t.Fatal(e)
	}
	var zone string
	var oldQuery, newQuery []byte
	if e = b.db.QueryRow(ctx, `SELECT time_zone,query,(SELECT query FROM operations_export_task WHERE id=$2) FROM operations_export_task WHERE id=$1`, retry.ID, id).Scan(&zone, &newQuery, &oldQuery); e != nil {
		t.Fatal(e)
	}
	if zone != "America/New_York" || string(oldQuery) != string(newQuery) || retry.RetryOfTaskID == nil || *retry.RetryOfTaskID != id {
		t.Fatal("retry did not preserve frozen parent context")
	}
}

func TestOperationsExportsLeaseFencingExpiryAndOrphans(t *testing.T) {
	b, owner, cookie := operationsExportFixture(t)
	ctx := context.Background()
	task := operationsExportCreateFixture(t, b, owner, "content_production")
	first, e := b.claimOperationsExport(ctx)
	if e != nil {
		t.Fatal(e)
	}
	opsFixtureExec(t, b, `UPDATE operations_export_task SET lease_expires_at=now()-interval '1 second' WHERE id=$1`, task.ID)
	second, e := b.claimOperationsExport(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if first.Token == second.Token {
		t.Fatal("claim token reused")
	}
	if e = b.renewOperationsExport(ctx, first); e == nil {
		t.Fatal("stale heartbeat renewed")
	}
	data, e := b.buildOperationsExportCSV(ctx, second)
	if e != nil {
		t.Fatal(e)
	}
	defer data.close()
	st, e := b.operationsExportStorage(ctx)
	if e != nil {
		t.Fatal(e)
	}
	key := "operations-exports/" + task.ID + "/" + second.Token + ".csv"
	if e = st.put(ctx, key, data.file, data.bytes); e != nil {
		t.Fatal(e)
	}
	if ok, e := b.completeOperationsExport(ctx, first, st.bucket, key, data); e != nil || ok {
		t.Fatalf("stale completion %v %v", ok, e)
	}
	if e = b.failOperationsExport(ctx, first, "test"); e != nil {
		t.Fatal(e)
	}
	if ok, e := b.completeOperationsExport(ctx, second, st.bucket, key, data); e != nil || !ok {
		t.Fatalf("completion %v %v", ok, e)
	}
	// A lost COMMIT response can enqueue a candidate for an already referenced
	// object; cleanup must preserve that object, then delete after expiry.
	if e = b.recordOperationsExportOrphan(ctx, second, st.bucket, key, "completion_unknown"); e != nil {
		t.Fatal(e)
	}
	if e = b.cleanOperationsExportOrphans(ctx, st, 100); e != nil {
		t.Fatal(e)
	}
	path := filepath.Join(st.root, st.bucket, filepath.FromSlash(key))
	if _, e = os.Stat(path); e != nil {
		t.Fatal("referenced object deleted")
	}
	opsFixtureExec(t, b, `UPDATE operations_export_task SET expires_at=now()-interval '1 second' WHERE id=$1`, task.ID)
	requireCreditResponse(t, authRequest(t, b, "GET", "/api/admin/operations/exports/"+task.ID+"/download", "", cookie), 404)
	if n, e := b.expireOperationsExports(ctx, 100); e != nil || n != 1 {
		t.Fatalf("expiry %d %v", n, e)
	}
	if _, e = os.Stat(path); !os.IsNotExist(e) {
		t.Fatal("expired file remains")
	}
	var status string
	var removed *time.Time
	if e = b.db.QueryRow(ctx, `SELECT status,object_deleted_at FROM operations_export_task WHERE id=$1`, task.ID).Scan(&status, &removed); e != nil || status != "expired" || removed == nil {
		t.Fatal("expiry not durable")
	}
	// A process crash before orphan audit is recovered by prefix scanning.
	crashKey := "operations-exports/unknown-task/unknown-lease.csv"
	crashPath := filepath.Join(st.root, st.bucket, filepath.FromSlash(crashKey))
	if e = os.MkdirAll(filepath.Dir(crashPath), 0750); e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(crashPath, []byte("orphan"), 0600); e != nil {
		t.Fatal(e)
	}
	past := time.Now().Add(-time.Hour)
	_ = os.Chtimes(crashPath, past, past)
	if e = b.discoverOperationsExportOrphans(ctx, st, 100); e != nil {
		t.Fatal(e)
	}
	if _, e = os.Stat(crashPath); !os.IsNotExist(e) {
		t.Fatal("unrecorded orphan remains")
	}
	max := operationsExportCreateFixture(t, b, owner, "content_production")
	opsFixtureExec(t, b, `UPDATE operations_export_task SET attempt_count=8 WHERE id=$1`, max.ID)
	if n, e := b.processOperationsExports(ctx, 1); e != nil || n != 1 {
		t.Fatalf("max attempts %d %v", n, e)
	}
	var code string
	if e = b.db.QueryRow(ctx, `SELECT status,error_code FROM operations_export_task WHERE id=$1`, max.ID).Scan(&status, &code); e != nil || status != "failed" || code != "max_attempts_exceeded" {
		t.Fatalf("retry bound %s %s %v", status, code, e)
	}
}

func TestOperationsExportsKeysetSpoolsBeyondOnePage(t *testing.T) {
	b, owner, _ := operationsExportFixture(t)
	ctx := context.Background()
	prefix := "export-page-" + newRequestID()
	t.Cleanup(func() { _, _ = b.db.Exec(context.Background(), `DELETE FROM "user" WHERE id LIKE $1`, prefix+"%") })
	opsFixtureExec(t, b, `INSERT INTO "user"(id,name,email,email_verified,role,created_at) SELECT $1||i::text,'Page',$1||i::text||'@example.test',true,'user','2024-03-10 12:00:00'::timestamp+i*interval '1 microsecond' FROM generate_series(1,1003) i`, prefix)
	task := operationsExportCreateFixture(t, b, owner, "user_growth")
	claim, e := b.claimOperationsExport(ctx)
	if e != nil || claim.ID != task.ID {
		t.Fatalf("claim %v", e)
	}
	staged, e := b.buildOperationsExportCSV(ctx, claim)
	if e != nil {
		t.Fatal(e)
	}
	defer staged.close()
	if _, e = staged.file.Seek(0, io.SeekStart); e != nil {
		t.Fatal(e)
	}
	_, _ = staged.file.Seek(3, io.SeekStart)
	rows, e := csv.NewReader(staged.file).ReadAll()
	if e != nil {
		t.Fatal(e)
	}
	seen := map[string]bool{}
	for _, row := range rows[1:] {
		if row[0] == "users" && strings.HasPrefix(row[1], prefix) {
			if seen[row[1]] {
				t.Fatal("duplicate keyset row")
			}
			seen[row[1]] = true
		}
	}
	if len(seen) != 1003 {
		t.Fatalf("paginated export lost rows: %d", len(seen))
	}
	var query map[string]any
	if e = json.Unmarshal(task.Query, &query); e != nil || query["range"].(map[string]any)["kind"] != "custom" {
		t.Fatal("query not frozen")
	}
}

func TestOperationsExportsSchedulerUsesIndependentSettingsAndRetriesCleanup(t *testing.T) {
	b, owner, _ := operationsExportFixture(t)
	ctx := context.Background()
	scheduler := maintenanceScheduler{backend: b}
	var processedAt, expiredAt time.Time
	setStorageTestSetting(t, b, "INTERNAL_JOB_OPERATIONS_EXPORT_PROCESS_ENABLED", false)
	setStorageTestSetting(t, b, "INTERNAL_JOB_OPERATIONS_EXPORT_EXPIRE_ENABLED", false)
	setStorageTestSetting(t, b, "INTERNAL_JOB_OPERATIONS_EXPORT_PROCESS_INTERVAL_MINUTES", 1)
	setStorageTestSetting(t, b, "INTERNAL_JOB_OPERATIONS_EXPORT_PROCESS_BATCH_SIZE", 10)
	setStorageTestSetting(t, b, "INTERNAL_JOB_OPERATIONS_EXPORT_EXPIRE_INTERVAL_MINUTES", 60)
	setStorageTestSetting(t, b, "INTERNAL_JOB_OPERATIONS_EXPORT_EXPIRE_BATCH_SIZE", 100)
	task := operationsExportCreateFixture(t, b, owner, "content_production")
	if err := scheduler.tickOperationsExports(ctx, false, &processedAt); err != nil {
		t.Fatal(err)
	}
	var status string
	if e := b.db.QueryRow(ctx, `SELECT status FROM operations_export_task WHERE id=$1`, task.ID).Scan(&status); e != nil || status != "queued" {
		t.Fatal("disabled processor ran")
	}
	setStorageTestSetting(t, b, "INTERNAL_JOB_OPERATIONS_EXPORT_PROCESS_ENABLED", true)
	if err := scheduler.tickOperationsExports(ctx, false, &processedAt); err != nil {
		t.Fatal(err)
	}
	if e := b.db.QueryRow(ctx, `SELECT status FROM operations_export_task WHERE id=$1`, task.ID).Scan(&status); e != nil || status != "completed" {
		t.Fatal("enabled processor did not drain queued work")
	}
	second := operationsExportCreateFixture(t, b, owner, "content_production")
	if err := scheduler.tickOperationsExports(ctx, false, &processedAt); err != nil {
		t.Fatal(err)
	}
	if e := b.db.QueryRow(ctx, `SELECT status FROM operations_export_task WHERE id=$1`, second.ID).Scan(&status); e != nil || status != "queued" {
		t.Fatal("processor ignored cadence")
	}
	processedAt = time.Now().Add(-61 * time.Second)
	if err := scheduler.tickOperationsExports(ctx, false, &processedAt); err != nil {
		t.Fatal(err)
	}
	var bucket, key string
	if e := b.db.QueryRow(ctx, `SELECT status,object_bucket,object_key FROM operations_export_task WHERE id=$1`, second.ID).Scan(&status, &bucket, &key); e != nil || status != "completed" {
		t.Fatal("processor waited for hourly retention cadence")
	}
	opsFixtureExec(t, b, `UPDATE operations_export_task SET expires_at=now()-interval '1 second' WHERE id=$1`, second.ID)
	if err := scheduler.tickOperationsExports(ctx, true, &expiredAt); err != nil {
		t.Fatal(err)
	}
	if e := b.db.QueryRow(ctx, `SELECT status FROM operations_export_task WHERE id=$1`, second.ID).Scan(&status); e != nil || status != "completed" {
		t.Fatal("disabled retention ran")
	}
	path := filepath.Join(b.config.storagePath, bucket, filepath.FromSlash(key))
	if e := os.Remove(path); e != nil {
		t.Fatal(e)
	}
	if e := os.Mkdir(path, 0700); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(filepath.Join(path, "blocked"), []byte("test"), 0600); e != nil {
		t.Fatal(e)
	}
	setStorageTestSetting(t, b, "INTERNAL_JOB_OPERATIONS_EXPORT_EXPIRE_ENABLED", true)
	if err := scheduler.tickOperationsExports(ctx, true, &expiredAt); err != nil {
		t.Fatal(err)
	}
	var removed *time.Time
	var cleanup *string
	if e := b.db.QueryRow(ctx, `SELECT status,object_deleted_at,cleanup_error_code FROM operations_export_task WHERE id=$1`, second.ID).Scan(&status, &removed, &cleanup); e != nil || status != "expired" || removed != nil || cleanup == nil || *cleanup != "storage_delete_failed" {
		t.Fatalf("failed cleanup state %s %v %v %v", status, removed, cleanup, e)
	}
	if e := os.RemoveAll(path); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(path, []byte("retry"), 0600); e != nil {
		t.Fatal(e)
	}
	expiredAt = time.Now().Add(-61 * time.Minute)
	if err := scheduler.tickOperationsExports(ctx, true, &expiredAt); err != nil {
		t.Fatal(err)
	}
	if e := b.db.QueryRow(ctx, `SELECT object_deleted_at,cleanup_error_code FROM operations_export_task WHERE id=$1`, second.ID).Scan(&removed, &cleanup); e != nil || removed == nil || cleanup != nil {
		t.Fatal("retention did not retry failed deletion")
	}
}
