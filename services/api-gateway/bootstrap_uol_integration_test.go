//go:build integration

package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

func bootstrapTestRequest(b *backend) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPost, "http://localhost:3000/api/internal/auth/bootstrap", nil)
	r.Header.Set("Authorization", "Bearer "+b.config.cronSecret)
	w := httptest.NewRecorder()
	b.handler().ServeHTTP(w, r)
	return w
}

func TestUserBootstrapFirstAdminIsAtomicAndPreservesCredentials(t *testing.T) {
	b := integrationBackend(t)
	b.config.cronSecret = "bootstrap-test-secret"
	setStorageTestSetting(t, b, "SELF_USE_MODE_ENABLED", false)
	t.Setenv("FLUXMEDIA_SUPER_ADMIN_EMAIL", "")
	t.Setenv("FLUXMEDIA_SUPER_ADMIN_PASSWORD", "")
	out := requireCreditResponse(t, bootstrapTestRequest(b), 200)
	if out["success"] != false || out["userId"] != "" {
		t.Fatalf("disabled bootstrap fabricated user: %v", out)
	}
	setStorageTestSetting(t, b, "SELF_USE_MODE_ENABLED", true)
	out = requireCreditResponse(t, bootstrapTestRequest(b), 200)
	if out["success"] != false || out["userId"] != "" {
		t.Fatalf("missing credentials fabricated user: %v", out)
	}

	uid, email := seedAuthUser(t, b)
	t.Setenv("FLUXMEDIA_SUPER_ADMIN_EMAIL", email)
	t.Setenv("FLUXMEDIA_SUPER_ADMIN_PASSWORD", "new-env-value-must-not-reset-existing")
	var original string
	if err := b.db.QueryRow(context.Background(), `SELECT password FROM account WHERE user_id=$1 AND provider_id='credential'`, uid).Scan(&original); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	responses := make(chan *httptest.ResponseRecorder, 6)
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); responses <- bootstrapTestRequest(b) }()
	}
	wg.Wait()
	close(responses)
	for w := range responses {
		out = requireCreditResponse(t, w, 200)
		if out["success"] != true || out["userId"] != uid {
			t.Fatalf("concurrent bootstrap result: %v", out)
		}
	}
	var current, role string
	var verified bool
	if err := b.db.QueryRow(context.Background(), `SELECT role,email_verified,(SELECT password FROM account WHERE user_id=$1 AND provider_id='credential') FROM "user" WHERE id=$1`, uid).Scan(&role, &verified, &current); err != nil {
		t.Fatal(err)
	}
	if role != "super_admin" || !verified || current != original {
		t.Fatal("bootstrap did not preserve existing credential")
	}
	other, otherEmail := seedAuthUser(t, b)
	t.Setenv("FLUXMEDIA_SUPER_ADMIN_EMAIL", otherEmail)
	out = requireCreditResponse(t, bootstrapTestRequest(b), 200)
	if out["userId"] != uid {
		t.Fatalf("existing super admin was ignored: %v", out)
	}
	if err := b.db.QueryRow(context.Background(), `SELECT role FROM "user" WHERE id=$1`, other).Scan(&role); err != nil {
		t.Fatal(err)
	}
	if role != "user" {
		t.Fatal("bootstrap elevated another user after first admin exists")
	}
}

func TestUserBootstrapCreatesMissingCredentialTogether(t *testing.T) {
	b := integrationBackend(t)
	b.config.cronSecret = "bootstrap-test-secret"
	setStorageTestSetting(t, b, "SELF_USE_MODE_ENABLED", true)
	uid, email := seedAuthUser(t, b)
	if _, err := b.db.Exec(context.Background(), `DELETE FROM account WHERE user_id=$1`, uid); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FLUXMEDIA_SUPER_ADMIN_EMAIL", email)
	t.Setenv("FLUXMEDIA_SUPER_ADMIN_PASSWORD", "bootstrap-password-test")
	out := requireCreditResponse(t, bootstrapTestRequest(b), 200)
	if out["userId"] != uid {
		t.Fatalf("wrong bootstrap user: %v", out)
	}
	var hash string
	if err := b.db.QueryRow(context.Background(), `SELECT password FROM account WHERE user_id=$1 AND provider_id='credential'`, uid).Scan(&hash); err != nil {
		t.Fatal(err)
	}
	ok, err := verifyPassword(context.Background(), "bootstrap-password-test", hash)
	if err != nil || !ok {
		t.Fatal("bootstrap credential was not created")
	}
	// The public route remains internal even when bootstrap is configured.
	r := httptest.NewRequest(http.MethodPost, "http://localhost:3000/api/internal/auth/bootstrap", nil)
	w := httptest.NewRecorder()
	b.handler().ServeHTTP(w, r)
	if w.Code != 401 {
		raw, _ := json.Marshal(w.Body.String())
		t.Fatalf("unauthenticated bootstrap=%d %s", w.Code, raw)
	}
}
