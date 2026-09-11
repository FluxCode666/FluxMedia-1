// api-gateway 是 FluxMedia 的 Go HTTP 入口。
//
// 当前阶段它提供稳定的公网入口、请求边界和生命周期管理，并将尚未迁移的页面与
// 业务路由转发到 Next.js 上游。路由代理保持原始 HTTP 契约，使业务可以按路由逐步
// 迁移到 Go，而不需要一次性重写认证、计费和媒体任务状态机。
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	defaultBind         = ":8080"
	defaultMaxBodyBytes = int64(64 << 20)
	defaultReadHeader   = 10 * time.Second
	defaultReadTimeout  = 30 * time.Second
	defaultWriteTimeout = 30 * time.Minute
	defaultIdleTimeout  = 75 * time.Second
	defaultReadyTimeout = 2 * time.Second
	maxMaxBodyBytes     = int64(512 << 20)
	maxTimeout          = 2 * time.Hour
	requestIDHeader     = "X-Request-ID"
	forwardedByHeader   = "X-Forwarded-By"
	forwardedByValue    = "fluxmedia-go-gateway"
)

var requestIDPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

// config 是启动时校验完成的不可变配置。
type config struct {
	bind         string
	upstream     *url.URL
	maxBodyBytes int64
	readHeader   time.Duration
	readTimeout  time.Duration
	writeTimeout time.Duration
	idleTimeout  time.Duration
	readyTimeout time.Duration
}

// gateway 保存代理和健康检查所需的共享客户端。
type gateway struct {
	config       config
	proxy        *httputil.ReverseProxy
	healthClient *http.Client
	logger       *slog.Logger
}

// main 读取配置并启动网关；收到 SIGTERM/SIGINT 时优雅等待在途请求结束。
func main() {
	cfg, err := loadConfig(os.LookupEnv)
	if err != nil {
		fmt.Fprintf(os.Stderr, "api-gateway configuration error: %v\n", err)
		os.Exit(1)
	}
	if len(os.Args) > 1 && os.Args[1] == "--healthcheck" {
		if err := runHealthcheck(cfg); err != nil {
			fmt.Fprintf(os.Stderr, "api-gateway healthcheck failed: %v\n", err)
			os.Exit(1)
		}
		return
	}

	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	server := newGateway(cfg, logger)
	httpServer := &http.Server{
		Addr:              cfg.bind,
		Handler:           server.handler(),
		ReadHeaderTimeout: cfg.readHeader,
		ReadTimeout:       cfg.readTimeout,
		WriteTimeout:      cfg.writeTimeout,
		IdleTimeout:       cfg.idleTimeout,
		MaxHeaderBytes:    32 << 10,
	}

	serverErrors := make(chan error, 1)
	go func() {
		serverErrors <- httpServer.ListenAndServe()
	}()

	shutdownSignal, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()

	logger.Info("api gateway listening", "bind", cfg.bind, "upstream", cfg.upstream.Redacted())
	select {
	case err := <-serverErrors:
		if !errors.Is(err, http.ErrServerClosed) {
			logger.Error("api gateway stopped unexpectedly", "error", err)
			os.Exit(1)
		}
	case <-shutdownSignal.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := httpServer.Shutdown(shutdownCtx); err != nil {
			logger.Error("api gateway graceful shutdown failed", "error", err)
			os.Exit(1)
		}
	}
}

// runHealthcheck 验证网关进程能够连接配置的上游；供 distroless 容器健康检查调用。
func runHealthcheck(cfg config) error {
	probeURL := *cfg.upstream
	probeURL.Path = "/"
	request, err := http.NewRequest(http.MethodGet, probeURL.String(), nil)
	if err != nil {
		return fmt.Errorf("create readiness request: %w", err)
	}
	client := &http.Client{Timeout: cfg.readyTimeout}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("probe upstream: %w", err)
	}
	defer response.Body.Close()
	if _, err := io.Copy(io.Discard, response.Body); err != nil {
		return fmt.Errorf("read readiness response: %w", err)
	}
	if response.StatusCode >= http.StatusInternalServerError {
		return fmt.Errorf("upstream returned status %d", response.StatusCode)
	}
	return nil
}

