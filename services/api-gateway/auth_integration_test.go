//go:build integration

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

func integrationBackend(t *testing.T) *backend {
	t.Helper()
	raw := os.Getenv("GO_BACKEND_TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("GO_BACKEND_TEST_DATABASE_URL must point to a dedicated test database")
	}
	u, err := url.Parse(raw)
	if err != nil || !strings.HasPrefix(strings.TrimPrefix(u.Path, "/"), "fluxmedia_go_test_") {
		t.Fatal("refusing to write outside a fluxmedia_go_test_* database")
	}
	cfg, err := loadConfig(func(key string) (string, bool) {
		if key == "DATABASE_URL" {
			return raw, true
		}
		if key == "BETTER_AUTH_SECRET" {
			return "test-auth-secret", true
		}
		if key == "BETTER_AUTH_URL" {
			return "http://localhost:3000", true
		}
		return os.LookupEnv(key)
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	b, err := newBackend(ctx, cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(b.close)
	if _, err := runMigrations(ctx, b.db, "../../packages/database/drizzle"); err != nil {
		t.Fatal(err)
	}
	return b
}
func seedAuthUser(t *testing.T, b *backend) (string, string) {
	t.Helper()
	id := "test-" + newRequestID()
	email := id + "@gmail.com"
	if _, err := b.db.Exec(context.Background(), `INSERT INTO "user"(id,name,email,email_verified,role) VALUES($1,'Test',$2,true,'user')`, id, email); err != nil {
		t.Fatal(err)
	}
	if _, err := b.db.Exec(context.Background(), `INSERT INTO account(id,account_id,provider_id,user_id,password) VALUES($1,$1,'credential',$1,$2)`, id, nodePasswordFixture); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, err := b.db.Exec(context.Background(), `DELETE FROM "user" WHERE id=$1`, id)
		if err != nil {
			t.Error(err)
		}
	})
	return id, email
}
func authRequest(t *testing.T, b *backend, method, path, body string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, "http://localhost:3000"+path, strings.NewReader(body))
	// Each test request represents a distinct trusted connection for limiter isolation.
	r.RemoteAddr = fmt.Sprintf("127.0.0.%d:1234", time.Now().UnixNano()%250+1)
	r.Header.Set("Content-Type", "application/json")
	for _, cookie := range cookies {
		r.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	b.handler().ServeHTTP(w, r)
	return w
}
func signInTestUser(t *testing.T, b *backend, email string) *http.Cookie {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"email": email, "password": "ＦluxMedia-测试"})
	w := authRequest(t, b, "POST", "/api/auth/sign-in/email", string(body))
	if w.Code != 200 {
		t.Fatalf("login failed: %d %s", w.Code, w.Body.String())
	}
	for _, cookie := range w.Result().Cookies() {
		if cookie.Name == "better-auth.session_token" {
			return cookie
		}
	}
	t.Fatal("login did not set session cookie")
	return nil
}
func TestGoAuthExistingCredentialsAndSessionLifecycle(t *testing.T) {
	b := integrationBackend(t)
	id, email := seedAuthUser(t, b)
	cookie := signInTestUser(t, b, email)
	w := authRequest(t, b, "GET", "/api/session/current", "", cookie)
	if w.Code != 200 || !strings.Contains(w.Body.String(), id) {
		t.Fatalf("session failed: %d %s", w.Code, w.Body.String())
	}
	tampered := *cookie
	tampered.Value += "x"
	w = authRequest(t, b, "GET", "/api/session/current", "", &tampered)
	if strings.TrimSpace(w.Body.String()) != "null" {
		t.Fatal("forged cookie accepted")
	}
	w = authRequest(t, b, "POST", "/api/auth/update-user", `{"name":"Changed","role":"super_admin"}`, cookie)
	if w.Code != 400 {
		t.Fatal("mass-assignment attempt accepted")
	}
	w = authRequest(t, b, "POST", "/api/auth/update-user", `{"name":"Changed"}`, cookie)
	if w.Code != 200 {
		t.Fatalf("profile update failed: %s", w.Body.String())
	}
	w = authRequest(t, b, "POST", "/api/auth/change-password", `{"currentPassword":"ＦluxMedia-测试","newPassword":"New-test-password","revokeOtherSessions":true}`, cookie)
	if w.Code != 200 {
		t.Fatalf("password update failed: %s", w.Body.String())
	}
	var password string
	if err := b.db.QueryRow(context.Background(), `SELECT password FROM account WHERE user_id=$1`, id).Scan(&password); err != nil {
		t.Fatal(err)
	}
	if valid, err := verifyPassword(context.Background(), "New-test-password", password); err != nil || !valid {
		t.Fatal("password not persisted")
	}
	w = authRequest(t, b, "POST", "/api/auth/sign-out", `{}`, cookie)
	if w.Code != 200 {
		t.Fatal("sign-out failed")
	}
	w = authRequest(t, b, "GET", "/api/auth/get-session", "", cookie)
	if strings.TrimSpace(w.Body.String()) != "null" {
		t.Fatal("session still valid after sign-out")
	}
}
func TestGoAuthBanAndSessionOwnership(t *testing.T) {
	b := integrationBackend(t)
	id, email := seedAuthUser(t, b)
	otherID, otherEmail := seedAuthUser(t, b)
	cookie := signInTestUser(t, b, email)
	otherCookie := signInTestUser(t, b, otherEmail)
	token := verifySessionCookie(otherCookie.Value, b.config.authSecret)
	body, _ := json.Marshal(map[string]string{"token": token})
	w := authRequest(t, b, "POST", "/api/auth/revoke-session", string(body), cookie)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	w = authRequest(t, b, "GET", "/api/session/current", "", otherCookie)
	if !strings.Contains(w.Body.String(), otherID) {
		t.Fatal("revoked another user's session")
	}
	if _, err := b.db.Exec(context.Background(), `UPDATE "user" SET banned=true WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	w = authRequest(t, b, "POST", "/api/auth/update-user", `{"name":"banned"}`, cookie)
	if w.Code != 403 {
		t.Fatal("banned session allowed to mutate")
	}
	body, _ = json.Marshal(map[string]string{"email": email, "password": "ＦluxMedia-测试"})
	w = authRequest(t, b, "POST", "/api/auth/sign-in/email", string(body))
	if w.Code != 403 {
		t.Fatal("banned user allowed to sign in")
	}
}
func TestMigrationsAreIdempotentAndPreserveExistingData(t *testing.T) {
	b := integrationBackend(t)
	id, _ := seedAuthUser(t, b)
	for i := 0; i < 2; i++ {
		count, err := runMigrations(context.Background(), b.db, "../../packages/database/drizzle")
		if err != nil || count != 0 {
			t.Fatalf("repeat migrations: %d %v", count, err)
		}
	}
	var n int
	if err := b.db.QueryRow(context.Background(), `SELECT count(*) FROM "user" WHERE id=$1`, id).Scan(&n); err != nil || n != 1 {
		t.Fatal("existing user not preserved")
	}
}

func TestRegistrationCodeConsumptionAndPasswordReset(t *testing.T) {
	b := integrationBackend(t)
	var captured []outgoingMail
	b.mailDelivery = func(_ context.Context, m outgoingMail) error { captured = append(captured, m); return nil }
	if _, err := b.db.Exec(context.Background(), `INSERT INTO system_setting(key,value) VALUES('SELF_USE_MODE_ENABLED','false') ON CONFLICT(key) DO UPDATE SET value='false'`); err != nil {
		t.Fatal(err)
	}
	email := "signup-" + newRequestID() + "@gmail.com"
	t.Cleanup(func() {
		if _, err := b.db.Exec(context.Background(), `DELETE FROM "user" WHERE email=$1`, email); err != nil {
			t.Error(err)
		}
		if _, err := b.db.Exec(context.Background(), `DELETE FROM registration_identity WHERE email=$1`, canonicalEmail(email)); err != nil {
			t.Error(err)
		}
		if _, err := b.db.Exec(context.Background(), `DELETE FROM verification WHERE identifier=$1`, "registration-email-code:"+email); err != nil {
			t.Error(err)
		}
	})
	payload, _ := json.Marshal(map[string]string{"email": email})
	w := authRequest(t, b, "POST", "/api/auth/registration-verification", string(payload))
	if w.Code != 200 || len(captured) != 1 {
		t.Fatalf("send code: %d %s", w.Code, w.Body.String())
	}
	var value string
	if err := b.db.QueryRow(context.Background(), `SELECT value FROM verification WHERE identifier=$1`, "registration-email-code:"+email).Scan(&value); err != nil {
		t.Fatal(err)
	}
	code, _, _ := strings.Cut(value, "|")
	payload, _ = json.Marshal(map[string]string{"email": email, "password": "Signup-test-password", "name": "New user", "verificationCode": "wrong"})
	w = authRequest(t, b, "POST", "/api/auth/sign-up/email", string(payload))
	if w.Code != 400 {
		t.Fatal("bad OTP accepted")
	}
	if err := b.db.QueryRow(context.Background(), `SELECT value FROM verification WHERE identifier=$1`, "registration-email-code:"+email).Scan(&value); err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(value, "|1") {
		t.Fatal("failed OTP attempt not persisted")
	}
	payload, _ = json.Marshal(map[string]string{"email": email, "password": "Signup-test-password", "name": "New user", "verificationCode": code})
	w = authRequest(t, b, "POST", "/api/auth/sign-up/email", string(payload))
	if w.Code != 200 {
		t.Fatalf("signup failed: %s", w.Body.String())
	}
	var userID string
	if err := b.db.QueryRow(context.Background(), `SELECT user_id FROM registration_identity WHERE email=$1`, canonicalEmail(email)).Scan(&userID); err != nil || userID == "" {
		t.Fatal("identity was not saved")
	}
	w = authRequest(t, b, "POST", "/api/auth/sign-up/email", string(payload))
	if w.Code != 400 {
		t.Fatal("duplicate registration accepted")
	}
	payload, _ = json.Marshal(map[string]string{"email": email, "redirectTo": "/reset-password"})
	w = authRequest(t, b, "POST", "/api/auth/request-password-reset", string(payload))
	if w.Code != 200 || len(captured) != 2 {
		t.Fatalf("reset request failed: %s", w.Body.String())
	}
	var identifier string
	if err := b.db.QueryRow(context.Background(), `SELECT identifier FROM verification WHERE value=$1 AND identifier LIKE 'reset-password:%'`, userID).Scan(&identifier); err != nil {
		t.Fatal(err)
	}
	token := strings.TrimPrefix(identifier, "reset-password:")
	payload, _ = json.Marshal(map[string]string{"token": token, "newPassword": "Reset-test-password"})
	w = authRequest(t, b, "POST", "/api/auth/reset-password", string(payload))
	if w.Code != 200 {
		t.Fatalf("reset failed: %s", w.Body.String())
	}
	w = authRequest(t, b, "POST", "/api/auth/reset-password", string(payload))
	if w.Code != 400 {
		t.Fatal("reset token replay accepted")
	}
	var n int
	if err := b.db.QueryRow(context.Background(), `SELECT count(*) FROM session WHERE user_id=$1`, userID).Scan(&n); err != nil || n != 0 {
		t.Fatal("reset did not revoke sessions")
	}
}
func TestCreditsAPIPreservesQuotaAndExpiresOnce(t *testing.T) {
	b := integrationBackend(t)
	id, _ := seedAuthUser(t, b)
	key := "test-key-" + newRequestID()
	hash := sha256.Sum256([]byte(key))
	keyID := newRequestID()
	if _, err := b.db.Exec(context.Background(), `INSERT INTO external_api_key(id,user_id,key_prefix,key_hash,last_four,credit_limit,credits_used) VALUES($1,$2,'test',$3,'last',100,20)`, keyID, id, hex.EncodeToString(hash[:])); err != nil {
		t.Fatal(err)
	}
	if _, err := b.db.Exec(context.Background(), `INSERT INTO credits_balance(id,user_id,balance,total_earned) VALUES($1,$2,30,30)`, newRequestID(), id); err != nil {
		t.Fatal(err)
	}
	if _, err := b.db.Exec(context.Background(), `INSERT INTO credits_batch(id,user_id,amount,remaining,source_type,expires_at) VALUES($1,$2,10,10,'bonus',now()-interval '1 day')`, newRequestID(), id); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		r := httptest.NewRequest("GET", "/api/v1/credits", nil)
		r.Header.Set("Authorization", "Bearer "+key)
		w := httptest.NewRecorder()
		b.handler().ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("credits failed: %s", w.Body.String())
		}
		var result struct {
			Account struct {
				Balance float64 `json:"balance"`
			} `json:"account"`
			Key struct {
				Remaining float64 `json:"credits_remaining"`
				LastUsed  string  `json:"last_used_at"`
			} `json:"api_key"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if result.Account.Balance != 20 || result.Key.Remaining != 80 {
			t.Fatalf("incorrect balance or quota: %s", w.Body.String())
		}
		if _, err := time.Parse(time.RFC3339Nano, result.Key.LastUsed); err != nil {
			t.Fatal("invalid timestamp contract")
		}
	}
	var count int
	if err := b.db.QueryRow(context.Background(), `SELECT count(*) FROM credits_transaction WHERE user_id=$1 AND type='expiration'`, id).Scan(&count); err != nil || count != 1 {
		t.Fatal("expiration not idempotent")
	}
}

