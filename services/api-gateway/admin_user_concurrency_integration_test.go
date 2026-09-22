//go:build integration

package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestAdminUserConcurrencySerializesNoopsAndAuditsRealIdentity(t *testing.T) {
	b := integrationBackend(t)
	ctx := context.Background()
	admin, email := seedAuthUser(t, b)
	target, _ := seedAuthUser(t, b)
	if _, err := b.db.Exec(ctx, `UPDATE "user" SET role='admin' WHERE id=$1`, admin); err != nil {
		t.Fatal(err)
	}
	cookie := signInTestUser(t, b, email)
	setStorageTestSetting(t, b, "IMAGE_GENERATION_DEFAULT_USER_CONCURRENCY", 20)
	t.Cleanup(func() {
		_, _ = b.db.Exec(ctx, `DELETE FROM admin_audit_log WHERE admin_user_id=$1 AND target_user_id=$2 AND action='mediaLimits.setUserConcurrencyOverride'`, admin, target)
	})
	call := func(override *int) *httptest.ResponseRecorder {
		body := map[string]any{"userId": target, "override": override, "reason": "  capacity adjustment  "}
		r := httptest.NewRequest(http.MethodPost, "http://localhost:3000/api/admin/users/"+target+"/concurrency", strings.NewReader(mustJSON(body)))
		r.AddCookie(cookie)
		r.Header.Set(requestIDHeader, "concurrency-request")
		w := httptest.NewRecorder()
		b.handler().ServeHTTP(w, r)
		return w
	}
	results := make(chan *httptest.ResponseRecorder, 8)
	var wg sync.WaitGroup
	for i := 0; i < cap(results); i++ {
		wg.Add(1)
		go func() { defer wg.Done(); results <- call(ptrInt(40)) }()
	}
	wg.Wait()
	close(results)
	changes := 0
	var auditID, changedAt string
	for response := range results {
		out := requireCreditResponse(t, response, http.StatusOK)
		if out["changed"] == true {
			changes++
			auditID, _ = out["auditLogId"].(string)
			changedAt, _ = out["updatedAt"].(string)
		} else if out["auditLogId"] != nil {
			t.Fatal("no-op returned an audit id")
		}
	}
	if changes != 1 || auditID == "" || changedAt == "" {
		t.Fatalf("changes=%d auditID=%q changedAt=%q", changes, auditID, changedAt)
	}
	var metadata []byte
	var reason string
	var createdAt, updatedAt time.Time
	if err := b.db.QueryRow(ctx, `SELECT metadata,reason,created_at FROM admin_audit_log WHERE id=$1`, auditID).Scan(&metadata, &reason, &createdAt); err != nil {
		t.Fatal(err)
	}
	if err := b.db.QueryRow(ctx, `SELECT updated_at FROM "user" WHERE id=$1`, target).Scan(&updatedAt); err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(metadata, &parsed); err != nil {
		t.Fatal(err)
	}
	if reason != "capacity adjustment" || parsed["requestId"] != "concurrency-request" || parsed["actorUserId"] != admin || parsed["targetUserId"] != target || parsed["targetRole"] != "user" || createdAt.UTC().Format(time.RFC3339Nano) != changedAt || !createdAt.Equal(updatedAt) {
		t.Fatalf("audit metadata=%s reason=%q created=%s updated=%s", metadata, reason, createdAt, updatedAt)
	}
	noOp := requireCreditResponse(t, call(ptrInt(40)), http.StatusOK)
	if noOp["changed"] != false || noOp["auditLogId"] != nil || noOp["updatedAt"] != changedAt {
		t.Fatalf("no-op result=%v expected timestamp=%s", noOp, changedAt)
	}
	var count int
	if err := b.db.QueryRow(ctx, `SELECT count(*) FROM admin_audit_log WHERE admin_user_id=$1 AND target_user_id=$2 AND action='mediaLimits.setUserConcurrencyOverride'`, admin, target).Scan(&count); err != nil || count != 1 {
		t.Fatalf("audit count=%d err=%v", count, err)
	}
}

