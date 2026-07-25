// media-upstream-proxy 是 Adobe direct 专用的受控 TLS 转发器。
//
// 使用方：FluxMedia Web 进程把 Adobe IMS、Firefly 图片与视频请求发送到本服务；
// 本服务只接受代码内精确列出的 Adobe HTTPS 主机，不提供默认上游、动态主机扩展、
// 重定向、上游会话状态持久化或挑战绕过行为。
//
// 关键依赖：bogdanfinn/tls-client 提供 Adobe 直连需要的浏览器 TLS 指纹。共享密钥
// 仅用于入站鉴权，启动日志、健康响应和错误响应均不得包含密钥或请求凭据。
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	fhttp "github.com/bogdanfinn/fhttp"
	tls_client "github.com/bogdanfinn/tls-client"
	"github.com/bogdanfinn/tls-client/profiles"
)

const (
	proxyBind            = ":3021"
	proxyTLSProfile      = "chrome_146"
	defaultTimeoutSecs   = 300
	maxTimeoutSecs       = 900
	defaultMaxBodyMB     = 64
	maxBodyMB            = 256
	requestEnvelopeSlack = int64(1 << 20)
)

var allowedAdobeHosts = map[string]struct{}{
	"adobeid-na1.services.adobe.com": {},
	"firefly-3p.ff.adobe.io":         {},
	"firefly.adobe.com":              {},
	"firefly.adobe.io":               {},
	"ims-na1.adobelogin.com":         {},
}

// proxyConfig 是启动时完成校验的不可变配置。
type proxyConfig struct {
	secret       string
	timeout      time.Duration
	maxBodyBytes int64
}

// requestPayload 是 Web 进程发送的单次 Adobe 请求。
type requestPayload struct {
	Method      string            `json:"method"`
	TargetURL   string            `json:"targetUrl"`
	Headers     map[string]string `json:"headers"`
	HeaderOrder []string          `json:"headerOrder"`
	BodyBase64  string            `json:"bodyBase64"`
}

// responsePayload 是代理返回给 Web 进程的 Adobe 响应。
type responsePayload struct {
	Status     int                 `json:"status"`
	Headers    map[string][]string `json:"headers"`
	BodyBase64 string              `json:"bodyBase64"`
}

// proxyClient 是生产 TLS client 与测试桩共享的最小接口。
type proxyClient interface {
	Do(request *fhttp.Request) (*fhttp.Response, error)
	CloseIdleConnections()
}

// proxyServer 持有已校验配置和无会话状态的并发安全 TLS client。
type proxyServer struct {
	config proxyConfig
	client proxyClient
}

// main 校验必需配置并启动具备超时和优雅关闭的 HTTP 服务。
func main() {
	config, err := loadProxyConfig(os.Getenv)
	if err != nil {
		log.Fatalf("media-upstream-proxy configuration error: %v", err)
	}

	server, err := newProxyServer(config)
	if err != nil {
		log.Fatalf("media-upstream-proxy client initialization failed: %v", err)
	}
	defer server.client.CloseIdleConnections()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", server.handleHealth)
	mux.HandleFunc("POST /request", server.handleRequest)

	httpServer := &http.Server{
		Addr:              proxyBind,
		Handler:           mux,
		ReadHeaderTimeout: 15 * time.Second,
		ReadTimeout:       90 * time.Second,
		WriteTimeout:      config.timeout + 30*time.Second,
		IdleTimeout:       65 * time.Second,
		MaxHeaderBytes:    32 << 10,
	}

	log.Printf("media-upstream-proxy listening on %s", proxyBind)
	serverErrors := make(chan error, 1)
	go func() {
		serverErrors <- httpServer.ListenAndServe()
	}()

	shutdownSignal, stopSignals := signal.NotifyContext(
		context.Background(),
		os.Interrupt,
		syscall.SIGTERM,
	)
	defer stopSignals()

	select {
	case err := <-serverErrors:
		if !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("media-upstream-proxy server error: %v", err)
		}
	case <-shutdownSignal.Done():
		shutdownContext, cancelShutdown := context.WithTimeout(
			context.Background(),
			30*time.Second,
		)
		defer cancelShutdown()
		if err := httpServer.Shutdown(shutdownContext); err != nil {
			log.Printf("media-upstream-proxy graceful shutdown failed: %v", err)
		}
	}
}