func TestExternalModelCatalogHonorsKeyGroupAndDisabledModels(t *testing.T) {
	b := integrationBackend(t)
	userID, _ := seedAuthUser(t, b)
	key := "test-key-" + newRequestID()
	hash := sha256.Sum256([]byte(key))
	groupID := newRequestID()
	memberID := newRequestID()
	if _, err := b.db.Exec(context.Background(), `INSERT INTO image_backend_group(id,name) VALUES($1,'Test group')`, groupID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := b.db.Exec(context.Background(), `DELETE FROM image_backend_group WHERE id=$1`, groupID); err != nil {
			t.Error(err)
		}
	})
	if _, err := b.db.Exec(context.Background(), `INSERT INTO image_backend_member(id,type,name,supported_model_ids) VALUES($1,'api','Test member','["gpt-image-2","sora2","disabled-test-model"]')`, memberID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := b.db.Exec(context.Background(), `DELETE FROM image_backend_member WHERE id=$1`, memberID); err != nil {
			t.Error(err)
		}
	})
	if _, err := b.db.Exec(context.Background(), `INSERT INTO image_backend_member_group(id,member_id,group_id) VALUES($1,$2,$3)`, newRequestID(), memberID, groupID); err != nil {
		t.Fatal(err)
	}
	if _, err := b.db.Exec(context.Background(), `INSERT INTO external_api_key(id,user_id,key_prefix,key_hash,last_four,generation_group_id) VALUES($1,$2,'test',$3,'last',$4)`, newRequestID(), userID, hex.EncodeToString(hash[:]), groupID); err != nil {
		t.Fatal(err)
	}
	if _, err := b.db.Exec(context.Background(), `INSERT INTO system_setting(key,value) VALUES('MODEL_MARKETPLACE_CONFIG','{"version":2,"imageByModel":{"disabled-test-model":{"enabled":false}},"videoByFamily":{}}') ON CONFLICT(key) DO UPDATE SET value=excluded.value`); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("GET", "/v1/models", nil)
	r.Header.Set("Authorization", "Bearer "+key)
	w := httptest.NewRecorder()
	b.handler().ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var response struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if len(response.Data) != 2 || response.Data[0].ID != "gpt-image-2" || response.Data[1].ID != "sora2" {
		t.Fatalf("unexpected model catalog: %s", w.Body.String())
	}
	if _, err := b.db.Exec(context.Background(), `UPDATE image_backend_member SET is_enabled=false WHERE id=$1`, memberID); err != nil {
		t.Fatal(err)
	}
	w = httptest.NewRecorder()
	b.handler().ServeHTTP(w, r)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"data":[]`) {
		t.Fatal("disabled member was advertised")
	}
	r = httptest.NewRequest("GET", "/v1/models", nil)
	w = httptest.NewRecorder()
	b.handler().ServeHTTP(w, r)
	if w.Code != 401 || !strings.Contains(w.Body.String(), `"type":"invalid_request_error"`) {
		t.Fatal("invalid auth error contract")
	}
}