func TestAdminUserConcurrencyRejectsIdentityAndPermissionViolations(t *testing.T) {
	b := integrationBackend(t)
	admin, email := seedAuthUser(t, b)
	peer, _ := seedAuthUser(t, b)
	super, superEmail := seedAuthUser(t, b)
	observer, observerEmail := seedAuthUser(t, b)
	member, memberEmail := seedAuthUser(t, b)
	if _, err := b.db.Exec(context.Background(), `UPDATE "user" SET role='admin' WHERE id IN ($1,$2)`, admin, peer); err != nil {
		t.Fatal(err)
	}
	if _, err := b.db.Exec(context.Background(), `UPDATE "user" SET role='super_admin' WHERE id=$1`, super); err != nil {
		t.Fatal(err)
	}
	if _, err := b.db.Exec(context.Background(), `UPDATE "user" SET role='observer_admin' WHERE id=$1`, observer); err != nil {
		t.Fatal(err)
	}
	adminCookie := signInTestUser(t, b, email)
	superCookie := signInTestUser(t, b, superEmail)
	observerCookie := signInTestUser(t, b, observerEmail)
	memberCookie := signInTestUser(t, b, memberEmail)
	t.Cleanup(func() {
		_, _ = b.db.Exec(context.Background(), `DELETE FROM admin_audit_log WHERE admin_user_id=ANY($1) AND action='mediaLimits.setUserConcurrencyOverride'`, []string{admin, super})
	})
	call := func(target string, input string, cookie *http.Cookie) *httptest.ResponseRecorder {
		return authRequest(t, b, http.MethodPost, "/api/admin/users/"+target+"/concurrency", input, cookie)
	}
	requireCreditResponse(t, call(peer, mustJSON(map[string]any{"userId": super, "override": 4, "reason": "mismatch"}), adminCookie), http.StatusBadRequest)
	requireCreditResponse(t, call(member, `{"override":4,"reason":"ordinary actor"}`, memberCookie), http.StatusForbidden)
	requireCreditResponse(t, call(member, `{"override":4,"reason":"observer actor"}`, observerCookie), http.StatusForbidden)
	requireCreditResponse(t, call(peer, mustJSON(map[string]any{"userId": peer, "override": 4, "reason": "peer"}), adminCookie), http.StatusForbidden)
	requireCreditResponse(t, call(admin, mustJSON(map[string]any{"userId": admin, "override": 4, "reason": "self"}), adminCookie), http.StatusForbidden)
	requireCreditResponse(t, call(super, `{"override":4,"reason":"higher role"}`, adminCookie), http.StatusForbidden)
	requireCreditResponse(t, call(observer, `{"override":4,"reason":"lower role"}`, adminCookie), http.StatusOK)
	requireCreditResponse(t, call(super, mustJSON(map[string]any{"userId": super, "override": 4, "reason": "super self"}), superCookie), http.StatusOK)
	for _, override := range []float64{0, -1, 1.5, 10001} {
		requireCreditResponse(t, call(peer, mustJSON(map[string]any{"userId": peer, "override": override, "reason": "invalid amount"}), superCookie), http.StatusBadRequest)
	}
	requireCreditResponse(t, call(peer, mustJSON(map[string]any{"userId": peer, "override": 4, "reason": "   "}), superCookie), http.StatusBadRequest)
	requireCreditResponse(t, call("missing", `{"override":4,"reason":"missing user"}`, superCookie), http.StatusNotFound)
}

func TestAdminUserConcurrencyUsesOneConnectionAndRollsBackAuditFailure(t *testing.T) {
	b := integrationBackend(t)
	ctx := context.Background()
	admin, email := seedAuthUser(t, b)
	target, _ := seedAuthUser(t, b)
	if _, err := b.db.Exec(ctx, `UPDATE "user" SET role='super_admin' WHERE id=$1`, admin); err != nil {
		t.Fatal(err)
	}
	cookie := signInTestUser(t, b, email)
	config := b.db.Config()
	config.MaxConns = 1
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	singleConnectionBackend := *b
	singleConnectionBackend.db = pool
	b = &singleConnectionBackend
	setStorageTestSetting(t, b, "IMAGE_GENERATION_DEFAULT_USER_CONCURRENCY", 23)
	t.Cleanup(func() {
		_, _ = b.db.Exec(ctx, `DELETE FROM admin_audit_log WHERE admin_user_id=$1 AND target_user_id=$2 AND action='mediaLimits.setUserConcurrencyOverride'`, admin, target)
	})
	call := func(override *int, reason string) *httptest.ResponseRecorder {
		requestContext, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		r := httptest.NewRequest(http.MethodPost, "http://localhost:3000/api/admin/users/"+target+"/concurrency", strings.NewReader(mustJSON(map[string]any{"override": override, "reason": reason}))).WithContext(requestContext)
		r.AddCookie(cookie)
		w := httptest.NewRecorder()
		b.handler().ServeHTTP(w, r)
		return w
	}
	longReason := strings.Repeat("x", 300)
	first := requireCreditResponse(t, call(ptrInt(50), " "+longReason+" "), http.StatusOK)
	cleared := requireCreditResponse(t, call(nil, "clear"), http.StatusOK)
	if first["after"] != float64(50) || cleared["after"] != nil || cleared["effectiveConcurrency"] != float64(23) || cleared["effectiveSource"] != "system_default" {
		t.Fatalf("override inheritance: first=%v cleared=%v", first, cleared)
	}
	noOp := requireCreditResponse(t, call(nil, "already inherited"), http.StatusOK)
	if noOp["changed"] != false || noOp["updatedAt"] != cleared["updatedAt"] || noOp["auditLogId"] != nil {
		t.Fatalf("clear no-op=%v", noOp)
	}
	if _, err := b.db.Exec(ctx, `CREATE FUNCTION test_reject_concurrency_audit() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN IF NEW.action = ''mediaLimits.setUserConcurrencyOverride'' THEN RAISE EXCEPTION ''audit rejected''; END IF; RETURN NEW; END'`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = b.db.Exec(ctx, `DROP TRIGGER IF EXISTS test_reject_concurrency_audit ON admin_audit_log`)
		_, _ = b.db.Exec(ctx, `DROP FUNCTION IF EXISTS test_reject_concurrency_audit()`)
	})
	if _, err := b.db.Exec(ctx, `CREATE TRIGGER test_reject_concurrency_audit BEFORE INSERT ON admin_audit_log FOR EACH ROW EXECUTE FUNCTION test_reject_concurrency_audit()`); err != nil {
		t.Fatal(err)
	}
	requireCreditResponse(t, call(ptrInt(70), "rejected audit"), http.StatusInternalServerError)
	var override *int
	var updated time.Time
	if err := b.db.QueryRow(ctx, `SELECT image_generation_concurrency_override,updated_at FROM "user" WHERE id=$1`, target).Scan(&override, &updated); err != nil || override != nil || updated.UTC().Format(time.RFC3339Nano) != cleared["updatedAt"] {
		t.Fatalf("failed audit committed state: override=%v updated=%s err=%v", override, updated, err)
	}
}

func ptrInt(value int) *int { return &value }
