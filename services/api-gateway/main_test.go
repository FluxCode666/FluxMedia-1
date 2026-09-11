// api-gateway 的配置和 HTTP 边界测试。
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

func TestLoadConfigRequiresSafeUpstreamOrigin(t *testing.T) {
	_, err := loadConfig(testEnv(map[string]string{}))
	if err == nil || !strings.Contains(err.Error(), "GO_BACKEND_UPSTREAM_URL") {
		t.Fatalf("missing upstream error = %v", err)
	}

	for _, value := range []string{
		"postgres://db:5432",
		"http://web:3000/api",
		"http://web:3000/?secret=1",
	} {
		_, err := loadConfig(testEnv(map[string]string{"GO_BACKEND_UPSTREAM_URL": value}))
		if err == nil {
			t.Fatalf("upstream %q should be rejected", value)
		}
	}

	cfg, err := loadConfig(testEnv(map[string]string{"GO_BACKEND_UPSTREAM_URL": "http://web:3000/"}))
	if err != nil {
		t.Fatalf("valid upstream rejected: %v", err)
	}
	if cfg.bind != defaultBind || cfg.maxBodyBytes != defaultMaxBodyBytes {
		t.Fatalf("defaults not applied: %+v", cfg)
	}
}

func TestProxyMapsChunkedOversizedBodyTo413(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		_, _ = io.ReadAll(request.Body)
		writer.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	cfg, err := loadConfig(testEnv(map[string]string{
		"GO_BACKEND_UPSTREAM_URL":   upstream.URL,
		"GO_BACKEND_MAX_BODY_BYTES": "4",
	}))
	if err != nil {
		t.Fatal(err)
	}
	gateway := newGateway(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	request := httptest.NewRequest(http.MethodPost, "http://gateway.local/", strings.NewReader("12345"))
	request.ContentLength = -1
	response := httptest.NewRecorder()
	gateway.handler().ServeHTTP(response, request)
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("chunked oversized body status = %d, body=%s", response.Code, response.Body.String())
	}
}

func TestGatewayPreservesPathHeadersAndRequestID(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/models" || request.URL.RawQuery != "page=2" {
			t.Errorf("unexpected upstream URL: %s", request.URL.String())
		}
		if request.Header.Get("Authorization") != "Bearer test-key" {
			t.Errorf("authorization header was not forwarded")
		}
		if request.Header.Get(forwardedByHeader) != forwardedByValue {
			t.Errorf("gateway marker was not forwarded")
		}
		writer.Header().Set("X-Upstream", "ok")
		writer.WriteHeader(http.StatusAccepted)
		_, _ = writer.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	cfg, err := loadConfig(testEnv(map[string]string{"GO_BACKEND_UPSTREAM_URL": upstream.URL}))
	if err != nil {
		t.Fatal(err)
	}
	gateway := newGateway(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	request := httptest.NewRequest(http.MethodGet, "http://gateway.local/v1/models?page=2", nil)
	request.Header.Set("Authorization", "Bearer test-key")
	request.Header.Set(requestIDHeader, "request-42")
	response := httptest.NewRecorder()
	gateway.handler().ServeHTTP(response, request)

	if response.Code != http.StatusAccepted || response.Header().Get("X-Upstream") != "ok" {
		t.Fatalf("unexpected response: status=%d headers=%v", response.Code, response.Header())
	}
	if response.Header().Get(requestIDHeader) != "request-42" {
		t.Fatalf("request ID was not echoed: %q", response.Header().Get(requestIDHeader))
	}
	if response.Body.String() != `{"ok":true}` {
		t.Fatalf("unexpected response body: %s", response.Body.String())
	}
}

func TestGatewayRejectsUnsupportedMethodsAndOversizedBodies(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		t.Errorf("upstream should not receive oversized %s", request.Method)
	}))
	defer upstream.Close()

	cfg, err := loadConfig(testEnv(map[string]string{
		"GO_BACKEND_UPSTREAM_URL":   upstream.URL,
		"GO_BACKEND_MAX_BODY_BYTES": "4",
	}))
	if err != nil {
		t.Fatal(err)
	}
	gateway := newGateway(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))

	methodRequest := httptest.NewRequest(http.MethodTrace, "http://gateway.local/", nil)
	methodResponse := httptest.NewRecorder()
	gateway.handler().ServeHTTP(methodResponse, methodRequest)
	if methodResponse.Code != http.StatusMethodNotAllowed {
		t.Fatalf("TRACE status = %d", methodResponse.Code)
	}

	bodyRequest := httptest.NewRequest(http.MethodPost, "http://gateway.local/", strings.NewReader("12345"))
	bodyResponse := httptest.NewRecorder()
	gateway.handler().ServeHTTP(bodyResponse, bodyRequest)
	if bodyResponse.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized body status = %d", bodyResponse.Code)
	}
}

func TestReadyChecksUpstream(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/" {
			t.Errorf("readiness path = %s", request.URL.Path)
		}
		writer.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()
	cfg, err := loadConfig(testEnv(map[string]string{"GO_BACKEND_UPSTREAM_URL": upstream.URL}))
	if err != nil {
		t.Fatal(err)
	}
	gateway := newGateway(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	response := httptest.NewRecorder()
	gateway.handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "http://gateway.local/readyz", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("ready status = %d, body=%s", response.Code, response.Body.String())
	}
}
