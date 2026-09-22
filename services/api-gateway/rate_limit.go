package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"math"
	"net"
	"net/http"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

type backendRateLimitState struct {
	mu      sync.Mutex
	buckets map[string]backendRateBucket
}
type backendRateBucket struct {
	count int
	reset int64
}
type backendRateResult struct {
	Success   bool  `json:"success"`
	Remaining int   `json:"remaining"`
	Reset     int64 `json:"reset"`
	Limit     int   `json:"limit"`
	Skipped   bool  `json:"skipped"`
}
type backendRateDefinition struct {
	key      string
	fallback int
}

var backendRateDefinitions = map[string]backendRateDefinition{
	"global": {"RATE_LIMIT_GLOBAL_REQUESTS_PER_MINUTE", 100}, "auth": {"RATE_LIMIT_AUTH_REQUESTS_PER_MINUTE", 5}, "ai": {"RATE_LIMIT_AI_REQUESTS_PER_MINUTE", 20}, "payment": {"RATE_LIMIT_PAYMENT_REQUESTS_PER_MINUTE", 10}, "upload": {"RATE_LIMIT_UPLOAD_REQUESTS_PER_MINUTE", 30}, "strict": {"RATE_LIMIT_STRICT_REQUESTS_PER_MINUTE", 3},
}

// Redis owns the sliding window clock and atomic admission across replicas.
// A request denied at capacity does not extend the window indefinitely.
const backendRateLua = `local t=redis.call('TIME');local now=t[1]*1000+math.floor(t[2]/1000);local window=60000;local lim=tonumber(ARGV[1]);redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',now-window);local n=redis.call('ZCARD',KEYS[1]);local allowed=0;if n<lim then redis.call('ZADD',KEYS[1],now,ARGV[2]);n=n+1;allowed=1 end;redis.call('PEXPIRE',KEYS[1],window);local first=redis.call('ZRANGE',KEYS[1],0,0,'WITHSCORES');local reset=now+window;if first[2] then reset=tonumber(first[2])+window end;return {allowed,math.max(0,lim-n),reset}`

func (b *backend) checkBackendRateLimit(ctx context.Context, identifier, kind string) (backendRateResult, error) {
	definition, ok := backendRateDefinitions[kind]
	if !ok {
		return backendRateResult{}, invalid("限流类型无效")
	}
	raw := os.Getenv(definition.key)
	if b.db != nil {
		var e error
		raw, e = b.settingString(ctx, definition.key, strconv.Itoa(definition.fallback))
		if e != nil {
			return backendRateResult{}, e
		}
	}
	limit := definition.fallback
	if n, e := strconv.ParseFloat(strings.TrimSpace(raw), 64); e == nil && n > 0 && n <= float64(math.MaxInt32) && !math.IsNaN(n) {
		limit = int(n)
		if limit < 1 {
			limit = definition.fallback
		}
	}
	hash := sha256.Sum256([]byte(kind + ":" + identifier))
	key := "fluxmedia:go:rate-limit:" + hex.EncodeToString(hash[:])
	result := backendRateResult{Limit: limit}
	if b.redis != nil {
		ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		values, e := b.redis.Eval(ctx, backendRateLua, []string{key}, limit, newRequestID()).Int64Slice()
		if e == nil && len(values) == 3 {
			result.Success = values[0] == 1
			result.Remaining = int(values[1])
			result.Reset = values[2]
			return result, nil
		}
		if ctx.Err() != nil && errors.Is(ctx.Err(), context.Canceled) {
			return result, ctx.Err()
		}
	}
	// Keep the former bounded local fallback in the Go owner. Redis outages
	// never remove admission control, and Next holds no counter or credentials.
	now := time.Now().UnixMilli()
	state := &b.rateLimits
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.buckets == nil {
		state.buckets = map[string]backendRateBucket{}
	}
	if len(state.buckets) >= 10000 {
		for k, v := range state.buckets {
			if v.reset <= now {
				delete(state.buckets, k)
			}
		}
		if _, exists := state.buckets[key]; !exists && len(state.buckets) >= 10000 {
			key = "overflow:" + kind
		}
	}
	bucket := state.buckets[key]
	if bucket.reset <= now {
		bucket = backendRateBucket{reset: now + 60000}
	}
	bucket.count++
	state.buckets[key] = bucket
	result.Success = bucket.count <= limit
	result.Remaining = max(0, limit-bucket.count)
	result.Reset = bucket.reset
	return result, nil
}

