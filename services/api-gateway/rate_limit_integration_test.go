//go:build integration

package main

import (
	"context"
	"github.com/redis/go-redis/v9"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestBackendRateLimitRedisSharedThresholdAndSessionBoundary(t *testing.T) {
	b := integrationBackend(t)
	ctx := context.Background()
	b.config.cronSecret = "rate-test-secret"
	setStorageTestSetting(t, b, "RATE_LIMIT_GLOBAL_REQUESTS_PER_MINUTE", 2)
	uid, email := seedAuthUser(t, b)
	cookie := signInTestUser(t, b, email)
	other, _ := seedAuthUser(t, b)
	request := func(identifier, secret string, c *http.Cookie) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "http://localhost/api/internal/rate-limit", strings.NewReader(mustJSON(map[string]any{"identifier": identifier, "type": "global"})))
		r.RemoteAddr = "198.51.100.8:4000"
		r.Header.Set("Content-Type", "application/json")
		if secret != "" {
			r.Header.Set("Authorization", "Bearer "+secret)
		}
		if c != nil {
			r.AddCookie(c)
		}
		w := httptest.NewRecorder()
		b.handler().ServeHTTP(w, r)
		return w
	}
	requireCreditResponse(t, request("analytics-dashboard:"+uid, "", cookie), 401)
	requireCreditResponse(t, request("analytics-dashboard:"+uid, "rate-test-secret", nil), 401)
	requireCreditResponse(t, request("analytics-dashboard:"+other, "rate-test-secret", cookie), 403)
	requireCreditResponse(t, request("operations-dashboard:"+uid, "rate-test-secret", cookie), 403)
	for i := 0; i < 3; i++ {
		out := requireCreditResponse(t, request("analytics-dashboard:"+uid, "rate-test-secret", cookie), 200)
		if out["success"] != (i < 2) {
			t.Fatalf("user window: %v", out)
		}
	}
	// Two backend instances share Redis counters, and changed settings apply immediately.
	identifier := "distributed:" + newRequestID()
	second := &backend{db: b.db, redis: b.redis}
	for i, owner := range []*backend{b, second, b} {
		result, e := owner.checkBackendRateLimit(ctx, identifier, "global")
		if e != nil || result.Success != (i < 2) {
			t.Fatalf("distributed admission %d: %v %v", i, result, e)
		}
	}
	setStorageTestSetting(t, b, "RATE_LIMIT_GLOBAL_REQUESTS_PER_MINUTE", 4)
	result, e := second.checkBackendRateLimit(ctx, identifier, "global")
	if e != nil || !result.Success || result.Limit != 4 || result.Remaining != 1 {
		t.Fatalf("runtime threshold: %v %v", result, e)
	}
	// Exercise actual Redis expiry semantics without a minute-long wall-clock wait.
	key := "fluxmedia:go:rate-limit:expiry:" + newRequestID()
	if e = b.redis.ZAdd(ctx, key, redis.Z{Score: float64(time.Now().Add(-2 * time.Minute).UnixMilli()), Member: "expired"}).Err(); e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { b.redis.Del(context.Background(), key) })
	values, e := b.redis.Eval(ctx, backendRateLua, []string{key}, 1, "fresh").Int64Slice()
	if e != nil || len(values) != 3 || values[0] != 1 || values[1] != 0 {
		t.Fatalf("Redis window expiry: %v %v", values, e)
	}
	// Direct Go dashboard requests have the same scope, without a Next precheck.
	opsFixtureExec(t, b, `UPDATE "user" SET role='admin' WHERE id=$1`, uid)
	setStorageTestSetting(t, b, "RATE_LIMIT_GLOBAL_REQUESTS_PER_MINUTE", 2)
	for i := 0; i < 3; i++ {
		w := authRequest(t, b, "GET", "/api/admin/analytics/users?query=absent&limit=1", "", cookie)
		want := 200
		if i == 2 {
			want = 429
		}
		if w.Code != want {
			t.Fatalf("direct Go limiter: HTTP%d want%d %s", w.Code, want, w.Body.String())
		}
	}
}