// loadConfig 解析并校验环境配置。上游地址是必填项，避免网关静默代理到错误服务。
func loadConfig(getenv func(string) (string, bool)) (config, error) {
	upstreamRaw, ok := getenv("GO_BACKEND_UPSTREAM_URL")
	if !ok || strings.TrimSpace(upstreamRaw) == "" {
		return config{}, errors.New("GO_BACKEND_UPSTREAM_URL must be configured")
	}
	upstream, err := parseUpstreamURL(upstreamRaw)
	if err != nil {
		return config{}, err
	}

	bind := getString(getenv, "GO_BACKEND_BIND", defaultBind)
	maxBodyBytes, err := getBoundedInt64(getenv, "GO_BACKEND_MAX_BODY_BYTES", defaultMaxBodyBytes, 1, maxMaxBodyBytes)
	if err != nil {
		return config{}, err
	}
	readHeader, err := getBoundedDuration(getenv, "GO_BACKEND_READ_HEADER_TIMEOUT_MS", defaultReadHeader, time.Millisecond, maxTimeout)
	if err != nil {
		return config{}, err
	}
	readTimeout, err := getBoundedDuration(getenv, "GO_BACKEND_READ_TIMEOUT_MS", defaultReadTimeout, time.Millisecond, maxTimeout)
	if err != nil {
		return config{}, err
	}
	writeTimeout, err := getBoundedDuration(getenv, "GO_BACKEND_WRITE_TIMEOUT_MS", defaultWriteTimeout, time.Millisecond, maxTimeout)
	if err != nil {
		return config{}, err
	}
	idleTimeout, err := getBoundedDuration(getenv, "GO_BACKEND_IDLE_TIMEOUT_MS", defaultIdleTimeout, time.Millisecond, maxTimeout)
	if err != nil {
		return config{}, err
	}
	readyTimeout, err := getBoundedDuration(getenv, "GO_BACKEND_READY_TIMEOUT_MS", defaultReadyTimeout, time.Millisecond, maxTimeout)
	if err != nil {
		return config{}, err
	}

	return config{
		bind:         bind,
		upstream:     upstream,
		maxBodyBytes: maxBodyBytes,
		readHeader:   readHeader,
		readTimeout:  readTimeout,
		writeTimeout: writeTimeout,
		idleTimeout:  idleTimeout,
		readyTimeout: readyTimeout,
	}, nil
}

// parseUpstreamURL 只允许 HTTP(S) origin，且拒绝包含路径、查询或片段的地址。
func parseUpstreamURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return nil, fmt.Errorf("GO_BACKEND_UPSTREAM_URL is invalid: %w", err)
	}
	if parsed.Scheme == "" || parsed.Host == "" {
		return nil, errors.New("GO_BACKEND_UPSTREAM_URL must be an absolute URL")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, fmt.Errorf("GO_BACKEND_UPSTREAM_URL scheme %q is not supported", parsed.Scheme)
	}
	if parsed.Path != "" && parsed.Path != "/" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("GO_BACKEND_UPSTREAM_URL must contain only scheme and host")
	}
	parsed.Path = ""
	return parsed, nil
}

// getString 返回非空配置值，否则使用默认值。
func getString(getenv func(string) (string, bool), key string, fallback string) string {
	value, ok := getenv(key)
	if !ok || strings.TrimSpace(value) == "" {
		return fallback
	}
	return strings.TrimSpace(value)
}

// getBoundedInt64 解析带上下界的整数环境变量。
func getBoundedInt64(getenv func(string) (string, bool), key string, fallback, minimum, maximum int64) (int64, error) {
	raw, ok := getenv(key)
	if !ok || strings.TrimSpace(raw) == "" {
		return fallback, nil
	}
	value, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil || value < minimum || value > maximum {
		return 0, fmt.Errorf("%s must be an integer between %d and %d", key, minimum, maximum)
	}
	return value, nil
}

// getBoundedDuration 解析以毫秒表示且带上下界的超时环境变量。
func getBoundedDuration(getenv func(string) (string, bool), key string, fallback time.Duration, minimum, maximum time.Duration) (time.Duration, error) {
	raw, ok := getenv(key)
	if !ok || strings.TrimSpace(raw) == "" {
		return fallback, nil
	}
	value, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer number of milliseconds", key)
	}
	duration := time.Duration(value) * time.Millisecond
	if duration < minimum || duration > maximum {
		return 0, fmt.Errorf("%s must be between %d and %d milliseconds", key, minimum/time.Millisecond, maximum/time.Millisecond)
	}
	return duration, nil
}

// newGateway 创建不携带客户端凭据的反向代理。Authorization/Cookie 等请求头仍会
// 传给第一方 Next.js 上游，以维持现有会话和 API Key 语义；影子或第三方转发不在此处发生。
func newGateway(cfg config, logger *slog.Logger) *gateway {
	proxy := httputil.NewSingleHostReverseProxy(cfg.upstream)
	proxy.ErrorHandler = func(writer http.ResponseWriter, request *http.Request, err error) {
		logger.ErrorContext(request.Context(), "upstream request failed", "error", err, "request_id", requestID(request))
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			writeJSONError(writer, http.StatusRequestEntityTooLarge, "request_body_too_large", "The request body is too large.")
			return
		}
		writeJSONError(writer, http.StatusBadGateway, "upstream_unavailable", "The backend is temporarily unavailable.")
	}
	proxy.ModifyResponse = func(response *http.Response) error {
		response.Header.Set(forwardedByHeader, forwardedByValue)
		return nil
	}
	return &gateway{
		config:       cfg,
		proxy:        proxy,
		healthClient: &http.Client{Timeout: cfg.readyTimeout},
		logger:       logger,
	}
}

