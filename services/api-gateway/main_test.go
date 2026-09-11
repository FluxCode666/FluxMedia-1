package main

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func testEnv(values map[string]string) func(string) (string, bool) {
	return func(key string) (string, bool) {
		value, ok := values[key]
		return value, ok
	}
}

func validEnv(extra map[string]string) map[string]string {
	values := map[string]string{
		"DATABASE_URL":   "postgresql://user:pass@localhost:5432/db",
		"REDIS_HOST":     "localhost",
		"REDIS_PASSWORD": "secret",
	}
	for key, value := range extra {
		values[key] = value
	}
	return values
}

func TestLoadConfigRequiresBackendDependencies(t *testing.T) {
	for _, key := range []string{"DATABASE_URL", "REDIS_HOST", "REDIS_PASSWORD"} {
		values := validEnv(nil)
		delete(values, key)
		if _, err := loadConfig(testEnv(values)); err == nil || !strings.Contains(err.Error(), key) {
			t.Fatalf("missing %s error = %v", key, err)
		}
	}
}

func TestLoadConfigParsesRedisAndTimeouts(t *testing.T) {
	cfg, err := loadConfig(testEnv(validEnv(map[string]string{
		"REDIS_PORT":                        "6380",
		"REDIS_USERNAME":                    "backend",
		"REDIS_DB":                          "7",
		"REDIS_TLS":                         "true",
		"GO_BACKEND_READ_HEADER_TIMEOUT_MS": "5000",
	})))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.redisOptions.Addr != "localhost:6380" || cfg.redisOptions.Username != "backend" || cfg.redisOptions.DB != 7 || cfg.redisOptions.TLSConfig == nil {
		t.Fatalf("unexpected redis options: %+v", cfg.redisOptions)
	}
	if cfg.readHeader.String() != "5s" {
		t.Fatalf("unexpected read header timeout: %s", cfg.readHeader)
	}
}

func TestLoadConfigRejectsInvalidValues(t *testing.T) {
	for key, value := range map[string]string{
		"REDIS_PORT": "not-a-port",
		"REDIS_DB":   "16",
		"REDIS_TLS":  "yes",
	} {
		_, err := loadConfig(testEnv(validEnv(map[string]string{key: value})))
		if err == nil {
			t.Fatalf("%s=%s should be rejected", key, value)
		}
	}
}

func TestBackendHealthAndExplicitUnimplementedRoute(t *testing.T) {
	backend := &backend{
		config: config{maxBodyBytes: 4},
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	handler := backend.handler()

	health := httptest.NewRecorder()
	handler.ServeHTTP(health, httptest.NewRequest(http.MethodGet, "http://backend.local/healthz", nil))
	if health.Code != http.StatusOK || !strings.Contains(health.Body.String(), "go-backend") {
		t.Fatalf("unexpected health response: %d %s", health.Code, health.Body.String())
	}

	route := httptest.NewRecorder()
	handler.ServeHTTP(route, httptest.NewRequest(http.MethodGet, "http://backend.local/api/v1/models", nil))
	if route.Code != http.StatusNotImplemented || !strings.Contains(route.Body.String(), "route_not_migrated") {
		t.Fatalf("unexpected unimplemented response: %d %s", route.Code, route.Body.String())
	}

	oversized := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "http://backend.local/api", strings.NewReader("12345"))
	handler.ServeHTTP(oversized, request)
	if oversized.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized body status = %d", oversized.Code)
	}
}
