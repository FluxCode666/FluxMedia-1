//go:build integration

package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

func opsFixtureExec(t *testing.T, b *backend, sql string, args ...any) {
	t.Helper()
	if _, e := b.db.Exec(context.Background(), sql, args...); e != nil {
		t.Fatal(e)
	}
}
func opsFixtureTime(day string) time.Time { v, _ := time.Parse(time.RFC3339Nano, day); return v }
func opsFixtureRead(t *testing.T, b *backend, cookie *http.Cookie, endpoint string, in any) map[string]any {
	t.Helper()
	w := authRequest(t, b, "POST", "/api/admin/operations/"+endpoint, mustJSON(in), cookie)
	return requireCreditResponse(t, w, 200)
}
func opsPath(v map[string]any, keys ...string) any {
	var out any = v
	for _, key := range keys {
		out = out.(map[string]any)[key]
	}
	return out
}
func TestOperationsMigratedOverviewAndDetailFacts(t *testing.T) {
	b := integrationBackend(t)
	b.logger = slog.New(slog.NewTextHandler(os.Stderr, nil))
	ctx := context.Background()
	opsFixtureExec(t, b, `INSERT INTO operations_analytics_epoch(id,app_date,starts_at,initialization_request_id) VALUES(1,'2020-01-01','2020-01-01 05:00:00','operations-test-epoch') ON CONFLICT DO NOTHING`)
	setStorageTestSetting(t, b, "APP_TIME_ZONE", "America/New_York")
	admin, email := seedAuthUser(t, b)
	opsFixtureExec(t, b, `UPDATE "user" SET role='admin' WHERE id=$1`, admin)
	cookie := signInTestUser(t, b, email)
	u1, _ := seedAuthUser(t, b)
	u2, _ := seedAuthUser(t, b)
	u3, _ := seedAuthUser(t, b)
	old, _ := seedAuthUser(t, b)
	a1, a2, a3 := opsFixtureTime("2024-03-09T17:00:00.123456Z"), opsFixtureTime("2024-03-10T17:00:00.123456Z"), opsFixtureTime("2024-03-11T17:00:00.123456Z")
	for uid, at := range map[string]time.Time{u1: a1, u2: a2, u3: a2, old: opsFixtureTime("2019-01-01T00:00:00Z")} {
		opsFixtureExec(t, b, `UPDATE "user" SET created_at=$2 WHERE id=$1`, uid, at)
	}
	opsFixtureExec(t, b, `UPDATE "user" SET role='observer_admin',banned=true WHERE id=$1`, u3)
	opsFixtureExec(t, b, `INSERT INTO user_web_visit(user_id,app_date,first_visited_at) VALUES($1,'2024-03-09',$3),($1,'2024-03-10',$4),($2,'2024-03-10',$4)`, u1, u2, a1, a2)
	image, video := newRequestID(), newRequestID()
	historyFixtureImage(t, b, u1, image, "gpt-image-1", "completed", a2, nil)
	historyFixtureVideo(t, b, u2, video, "veo31", "completed", "completed", a3, nil, nil)
	historyFixtureImage(t, b, u1, newRequestID(), "gpt-image-1", "failed", a3, nil)
	opsFixtureExec(t, b, `INSERT INTO user_output_usage_event(output_kind,source_task_id,user_id,operation_created_at,image_count,video_seconds) VALUES('image',$1,$2,$3,2,0),('video',$4,$5,$6,0,8)`, image, u1, a2, video, u2, a3)
	paid, failed, pending, ignored := newRequestID(), newRequestID(), newRequestID(), newRequestID()
	for _, p := range []struct {
		id, uid, status, purpose string
		at                       time.Time
		fulfilled                any
	}{{paid, u1, "fulfilled", "credit_package", a1, a2}, {failed, u2, "failed", "credit_top_up", a2, nil}, {pending, u3, "pending", "credit_package", a2, nil}, {ignored, u2, "fulfilled", "subscription", a1, a2}} {
		opsFixtureExec(t, b, `INSERT INTO payment_order(id,user_id,client_request_id,provider,purpose,status,currency,amount,amount_minor,credits_amount,pricing_snapshot,provider_trade_no,created_at,fulfilled_at) VALUES($1,$2,$1,'epay',$3,$4,'USD',2,200,20,'{}',$1,$5,$6)`, p.id, p.uid, p.purpose, p.status, p.at, p.fulfilled)
	}
	event := func(order, kind string, at time.Time) {
		opsFixtureExec(t, b, `INSERT INTO payment_lifecycle_event(id,payment_order_id,event_type,source_ref,occurred_at,timestamp_source,provider) VALUES($1,$2,$3,$1,$4,'server_generated','epay')`, newRequestID(), order, kind, at)
	}
	for _, id := range []string{paid, failed, pending, ignored} {
		event(id, "order_created", a1)
	}
	event(paid, "payment_confirmed", a2)
	event(paid, "fulfillment_attempt_failed", a2)
	event(paid, "fulfillment_succeeded", a2)
	event(failed, "checkout_failed", a3)
	event(ignored, "fulfillment_succeeded", a2)
	query := map[string]any{"granularity": "day", "range": map[string]any{"kind": "custom", "from": "2024-03-09", "to": "2024-03-11"}}
	overview := opsFixtureRead(t, b, cookie, "overview", query)
	for key, want := range map[string]float64{"cumulativeUsers": 4, "newUsers": 3, "loginActiveUsers": 2, "creationActiveUsers": 2, "paymentActiveUsers": 1} {
		if got := opsPath(overview, "growth", "metrics", key, "current"); got != want {
			t.Fatalf("%s: %v want %v", key, got, want)
		}
	}
	if got := opsPath(overview, "growth", "metrics", "d1Retention", "current", "rate"); got != float64(2)/3 {
		t.Fatalf("weighted retention: %v", got)
	}
	if got := opsPath(overview, "commercial", "lifecycle", "pendingOrders", "current"); got != float64(1) {
		t.Fatalf("real lifecycle pending: %v", got)
	}
	if got := opsPath(overview, "systemHealth", "taskSuccessRate", "current", "rate"); got != float64(2)/3 {
		t.Fatalf("real success rate: %v", got)
	}
	if got := opsPath(overview, "systemHealth", "processingDuration", "current", "averageSeconds"); got != 3.1 {
		t.Fatalf("duration: %v", got)
	}
	if got := opsPath(overview, "content", "metrics", "videoSeconds", "current"); got != float64(8) {
		t.Fatalf("video seconds: %v", got)
	}
	// Keep a contract fixture for the parent to validate through the shared Zod output schema.
	if path := os.Getenv("OPERATIONS_CONTRACT_FIXTURE"); path != "" {
		raw, _ := json.Marshal(overview)
		if e := os.WriteFile(path, raw, 0600); e != nil {
			t.Fatal(e)
		}
	}
	detail := func(sel map[string]any, limit int, cursor any) map[string]any {
		in := map[string]any{"granularity": query["granularity"], "range": query["range"], "selection": sel, "limit": limit}
		if cursor != nil {
			in["cursor"] = cursor
		}
		return opsFixtureRead(t, b, cookie, "detail", in)
	}
	for _, test := range []struct {
		sel   map[string]any
		count int
	}{{map[string]any{"module": "growth", "detail": "users"}, 3}, {map[string]any{"module": "growth", "detail": "cumulative_users", "cutoffDate": "2024-03-11"}, 4}, {map[string]any{"module": "growth", "detail": "login_activity"}, 2}, {map[string]any{"module": "growth", "detail": "creation_activity"}, 2}, {map[string]any{"module": "growth", "detail": "payment_activity"}, 1}, {map[string]any{"module": "growth", "detail": "retention_cohorts", "cohortDate": "2024-03-09", "retentionDay": 1}, 1}, {map[string]any{"module": "commercialization", "detail": "orders"}, 3}, {map[string]any{"module": "commercialization", "detail": "fulfilled_orders", "currency": "USD"}, 1}, {map[string]any{"module": "commercialization", "detail": "payment_lifecycle"}, 7}, {map[string]any{"module": "commercialization", "detail": "payment_stage", "stage": "pending_orders"}, 1}, {map[string]any{"module": "content", "detail": "credit_usage"}, 2}, {map[string]any{"module": "content", "detail": "content_bucket", "contentKind": "image", "bucket": map[string]any{"from": "2024-03-10", "to": "2024-03-10"}}, 1}} {
		out := detail(test.sel, 100, nil)
		rows := out["rows"].([]any)
		if len(rows) != test.count {
			t.Fatalf("detail %v count %d want %d", test.sel, len(rows), test.count)
		}
		if strings.Contains(mustJSON(out), "history prompt") || strings.Contains(mustJSON(out), "pricingSnapshot") {
			t.Fatal("unsafe detail leaked")
		}
	}
	sel := map[string]any{"module": "growth", "detail": "users"}
	first := detail(sel, 1, nil)
	if first["nextCursor"] == nil {
		t.Fatal("missing signed cursor")
	}
	second := detail(sel, 1, first["nextCursor"])
	third := detail(sel, 1, second["nextCursor"])
	if third["nextCursor"] != nil {
		t.Fatal("last cursor present")
	}
	seen := map[any]bool{}
	for _, out := range []map[string]any{first, second, third} {
		r := out["rows"].([]any)[0].(map[string]any)
		if seen[r["userId"]] {
			t.Fatal("microsecond keyset duplicated row")
		}
		seen[r["userId"]] = true
	}
	bad := map[string]any{"range": query["range"], "selection": sel, "limit": 1, "cursor": first["nextCursor"].(string) + "x"}
	requireCreditResponse(t, authRequest(t, b, "POST", "/api/admin/operations/detail", mustJSON(bad), cookie), 400)
	bad["cursor"] = first["nextCursor"]
	bad["limit"] = 2
	requireCreditResponse(t, authRequest(t, b, "POST", "/api/admin/operations/detail", mustJSON(bad), cookie), 400)
	// Frozen commercial projections retain the old order stage after mutable status changes.
	wm, e := readOperationsDetailHighWatermarks(ctx, b.db, time.Now())
	if e != nil {
		t.Fatal(e)
	}
	opsFixtureExec(t, b, `UPDATE payment_order SET status='failed',fulfilled_at=NULL WHERE id=$1`, paid)
	rows, e := readOperationsDetailRows(ctx, b.db, operationsDetailReadQuery{Kind: "fulfilled_orders", Start: a1.Add(-24 * time.Hour), End: a3.Add(time.Hour), EpochStart: opsFixtureTime("2020-01-01T00:00:00Z"), AsOf: time.Now(), Limit: 100, HighWatermarks: wm})
	if e != nil || len(rows) != 1 || rows[0].Public["orderStatus"] != "fulfilled" {
		t.Fatalf("frozen payment: %v %v", rows, e)
	}
	legacy := newRequestID()
	opsFixtureExec(t, b, `INSERT INTO payment_order(id,user_id,client_request_id,provider,purpose,status,currency,amount,amount_minor,credits_amount,pricing_snapshot,created_at,fulfilled_at) VALUES($1,$2,$1,'epay','credit_package','fulfilled','USD',2,200,20,'{}',$3,$4)`, legacy, u3, a1, a2)
	legacyDetail := detail(map[string]any{"module": "commercialization", "detail": "fulfilled_orders"}, 100, nil)
	if got := legacyDetail["rows"].([]any); len(got) != 1 || got[0].(map[string]any)["paymentOrderId"] != legacy {
		t.Fatalf("interactive legacy order disappeared: %v", got)
	}
	// All query families, including export cohort streams, compile and honor null source bounds.
	for _, q := range []operationsDetailReadQuery{{Kind: "cohort_export", RetentionDay: 1, TimeZone: "America/New_York"}, {Kind: "activity", ActivityKind: "payment"}, {Kind: "content", Detail: "image_outputs"}, {Kind: "orders"}} {
		q.Start = a1.Add(-time.Hour)
		q.End = a3.Add(time.Hour)
		q.EpochStart = opsFixtureTime("2020-01-01T00:00:00Z")
		q.AsOf = time.Now()
		q.Limit = 100
		q.HighWatermarks = map[string]any{}
		rows, e := readOperationsDetailRows(ctx, b.db, q)
		if e != nil || len(rows) != 0 {
			t.Fatalf("empty watermark %s: %v %v", q.Kind, rows, e)
		}
	}
	// Identity drift is a failed read, never a fabricated free operation.
	opsFixtureExec(t, b, `INSERT INTO credit_usage_operation(user_id,operation_type,operation_id,operation_created_at) VALUES($1,'image_generation',$2,$3)`, u1, image, a2.Add(time.Second))
	input := map[string]any{"range": query["range"], "selection": map[string]any{"module": "content", "detail": "image_outputs"}}
	requireCreditResponse(t, authRequest(t, b, "POST", "/api/admin/operations/detail", mustJSON(input), cookie), 500)
}
