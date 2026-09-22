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
)

func TestUserModerationPolicyPreservesRoleAndInputContracts(t *testing.T) {
	b := integrationBackend(t)
	ctx := context.Background()
	makeUser := func(role string) (string, *http.Cookie) {
		id, email := seedAuthUser(t, b)
		if _, err := b.db.Exec(ctx, `UPDATE "user" SET role=$2 WHERE id=$1`, id, role); err != nil {
			t.Fatal(err)
		}
		return id, signInTestUser(t, b, email)
	}
	admin, adminCookie := makeUser("admin")
	observer, observerCookie := makeUser("observer_admin")
	ordinary, ordinaryCookie := makeUser("user")
	super, superCookie := makeUser("super_admin")
	peer, _ := makeUser("admin")
	t.Cleanup(func() {
		_, _ = b.db.Exec(ctx, `DELETE FROM admin_audit_log WHERE action=$1 AND admin_user_id=ANY($2)`, userModerationPolicyAction, []string{admin, super})
	})
	setStorageTestSetting(t, b, globalModerationPolicySetting, map[string]any{"invalid": true})
	t.Setenv(globalModerationPolicySetting, "low")
	path := func(id string) string { return "/api/moderation/users/" + id + "/policy" }
	call := func(id string, level any, cookie *http.Cookie) *httptest.ResponseRecorder {
		return authRequest(t, b, http.MethodPost, path(id), mustJSON(map[string]any{"userId": id, "level": level, "reason": "  change policy  "}), cookie)
	}
	out := requireCreditResponse(t, authRequest(t, b, http.MethodGet, path(super), "", observerCookie), 200)
	if out["globalDefault"] != "high" || out["source"] != "fallback_high" {
		t.Fatalf("invalid database setting used environment fallback: %v", out)
	}
	requireCreditResponse(t, authRequest(t, b, http.MethodGet, path(ordinary), "", ordinaryCookie), 403)
	requireCreditResponse(t, call(ordinary, "low", observerCookie), 403)
	requireCreditResponse(t, call(admin, "low", adminCookie), 403)
	requireCreditResponse(t, call(peer, "low", adminCookie), 403)
	requireCreditResponse(t, call(super, "low", adminCookie), 403)
	requireCreditResponse(t, call(observer, "low", adminCookie), 200)
	requireCreditResponse(t, call(admin, "medium", superCookie), 200)
	requireCreditResponse(t, call(super, "high", superCookie), 200)
	out = requireCreditResponse(t, call(observer, nil, adminCookie), 200)
	if out["after"] != nil || out["effectiveLevel"] != "high" || out["source"] != "fallback_high" || out["auditLogId"] == nil {
		t.Fatalf("clear override contract: %v", out)
	}
	requireCreditResponse(t, authRequest(t, b, http.MethodPost, path(ordinary), `{"reason":"missing level"}`, adminCookie), 400)
	requireCreditResponse(t, authRequest(t, b, http.MethodPost, path(ordinary), `{"userId":"different","level":"low","reason":"mismatch"}`, adminCookie), 400)
	requireCreditResponse(t, call(ordinary, "invalid", adminCookie), 400)
	requireCreditResponse(t, call("missing-user", "low", superCookie), 404)
	requireCreditResponse(t, authRequest(t, b, http.MethodGet, path("missing-user"), "", observerCookie), 404)
}