// loadProxyConfig 读取并严格校验 Adobe direct 代理配置。
func loadProxyConfig(getenv func(string) string) (proxyConfig, error) {
	secret := strings.TrimSpace(getenv("ADOBE_DIRECT_PROXY_SECRET"))
	if secret == "" {
		return proxyConfig{}, errors.New("ADOBE_DIRECT_PROXY_SECRET must be configured")
	}

	timeoutSecs, err := parseBoundedPositiveInt(
		getenv("ADOBE_DIRECT_PROXY_TIMEOUT_SECONDS"),
		defaultTimeoutSecs,
		maxTimeoutSecs,
		"ADOBE_DIRECT_PROXY_TIMEOUT_SECONDS",
	)
	if err != nil {
		return proxyConfig{}, err
	}

	maxBodyMegabytes, err := parseBoundedPositiveInt(
		getenv("ADOBE_DIRECT_PROXY_MAX_BODY_MB"),
		defaultMaxBodyMB,
		maxBodyMB,
		"ADOBE_DIRECT_PROXY_MAX_BODY_MB",
	)
	if err != nil {
		return proxyConfig{}, err
	}

	return proxyConfig{
		secret:       secret,
		timeout:      time.Duration(timeoutSecs) * time.Second,
		maxBodyBytes: int64(maxBodyMegabytes) << 20,
	}, nil
}

// parseBoundedPositiveInt 解析有上界的正整数环境变量，空值使用安全默认值。
func parseBoundedPositiveInt(
	value string,
	fallback int,
	maximum int,
	name string,
) (int, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(trimmed)
	if err != nil || parsed <= 0 || parsed > maximum {
		return 0, fmt.Errorf("%s must be an integer between 1 and %d", name, maximum)
	}
	return parsed, nil
}

// newProxyServer 构造不保存 Cookie 且不跟随重定向的 Adobe TLS client。
func newProxyServer(config proxyConfig) (*proxyServer, error) {
	profile, ok := profiles.MappedTLSClients[proxyTLSProfile]
	if !ok {
		return nil, fmt.Errorf("TLS profile %s is unavailable", proxyTLSProfile)
	}

	client, err := tls_client.NewHttpClient(
		tls_client.NewNoopLogger(),
		tls_client.WithTimeoutSeconds(int(config.timeout/time.Second)),
		tls_client.WithClientProfile(profile),
		tls_client.WithNotFollowRedirects(),
		tls_client.WithDisableHttp3(),
		tls_client.WithCatchPanics(),
	)
	if err != nil {
		return nil, fmt.Errorf("create TLS client: %w", err)
	}
	return &proxyServer{config: config, client: client}, nil
}

// handleHealth 返回不包含配置、目标或密钥的就绪状态。
func (s *proxyServer) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

// handleRequest 校验鉴权和严格 JSON 输入，再执行一次 Adobe 转发。
func (s *proxyServer) handleRequest(w http.ResponseWriter, request *http.Request) {
	if !constantTimeSecretEqual(
		request.Header.Get("X-Proxy-Secret"),
		s.config.secret,
	) {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	defer request.Body.Close()
	decoder := json.NewDecoder(http.MaxBytesReader(
		w,
		request.Body,
		requestEnvelopeLimit(s.config.maxBodyBytes),
	))
	decoder.DisallowUnknownFields()

	var payload requestPayload
	if err := decoder.Decode(&payload); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request payload")
		return
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "invalid request payload")
		return
	}

	result, err := s.forward(request.Context(), payload)
	if err != nil {
		log.Printf("Adobe upstream request failed: %v", err)
		writeError(w, http.StatusBadGateway, "Adobe upstream request failed")
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// constantTimeSecretEqual 使用固定长度摘要进行恒定时间密钥比较。
func constantTimeSecretEqual(provided string, expected string) bool {
	providedHash := sha256.Sum256([]byte(provided))
	expectedHash := sha256.Sum256([]byte(expected))
	return subtle.ConstantTimeCompare(providedHash[:], expectedHash[:]) == 1
}

// requestEnvelopeLimit 计算 Base64 请求体和固定 JSON 字段允许占用的最大字节数。
func requestEnvelopeLimit(maxBodyBytes int64) int64 {
	return maxBodyBytes + maxBodyBytes/3 + requestEnvelopeSlack
}

// forward 构造并发送单次 Adobe 请求，不重定向且不持久化上游 Cookie。
func (s *proxyServer) forward(
	ctx context.Context,
	payload requestPayload,
) (*responsePayload, error) {
	targetURL, err := buildAdobeTargetURL(payload.TargetURL)
	if err != nil {
		return nil, err
	}

	method := strings.ToUpper(strings.TrimSpace(payload.Method))
	if method != fhttp.MethodGet && method != fhttp.MethodPost {
		return nil, errors.New("only GET and POST methods are allowed")
	}

	body, err := decodeBody(payload.BodyBase64, s.config.maxBodyBytes)
	if err != nil {
		return nil, err
	}

	var reader io.Reader
	if len(body) > 0 {
		reader = bytes.NewReader(body)
	}
	upstreamRequest, err := fhttp.NewRequestWithContext(
		ctx,
		method,
		targetURL,
		reader,
	)
	if err != nil {
		return nil, fmt.Errorf("create Adobe request: %w", err)
	}
	applyHeaders(upstreamRequest, payload.Headers, payload.HeaderOrder)

	response, err := s.client.Do(upstreamRequest)
	if err != nil {
		return nil, fmt.Errorf("send Adobe request: %w", err)
	}
	defer response.Body.Close()

	responseBody, err := readLimited(response.Body, s.config.maxBodyBytes)
	if err != nil {
		return nil, err
	}
	return &responsePayload{
		Status:     response.StatusCode,
		Headers:    mapHeaders(response.Header),
		BodyBase64: base64.StdEncoding.EncodeToString(responseBody),
	}, nil
}

// buildAdobeTargetURL 校验绝对 HTTPS URL 与精确 Adobe 主机白名单。
func buildAdobeTargetURL(rawURL string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return "", errors.New("targetUrl is invalid")
	}
	if parsed.Scheme != "https" || parsed.Host == "" || parsed.Hostname() == "" {
		return "", errors.New("targetUrl must be an absolute HTTPS URL")
	}
	if parsed.User != nil || parsed.Fragment != "" {
		return "", errors.New("targetUrl must not contain credentials or fragments")
	}
	if parsed.Port() != "" && parsed.Port() != "443" {
		return "", errors.New("targetUrl must use the default HTTPS port")
	}

	host := strings.ToLower(parsed.Hostname())
	if _, allowed := allowedAdobeHosts[host]; !allowed {
		return "", errors.New("targetUrl host is not allowlisted")
	}
	return parsed.String(), nil
}