// handler 组合健康检查、请求 ID、请求体限制和统一代理入口。
func (g *gateway) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", g.handleHealth)
	mux.HandleFunc("GET /readyz", g.handleReady)
	mux.HandleFunc("/", g.handleProxy)
	return withRequestID(g.logger, withBodyLimit(g.config.maxBodyBytes, mux))
}

// handleHealth 仅表示 Go 网关进程存活，不访问上游。
func (g *gateway) handleHealth(writer http.ResponseWriter, request *http.Request) {
	writeJSON(writer, http.StatusOK, map[string]string{"status": "ok"})
}

// handleReady 检查 Next.js 上游是否能接受请求，供容器编排进行就绪判断。
func (g *gateway) handleReady(writer http.ResponseWriter, request *http.Request) {
	probeURL := *g.config.upstream
	probeURL.Path = "/"
	probeRequest, err := http.NewRequestWithContext(request.Context(), http.MethodGet, probeURL.String(), nil)
	if err != nil {
		writeJSONError(writer, http.StatusServiceUnavailable, "upstream_unavailable", "The backend is not ready.")
		return
	}
	probeResponse, err := g.healthClient.Do(probeRequest)
	if err != nil {
		writeJSONError(writer, http.StatusServiceUnavailable, "upstream_unavailable", "The backend is not ready.")
		return
	}
	defer probeResponse.Body.Close()
	if _, err := io.Copy(io.Discard, probeResponse.Body); err != nil {
		g.logger.WarnContext(request.Context(), "readiness probe body failed", "error", err)
	}
	if probeResponse.StatusCode >= http.StatusInternalServerError {
		writeJSONError(writer, http.StatusServiceUnavailable, "upstream_unavailable", "The backend is not ready.")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]string{"status": "ready"})
}

// handleProxy 转发所有未被网关自身处理的路径，保留方法、查询参数、Cookie 和授权头。
func (g *gateway) handleProxy(writer http.ResponseWriter, request *http.Request) {
	if request.Method == http.MethodConnect || request.Method == http.MethodTrace {
		writeJSONError(writer, http.StatusMethodNotAllowed, "method_not_allowed", "This HTTP method is not supported.")
		return
	}
	request.Header.Set(forwardedByHeader, forwardedByValue)
	if request.Header.Get("X-Forwarded-Proto") == "" {
		request.Header.Set("X-Forwarded-Proto", forwardedProtocol(request))
	}
	g.proxy.ServeHTTP(writer, request)
}

// withRequestID 为每个请求补充可追踪 ID，并在响应中回显。
func withRequestID(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		id := strings.TrimSpace(request.Header.Get(requestIDHeader))
		if !requestIDPattern.MatchString(id) {
			id = newRequestID()
			request.Header.Set(requestIDHeader, id)
		}
		writer.Header().Set(requestIDHeader, id)
		logger.InfoContext(request.Context(), "http request", "method", request.Method, "path", request.URL.Path, "request_id", id)
		next.ServeHTTP(writer, request)
	})
}

// withBodyLimit 限制请求体大小，避免上传或错误请求耗尽网关内存。
func withBodyLimit(maxBytes int64, next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.ContentLength > maxBytes {
			writeJSONError(writer, http.StatusRequestEntityTooLarge, "request_body_too_large", "The request body is too large.")
			return
		}
		request.Body = http.MaxBytesReader(writer, request.Body, maxBytes)
		next.ServeHTTP(writer, request)
	})
}

// newRequestID 生成不包含敏感信息的 16 字节随机十六进制 ID。
func newRequestID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 10)
	}
	return hex.EncodeToString(bytes[:])
}

// requestID 返回已由中间件校验的请求 ID。
func requestID(request *http.Request) string {
	return request.Header.Get(requestIDHeader)
}

// forwardedProtocol 根据 TLS 状态确定转发协议。
func forwardedProtocol(request *http.Request) string {
	if request.TLS != nil {
		return "https"
	}
	return "http"
}

// writeJSON 编码稳定的 JSON 响应。
func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	if err := json.NewEncoder(writer).Encode(value); err != nil {
		return
	}
}

// writeJSONError 统一网关自身产生的错误结构，不泄露上游内部错误。
func writeJSONError(writer http.ResponseWriter, status int, code, message string) {
	writeJSON(writer, status, map[string]any{
		"error": map[string]string{
			"message": message,
			"type":    "gateway_error",
			"code":    code,
		},
	})
}
