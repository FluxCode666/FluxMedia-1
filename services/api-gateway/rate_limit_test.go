package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestBackendRateLimitFallbackConcurrentAdmissionAndExpiry(t *testing.T) {
	t.Setenv("RATE_LIMIT_STRICT_REQUESTS_PER_MINUTE", "7")
	b := &backend{}
	var allowed atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 40; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, e := b.checkBackendRateLimit(context.Background(), "fallback-user", "strict")
			if e != nil {
				t.Error(e)
			}
			if r.Success {
				allowed.Add(1)
			}
			if r.Remaining < 0 || r.Skipped {
				t.Errorf("invalid limiter result: %v", r)
			}
		}()
	}
	wg.Wait()
	if allowed.Load() != 7 {
		t.Fatalf("admitted %d want 7", allowed.Load())
	}
	b.rateLimits.mu.Lock()
	for k, v := range b.rateLimits.buckets {
		v.reset = time.Now().Add(-time.Second).UnixMilli()
		b.rateLimits.buckets[k] = v
	}
	b.rateLimits.mu.Unlock()
	r, e := b.checkBackendRateLimit(context.Background(), "fallback-user", "strict")
	if e != nil || !r.Success || r.Remaining != 6 {
		t.Fatalf("expired window: %v %v", r, e)
	}
}
func TestBackendRateLimitUsesConnectionIPUnlessTrustedProxy(t *testing.T) {
	t.Setenv("RATE_LIMIT_TRUSTED_PROXY", "false")
	t.Setenv("RATE_LIMIT_UPLOAD_REQUESTS_PER_MINUTE", "2")
	b := &backend{}
	h := b.withBackendRateLimit(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	for i := 0; i < 3; i++ {
		r := httptest.NewRequest("POST", "http://localhost/api/upload/presigned", nil)
		r.RemoteAddr = "198.51.100.9:5000"
		r.Header.Set("X-Forwarded-For", []string{"1.1.1.1", "2.2.2.2", "3.3.3.3"}[i])
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		want := 204
		if i == 2 {
			want = 429
		}
		if w.Code != want || w.Header().Get("X-RateLimit-Limit") != "2" {
			t.Fatalf("HTTP %d want %d headers %v", w.Code, want, w.Header())
		}
	}
	t.Setenv("RATE_LIMIT_TRUSTED_PROXY", "true")
	t.Setenv("RATE_LIMIT_TRUSTED_PROXY_CIDRS", "10.20.0.0/16")
	for _, test := range []struct{ peer, header, want string }{{"198.51.100.9:50", "1.1.1.1", "198.51.100.9"}, {"10.20.1.4:50", "1.1.1.1", "1.1.1.1"}, {"10.20.1.4:50", "bad", "10.20.1.4"}} {
		r := httptest.NewRequest("POST", "http://localhost", nil)
		r.RemoteAddr = test.peer
		r.Header.Set("X-Forwarded-For", test.header)
		if got := backendRateClientIP(r); got != test.want {
			t.Fatalf("IP got %s want %s", got, test.want)
		}
	}
	for _, path := range []string{"/api/v1/images/generations", "/v1/images/generations", "/api/v1/videos", "/api/webhooks/alipay", "/api/images/chat"} {
		if got := backendSensitiveRateType(path); got != "" {
			t.Fatalf("unrequested generic limit on %s", path)
		}
	}
}