// Only the authenticated server adapter can request a user-scoped check. The
// actual user always comes from the verified browser session, never the body.
func (b *backend) handleInternalRateLimit(w http.ResponseWriter, r *http.Request) error {
	noStore(w)
	if !b.cronAuthorized(r) {
		return &apiError{401, "UNAUTHORIZED", "Unauthorized"}
	}
	var input struct {
		Identifier string `json:"identifier"`
		Type       string `json:"type"`
	}
	if e := decodeBody(r, &input); e != nil {
		return e
	}
	if len(input.Identifier) > 1024 {
		return invalid("限流范围无效")
	}
	session, e := b.requireSession(r)
	if e != nil {
		return e
	}
	namespace, userID, ok := strings.Cut(input.Identifier, ":")
	if !ok || userID != session.User.ID {
		return &apiError{403, "FORBIDDEN", "限流身份不匹配"}
	}
	switch namespace {
	case "analytics-dashboard":
	case "admin-analytics-dashboard", "admin-analytics-dashboard-users", "operations-dashboard":
		if !containsString([]string{"observer_admin", "admin", "super_admin"}, session.User.Role) {
			return &apiError{403, "FORBIDDEN", "没有权限执行此操作"}
		}
	default:
		return invalid("限流范围无效")
	}
	result, e := b.checkBackendRateLimit(r.Context(), namespace+":"+session.User.ID, input.Type)
	if e != nil {
		return e
	}
	writeJSON(w, 200, result)
	return nil
}

func backendSensitiveRateType(path string) string {
	if strings.HasPrefix(path, "/api/upload") {
		return "upload"
	}
	if strings.HasPrefix(path, "/api/images/generate") || strings.HasPrefix(path, "/api/images/edit") {
		return "ai"
	}
	return ""
}

func backendDashboardRateScope(path string) string {
	switch path {
	case "/api/analytics/data-dashboard":
		return "analytics-dashboard"
	case "/api/admin/analytics/data-dashboard":
		return "admin-analytics-dashboard"
	case "/api/admin/analytics/users":
		return "admin-analytics-dashboard-users"
	}
	if strings.HasPrefix(path, "/api/admin/operations/") {
		return "operations-dashboard"
	}
	return ""
}

// Forwarding headers are accepted only when the deployment explicitly trusts
// the immediate peer. A direct client cannot rotate a spoofed X-Forwarded-For.
func backendRateClientIP(r *http.Request) string {
	host, _, e := net.SplitHostPort(r.RemoteAddr)
	if e != nil {
		host = r.RemoteAddr
	}
	peer, e := netip.ParseAddr(host)
	if e != nil {
		return "unknown"
	}
	peer = peer.Unmap()
	trusted := false
	enabled := strings.ToLower(strings.TrimSpace(os.Getenv("RATE_LIMIT_TRUSTED_PROXY")))
	if enabled == "true" || enabled == "1" || enabled == "yes" {
		ranges := strings.FieldsFunc(os.Getenv("RATE_LIMIT_TRUSTED_PROXY_CIDRS"), func(r rune) bool { return r == ',' || r == ' ' })
		if len(ranges) == 0 {
			ranges = []string{"127.0.0.0/8", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"}
		}
		for _, value := range ranges {
			if prefix, e := netip.ParsePrefix(value); e == nil && prefix.Contains(peer) {
				trusted = true
				break
			}
		}
	}
	if trusted {
		for _, header := range []string{"CF-Connecting-IP", "X-Real-IP", "X-Forwarded-For"} {
			candidate := strings.TrimSpace(strings.Split(r.Header.Get(header), ",")[0])
			if ip, e := netip.ParseAddr(candidate); e == nil {
				return ip.Unmap().String()
			}
		}
	}
	return peer.String()
}

func writeBackendRateHeaders(w http.ResponseWriter, result backendRateResult) {
	w.Header().Set("X-RateLimit-Limit", strconv.Itoa(result.Limit))
	w.Header().Set("X-RateLimit-Remaining", strconv.Itoa(result.Remaining))
	w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(result.Reset, 10))
}
func (b *backend) withBackendRateLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		kind := backendSensitiveRateType(r.URL.Path)
		scope := backendDashboardRateScope(r.URL.Path)
		if (kind == "" && scope == "") || r.Method == http.MethodOptions {
			next.ServeHTTP(w, r)
			return
		}
		identifier := "ip:" + backendRateClientIP(r)
		if scope != "" {
			session, e := b.requireSession(r)
			if e != nil {
				b.endpoint(func(http.ResponseWriter, *http.Request) error { return e })(w, r)
				return
			}
			identifier = scope + ":" + session.User.ID
			kind = "global"
		}
		result, e := b.checkBackendRateLimit(r.Context(), identifier, kind)
		if e != nil {
			writeJSONError(w, 503, "NOT_READY", "请求限流服务暂不可用")
			return
		}
		writeBackendRateHeaders(w, result)
		if !result.Success {
			seconds := max(int64(1), (result.Reset-time.Now().UnixMilli()+999)/1000)
			w.Header().Set("Retry-After", strconv.FormatInt(seconds, 10))
			writeJSON(w, 429, map[string]any{"error": "Too Many Requests", "message": "请求过于频繁，请稍后再试", "retryAfter": seconds})
			return
		}
		next.ServeHTTP(w, r)
	})
}
