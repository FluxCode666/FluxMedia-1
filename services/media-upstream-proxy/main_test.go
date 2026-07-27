// media-upstream-proxy 的配置、Adobe 主机边界与凭据保护测试。
//
// 使用方：Go 单元测试与 Docker 发布门禁；测试不访问真实 Adobe 服务，使用最小 HTTP
// client 桩验证代理请求和响应契约。
package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	fhttp "github.com/bogdanfinn/fhttp"
)

// fakeProxyClient 为测试捕获上游请求，不执行网络访问。
type fakeProxyClient struct {
	do         func(request *fhttp.Request) (*fhttp.Response, error)
	closedIdle bool
}

// Do 执行测试定义的请求断言并返回伪响应。
func (f *fakeProxyClient) Do(
	request *fhttp.Request,
) (*fhttp.Response, error) {
	return f.do(request)
}

// CloseIdleConnections 记录关闭调用，满足生产 client 的最小接口。
func (f *fakeProxyClient) CloseIdleConnections() {
	f.closedIdle = true
}

// testConfig 返回不含真实凭据的有效测试配置。
func testConfig() proxyConfig {
	return proxyConfig{
		secret:       "test-proxy-secret",
		timeout:      300 * time.Second,
		maxBodyBytes: 1 << 20,
	}
}

// envGetter 将测试 map 适配成 loadProxyConfig 所需的 getenv 函数。
func envGetter(values map[string]string) func(string) string {
	return func(key string) string {
		return values[key]
	}
}

// TestLoadProxyConfigRequiresSecret 验证缺失或空密钥时启动配置 fail-closed。
func TestLoadProxyConfigRequiresSecret(t *testing.T) {
	for _, secret := range []string{"", "   "} {
		_, err := loadProxyConfig(envGetter(map[string]string{
			"ADOBE_DIRECT_PROXY_SECRET": secret,
		}))
		if err == nil || !strings.Contains(err.Error(), "must be configured") {
			t.Fatalf("空密钥应拒绝启动，实际错误：%v", err)
		}
	}
}

// TestLoadProxyConfigRejectsInvalidBounds 验证超时和响应体上限不会静默回退。
func TestLoadProxyConfigRejectsInvalidBounds(t *testing.T) {
	tests := []map[string]string{
		{
			"ADOBE_DIRECT_PROXY_SECRET":          "secret",
			"ADOBE_DIRECT_PROXY_TIMEOUT_SECONDS": "0",
		},
		{
			"ADOBE_DIRECT_PROXY_SECRET":      "secret",
			"ADOBE_DIRECT_PROXY_MAX_BODY_MB": "257",
		},
	}
	for _, values := range tests {
		if _, err := loadProxyConfig(envGetter(values)); err == nil {
			t.Fatalf("非法边界值应拒绝启动：%v", values)
		}
	}
}

// TestBuildAdobeTargetURL 验证只允许精确 Adobe HTTPS 主机与受支持的动态轮询路径。
func TestBuildAdobeTargetURL(t *testing.T) {
	allowed := []string{
		"https://firefly-3p.ff.adobe.io/v2/3p-images/generate-async",
		"https://firefly-epo855232.adobe.io/jobs/result/image-job-1",
		"https://firefly-epo5678-prod.adobe.io/jobs/video-job-legacy",
		"https://firefly-epo1234-prod.adobe.io/v2/jobs/video-job-1",
		"https://bks-epo8552.adobe.io/v2/jobs/result/image-job-1?host=firefly-epo855232.adobe.io/",
		"https://bks-epo1234.adobe.io/v2/jobs/result/video-job-1?host=firefly-epo1234-prod.adobe.io/",
		"https://firefly.adobe.io/v1/credits/balance",
		"https://ims-na1.adobelogin.com/ims/profile/v1",
		"https://adobeid-na1.services.adobe.com/ims/check/v6/token?x=1",
	}
	for _, target := range allowed {
		if _, err := buildAdobeTargetURL(target); err != nil {
			t.Errorf("合法 Adobe URL 被拒绝 %q：%v", target, err)
		}
	}

	blocked := []string{
		"https://chatgpt.com/backend-api/models",
		"http://firefly.adobe.io/v1/credits/balance",
		"https://evil-firefly.adobe.io.example.com/path",
		"https://sub.firefly.adobe.io/path",
		"https://firefly-epoabcd.adobe.io/jobs/result/1",
		"https://firefly-epo855232.adobe.io.evil.test/jobs/result/1",
		"https://bks-epo8552.adobe.io/v2/jobs/result/1?host=evil.test",
		"https://bks-epo8552.adobe.io/v2/jobs/result/1?host=firefly-epo999932.adobe.io",
		"https://firefly-epo855232.adobe.io/unknown/1",
		"https://firefly-epo855232.adobe.io/jobs/1?extra=1",
		"https://bks-epo8552.adobe.io/v2/jobs/result/1/extra?host=firefly-epo855232.adobe.io",
		"https://bks-epo8552.adobe.io/v2/jobs/result/1?host=firefly-epo855232.adobe.io&extra=1",
		"https://firefly.adobe.io.evil.example/path",
		"https://user:password@firefly.adobe.io/path",
		"https://firefly.adobe.io:444/path",
		"//firefly.adobe.io/path",
	}
	for _, target := range blocked {
		if _, err := buildAdobeTargetURL(target); err == nil {
			t.Errorf("非白名单 URL 未被拒绝：%q", target)
		}
	}
}