// decodeBody 解码并限制请求体，避免 Base64 在解码前绕过大小上限。
func decodeBody(value string, limit int64) ([]byte, error) {
	if value == "" {
		return nil, nil
	}
	maximumEncodedLength := base64.StdEncoding.EncodedLen(int(limit))
	if len(value) > maximumEncodedLength {
		return nil, errors.New("request body is too large")
	}
	body, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		return nil, errors.New("bodyBase64 is invalid")
	}
	if int64(len(body)) > limit {
		return nil, errors.New("request body is too large")
	}
	return body, nil
}

// applyHeaders 转发业务请求头并移除逐跳头和代理入站密钥头。
func applyHeaders(
	request *fhttp.Request,
	headers map[string]string,
	order []string,
) {
	request.Header = fhttp.Header{}
	for key, value := range headers {
		trimmedKey := strings.TrimSpace(key)
		canonicalKey := textproto.CanonicalMIMEHeaderKey(trimmedKey)
		if canonicalKey == "" || shouldSkipHeader(canonicalKey) {
			continue
		}
		request.Header.Set(canonicalKey, value)
	}

	if len(order) == 0 {
		return
	}
	headerOrder := make([]string, 0, len(order))
	for _, key := range order {
		trimmedKey := strings.TrimSpace(key)
		canonicalKey := textproto.CanonicalMIMEHeaderKey(trimmedKey)
		if canonicalKey == "" || shouldSkipHeader(canonicalKey) {
			continue
		}
		headerOrder = append(headerOrder, strings.ToLower(canonicalKey))
	}
	if len(headerOrder) > 0 {
		request.Header[fhttp.HeaderOrderKey] = headerOrder
	}
}

// shouldSkipHeader 判断请求头是否属于逐跳头或代理内部凭据。
func shouldSkipHeader(key string) bool {
	switch strings.ToLower(key) {
	case "connection",
		"content-length",
		"host",
		"proxy-authenticate",
		"proxy-authorization",
		"te",
		"trailer",
		"transfer-encoding",
		"upgrade",
		"x-proxy-secret":
		return true
	default:
		return false
	}
}

// readLimited 读取受限响应体，超过配置上限时显式失败。
func readLimited(reader io.Reader, limit int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, fmt.Errorf("read Adobe response: %w", err)
	}
	if int64(len(data)) > limit {
		return nil, errors.New("Adobe response body is too large")
	}
	return data, nil
}

// mapHeaders 复制响应头并移除内部 TLS client 的伪头字段。
func mapHeaders(headers fhttp.Header) map[string][]string {
	result := make(map[string][]string, len(headers))
	for key, values := range headers {
		if strings.EqualFold(key, fhttp.HeaderOrderKey) {
			continue
		}
		result[key] = append([]string(nil), values...)
	}
	return result
}

// writeJSON 写入固定 Content-Type 的 JSON 响应，编码错误只记录非敏感摘要。
func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		log.Printf("write JSON response failed: %v", err)
	}
}

// writeError 写入不包含配置、凭据或上游响应体的稳定错误。
func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