func TestUserModerationPolicySerializesWritesAndRollsBackFailedAudit(t *testing.T) {
	b := integrationBackend(t)
	ctx := context.Background()
	admin, email := seedAuthUser(t, b)
	target, _ := seedAuthUser(t, b)
	if _, err := b.db.Exec(ctx, `UPDATE "user" SET role='admin' WHERE id=$1`, admin); err != nil {
		t.Fatal(err)
	}
	cookie := signInTestUser(t, b, email)
	setStorageTestSetting(t, b, globalModerationPolicySetting, "high")
	t.Cleanup(func() {
		_, _ = b.db.Exec(ctx, `DELETE FROM admin_audit_log WHERE admin_user_id=$1 AND action=$2`, admin, userModerationPolicyAction)
	})
	call := func(level string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "http://localhost:3000/api/moderation/users/"+target+"/policy", strings.NewReader(mustJSON(map[string]any{"userId": target, "level": level, "reason": "  audit policy  "})))
		r.AddCookie(cookie)
		r.Header.Set(requestIDHeader, "user-policy-request")
		w := httptest.NewRecorder()
		b.handler().ServeHTTP(w, r)
		return w
	}
	results := make(chan *httptest.ResponseRecorder, 6)
	var wg sync.WaitGroup
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); results <- call("medium") }()
	}
	wg.Wait()
	close(results)
	var changes int
	var auditID, changedAt string
	for w := range results {
		out := requireCreditResponse(t, w, 200)
		if out["changed"] == true {
			changes++
			auditID = out["auditLogId"].(string)
			changedAt = out["updatedAt"].(string)
		} else if out["auditLogId"] != nil {
			t.Fatal("noop created audit")
		}
	}
	if changes != 1 || auditID == "" {
		t.Fatalf("concurrent changes=%d audit=%s", changes, auditID)
	}
	var raw []byte
	var reason, role string
	var auditAt, userAt time.Time
	var count int
	if err := b.db.QueryRow(ctx, `SELECT a.metadata,a.reason,a.created_at,u.updated_at,u.role,(SELECT count(*) FROM admin_audit_log WHERE action=$3 AND target_user_id=$2) FROM admin_audit_log a JOIN "user" u ON u.id=a.target_user_id WHERE a.id=$1`, auditID, target, userModerationPolicyAction).Scan(&raw, &reason, &auditAt, &userAt, &role, &count); err != nil {
		t.Fatal(err)
	}
	var meta map[string]any
	_ = json.Unmarshal(raw, &meta)
	if count != 1 || reason != "audit policy" || meta["actorUserId"] != admin || meta["targetUserId"] != target || meta["targetRole"] != role || meta["requestId"] != "user-policy-request" || auditAt.UTC().Format(time.RFC3339Nano) != changedAt || !auditAt.Equal(userAt) {
		t.Fatalf("audit mismatch metadata=%s count=%d timestamp=%s", raw, count, changedAt)
	}
	out := requireCreditResponse(t, call("medium"), 200)
	if out["updatedAt"] != changedAt {
		t.Fatal("noop changed timestamp")
	}
	if _, err := b.db.Exec(ctx, `CREATE FUNCTION test_reject_user_moderation_audit() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN IF NEW.action = ''moderation.setUserRiskLevelOverride'' THEN RAISE EXCEPTION ''audit rejected''; END IF; RETURN NEW; END'`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = b.db.Exec(ctx, `DROP TRIGGER IF EXISTS test_reject_user_moderation_audit ON admin_audit_log`)
		_, _ = b.db.Exec(ctx, `DROP FUNCTION IF EXISTS test_reject_user_moderation_audit()`)
	})
	if _, err := b.db.Exec(ctx, `CREATE TRIGGER test_reject_user_moderation_audit BEFORE INSERT ON admin_audit_log FOR EACH ROW EXECUTE FUNCTION test_reject_user_moderation_audit()`); err != nil {
		t.Fatal(err)
	}
	requireCreditResponse(t, call("low"), 500)
	var level string
	if err := b.db.QueryRow(ctx, `SELECT moderation_block_risk_level_override,updated_at FROM "user" WHERE id=$1`, target).Scan(&level, &userAt); err != nil || level != "medium" || userAt.UTC().Format(time.RFC3339Nano) != changedAt {
		t.Fatalf("audit failure committed mutation: level=%s at=%s err=%v", level, userAt, err)
	}
}