// TestHealthAndErrorsDoNotExposeSecret 验证就绪和鉴权错误不输出代理密钥。
func TestHealthAndErrorsDoNotExposeSecret(t *testing.T) {
	secret := "never-print-this-secret"
	server := &proxyServer{
		config: proxyConfig{secret: secret, maxBodyBytes: 1 << 20},
		client: &fakeProxyClient{do: func(
			_ *fhttp.Request,
		) (*fhttp.Response, error) {
			return nil, errors.New("should not be called")
		}},
	}

	healthRecorder := httptest.NewRecorder()
	healthRequest := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	healthRequest.Header.Set("X-Proxy-Secret", secret)
	server.handleHealth(
		healthRecorder,
		healthRequest,
	)
	if healthRecorder.Code != http.StatusOK {
		t.Fatalf("有效密钥健康检查应返回 200，实际为 %d", healthRecorder.Code)
	}
	if strings.Contains(healthRecorder.Body.String(), secret) {
		t.Fatal("就绪响应不得输出 secret")
	}

	unauthorizedHealthRecorder := httptest.NewRecorder()
	server.handleHealth(
		unauthorizedHealthRecorder,
		httptest.NewRequest(http.MethodGet, "/healthz", nil),
	)
	if unauthorizedHealthRecorder.Code != http.StatusUnauthorized {
		t.Fatalf(
			"缺少健康检查密钥应返回 401，实际为 %d",
			unauthorizedHealthRecorder.Code,
		)
	}

	errorRecorder := httptest.NewRecorder()
	server.handleRequest(
		errorRecorder,
		httptest.NewRequest(http.MethodPost, "/request", strings.NewReader("{}")),
	)
	if errorRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("缺少鉴权应返回 401，实际为 %d", errorRecorder.Code)
	}
	if strings.Contains(errorRecorder.Body.String(), secret) {
		t.Fatal("错误响应不得输出 secret")
	}
}

// TestHandleRequestForwardsAdobeRequestWithoutProxySecret 验证授权请求只转发业务头。
func TestHandleRequestForwardsAdobeRequestWithoutProxySecret(t *testing.T) {
	upstreamBody := []byte(`{"ok":true}`)
	client := &fakeProxyClient{do: func(
		request *fhttp.Request,
	) (*fhttp.Response, error) {
		if request.URL.Host != "firefly.adobe.io" {
			t.Fatalf("上游主机错误：%s", request.URL.Host)
		}
		if request.Header.Get("Authorization") != "Bearer adobe-token" {
			t.Fatalf("Adobe Authorization 未转发")
		}
		if request.Header.Get("X-Proxy-Secret") != "" {
			t.Fatal("代理入站 secret 不得转发给 Adobe")
		}
		return &fhttp.Response{
			StatusCode: http.StatusOK,
			Header:     fhttp.Header{"Content-Type": {"application/json"}},
			Body:       io.NopCloser(bytes.NewReader(upstreamBody)),
			Request:    request,
		}, nil
	}}
	server := &proxyServer{config: testConfig(), client: client}
	// WHY：使用 TypeScript ProxyFireflyTransport 的真实 JSON 字段，而不是序列化
	// Go 自身结构，确保严格解码能捕获两端契约漂移。
	encodedPayload := []byte(`{
		"method":"GET",
		"targetUrl":"https://firefly.adobe.io/v1/credits/balance",
		"headers":{
			"Authorization":"Bearer adobe-token",
			"X-Proxy-Secret":"must-not-forward"
		},
		"headerOrder":["Authorization","X-Proxy-Secret"],
		"bodyBase64":""
	}`)

	request := httptest.NewRequest(
		http.MethodPost,
		"/request",
		bytes.NewReader(encodedPayload),
	).WithContext(context.Background())
	request.Header.Set("X-Proxy-Secret", testConfig().secret)
	recorder := httptest.NewRecorder()
	server.handleRequest(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("代理响应状态错误：%d body=%s", recorder.Code, recorder.Body.String())
	}
	var response responsePayload
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("解析代理响应失败：%v", err)
	}
	decodedBody, err := base64.StdEncoding.DecodeString(response.BodyBase64)
	if err != nil {
		t.Fatalf("解码上游响应失败：%v", err)
	}
	if string(decodedBody) != string(upstreamBody) {
		t.Fatalf("上游响应体不一致：%q", decodedBody)
	}
}

// TestDecodeBodyEnforcesLimit 验证请求体在 Base64 解码前后都受上限约束。
func TestDecodeBodyEnforcesLimit(t *testing.T) {
	encoded := base64.StdEncoding.EncodeToString([]byte("12345"))
	if _, err := decodeBody(encoded, 4); err == nil {
		t.Fatal("超限请求体应被拒绝")
	}
	if _, err := decodeBody("not-base64", 32); err == nil {
		t.Fatal("非法 Base64 应被拒绝")
	}
}
