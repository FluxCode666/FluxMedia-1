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

func TestGlobalModerationPolicyPersistsAuditAndSerializesNoops(t *testing.T) {
	b := integrationBackend(t)
	admin, email := seedAuthUser(t, b)
	if _, err := b.db.Exec(context.Background(), `UPDATE "user" SET role='super_admin' WHERE id=$1`, admin); err != nil {
		t.Fatal(err)
	}
	cookie := signInTestUser(t, b, email)
	setStorageTestSetting(t, b, globalModerationPolicySetting, "low")
	t.Cleanup(func() {
		_, _ = b.db.Exec(context.Background(), `DELETE FROM admin_audit_log WHERE admin_user_id=$1 AND action=$2`, admin, globalModerationPolicyAction)
	})
	call := func(level string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPut, "http://localhost:3000/api/system-settings/moderation-policy", strings.NewReader(mustJSON(map[string]any{"level": level, "reason": "  policy reason  "})))
		r.AddCookie(cookie)
		r.Header.Set(requestIDHeader, "policy-request")
		w := httptest.NewRecorder()
		b.handler().ServeHTTP(w, r)
		return w
	}
	var wg sync.WaitGroup
	results := make(chan *httptest.ResponseRecorder, 6)
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); results <- call("medium") }()
	}
	wg.Wait()
	close(results)
	changes := 0
	var changedAt, auditID string
	for w := range results {
		out := requireCreditResponse(t, w, 200)
		if out["changed"] == true {
			changes++
			auditID = out["auditLogId"].(string)
			changedAt = out["updatedAt"].(string)
		} else if out["auditLogId"] != nil {
			t.Fatal("noop manufactured audit id")
		}
	}
	if changes != 1 || auditID == "" {
		t.Fatalf("concurrent writes=%d audit=%s", changes, auditID)
	}
	var raw []byte
	var reason string
	var at time.Time
	if err := b.db.QueryRow(context.Background(), `SELECT metadata,reason,created_at FROM admin_audit_log WHERE id=$1`, auditID).Scan(&raw, &reason, &at); err != nil {
		t.Fatal(err)
	}
	var metadata map[string]any
	_ = json.Unmarshal(raw, &metadata)
	if reason != "policy reason" || metadata["actorUserId"] != admin || metadata["requestId"] != "policy-request" || metadata["targetRole"] != nil || at.UTC().Format(time.RFC3339Nano) != changedAt {
		t.Fatalf("audit metadata=%s reason=%s at=%s", raw, reason, changedAt)
	}
	unchanged := requireCreditResponse(t, call("medium"), 200)
	if unchanged["updatedAt"] != changedAt {
		t.Fatal("noop changed policy timestamp")
	}
	for i := 0; i < 11; i++ {
		level := "low"
		if i%2 == 1 {
			level = "high"
		}
		requireCreditResponse(t, call(level), 200)
	}
	get := requireCreditResponse(t, authRequest(t, b, http.MethodGet, "/api/system-settings/moderation-policy", "", cookie), 200)
	audits := get["recentAudits"].([]any)
	if len(audits) != 10 {
		t.Fatalf("recent audits=%d", len(audits))
	}
	for _, item := range audits {
		audit := item.(map[string]any)
		if audit["adminUserId"] != admin || audit["before"] == nil || audit["after"] == nil {
			t.Fatalf("audit data missing: %v", audit)
		}
	}
	_, ordinaryEmail := seedAuthUser(t, b)
	ordinaryCookie := signInTestUser(t, b, ordinaryEmail)
	requireCreditResponse(t, authRequest(t, b, http.MethodPut, "/api/system-settings/moderation-policy", `{"level":"high","reason":"forbidden"}`, ordinaryCookie), 403)
	// A rejected audit INSERT rolls back the preceding setting UPDATE.
	if _, err := b.db.Exec(context.Background(), `CREATE FUNCTION test_reject_global_moderation_audit() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN IF NEW.action = ''moderation.setGlobalRiskLevel'' THEN RAISE EXCEPTION ''audit rejected''; END IF; RETURN NEW; END'`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = b.db.Exec(context.Background(), `DROP TRIGGER IF EXISTS test_reject_global_moderation_audit ON admin_audit_log`)
		_, _ = b.db.Exec(context.Background(), `DROP FUNCTION IF EXISTS test_reject_global_moderation_audit()`)
	})
	if _, err := b.db.Exec(context.Background(), `CREATE TRIGGER test_reject_global_moderation_audit BEFORE INSERT ON admin_audit_log FOR EACH ROW EXECUTE FUNCTION test_reject_global_moderation_audit()`); err != nil {
		t.Fatal(err)
	}
	requireCreditResponse(t, call("medium"), 500)
	var current string
	if err := b.db.QueryRow(context.Background(), `SELECT value#>>'{}' FROM system_setting WHERE key=$1`, globalModerationPolicySetting).Scan(&current); err != nil || current != "low" {
		t.Fatalf("failed audit committed policy=%s err=%v", current, err)
	}
}

func TestGlobalModerationPolicyReadsFallbackAndRejectsMissingWriteRow(t *testing.T) {
	b := integrationBackend(t)
	admin, email := seedAuthUser(t, b)
	if _, err := b.db.Exec(context.Background(), `UPDATE "user" SET role='super_admin' WHERE id=$1`, admin); err != nil {
		t.Fatal(err)
	}
	cookie := signInTestUser(t, b, email)
	setStorageTestSetting(t, b, globalModerationPolicySetting, map[string]any{"invalid": true})
	t.Cleanup(func() {
		_, _ = b.db.Exec(context.Background(), `DELETE FROM admin_audit_log WHERE admin_user_id=$1 AND action=$2`, admin, globalModerationPolicyAction)
	})
	out := requireCreditResponse(t, authRequest(t, b, http.MethodGet, "/api/system-settings/moderation-policy", "", cookie), 200)
	policy := out["policy"].(map[string]any)
	if policy["globalDefault"] != "high" || policy["source"] != "fallback_high" {
		t.Fatalf("invalid policy fallback=%v", policy)
	}
	requireCreditResponse(t, authRequest(t, b, http.MethodPut, "/api/system-settings/moderation-policy", `{"level":"medium","reason":"repair invalid value"}`, cookie), 200)
	if _, err := b.db.Exec(context.Background(), `DELETE FROM system_setting WHERE key=$1`, globalModerationPolicySetting); err != nil {
		t.Fatal(err)
	}
	requireCreditResponse(t, authRequest(t, b, http.MethodPut, "/api/system-settings/moderation-policy", `{"level":"high","reason":"missing"}`, cookie), 409)
}
