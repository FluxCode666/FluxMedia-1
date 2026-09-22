package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func testModerationRuntime(server *httptest.Server) moderationRuntime {
	return moderationRuntime{enabled: true, failClosed: true, providerTimeout: time.Second, proxyTimeout: time.Second, values: map[string]string{"CONTENT_MODERATION_PROVIDER": "openai", "OPENAI_MODERATION_API_KEY": "test-openai-secret", "OPENAI_BASE_URL": server.URL + "/v1"}, client: server.Client()}
}
func testModerationInput() moderationInput {
	return moderationInput{Prompt: "a landscape", EffectiveBlockRiskLevel: "high"}
}
func TestModerationOpenAIAllowBlockInvalidAndFailurePolicy(t *testing.T) {
	for _, tt := range []struct {
		name, response, decision string
		status                   int
		failClosed               bool
	}{
		{"allow", `{"results":[{"flagged":false,"categories":{}}]}`, "allow", 200, true},
		{"block", `{"results":[{"flagged":true,"categories":{"violence":true}}]}`, "block", 200, true},
		{"empty results", `{"results":[]}`, "error", 200, true},
		{"missing flagged", `{"results":[{}]}`, "error", 200, true},
		{"invalid response", `not json`, "error", 200, true},
		{"closed failure", `{"error":{"message":"test-openai-secret"}}`, "error", 500, true},
		{"open failure", `{"error":{}}`, "allow", 500, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/v1/moderations" || r.Header.Get("Authorization") != "Bearer test-openai-secret" {
					t.Error("wrong OpenAI request")
				}
				var input struct {
					Model string           `json:"model"`
					Input []map[string]any `json:"input"`
				}
				if json.NewDecoder(r.Body).Decode(&input) != nil || input.Model != "omni-moderation-latest" || len(input.Input) != 2 {
					t.Error("missing multimodal request")
				}
				w.WriteHeader(tt.status)
				_, _ = io.WriteString(w, tt.response)
			}))
			defer server.Close()
			cfg := testModerationRuntime(server)
			cfg.failClosed = tt.failClosed
			input := testModerationInput()
			input.Images = []moderationImage{{Data: "aGVsbG8=", Type: "image/png"}}
			got, err := cfg.moderate(context.Background(), input)
			if err != nil || got.Decision != tt.decision {
				t.Fatalf("result=%+v err=%v", got, err)
			}
			if strings.Contains(got.Reason, "test-openai-secret") {
				t.Fatal("provider response leaked secret")
			}
		})
	}
}
func TestModerationProxyFallbackSkipAndErrors(t *testing.T) {
	for _, decision := range []string{"allow", "block", "error", "skipped", "invalid", "failure"} {
		t.Run(decision, func(t *testing.T) {
			calls := 0
			proxyCalls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/proxy" {
					proxyCalls++
					if r.Header.Get("Authorization") != "Bearer outbound-secret" {
						t.Error("proxy secret not forwarded")
					}
					var input map[string]any
					_ = json.NewDecoder(r.Body).Decode(&input)
					if _, ok := input["skipProxy"]; ok {
						t.Error("proxy request contains skipProxy")
					}
					if decision == "failure" {
						w.WriteHeader(503)
						return
					}
					_ = json.NewEncoder(w).Encode(map[string]string{"decision": decision})
					return
				}
				calls++
				_, _ = io.WriteString(w, `{"results":[{"flagged":false}]}`)
			}))
			defer server.Close()
			cfg := testModerationRuntime(server)
			cfg.values["CONTENT_MODERATION_PROXY_URL"] = server.URL + "/proxy"
			cfg.values["CONTENT_MODERATION_PROXY_SECRET"] = "outbound-secret"
			got, err := cfg.moderate(context.Background(), testModerationInput())
			if err != nil {
				t.Fatal(err)
			}
			expected := decision
			if decision == "skipped" || decision == "invalid" || decision == "failure" {
				expected = "allow"
				if calls != 1 {
					t.Fatal("provider fallback not called")
				}
			} else if calls != 0 {
				t.Fatal("terminal proxy result fell through")
			}
			if got.Decision != expected || proxyCalls != 1 {
				t.Fatalf("unexpected result %+v", got)
			}
			input := testModerationInput()
			input.SkipProxy = true
			_, err = cfg.moderate(context.Background(), input)
			if err != nil || proxyCalls != 1 {
				t.Fatal("skipProxy recursion guard failed")
			}
		})
	}
}
func TestModerationProxyOnlyFailureClosesAndCancellationPropagates(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }))
	defer server.Close()
	cfg := testModerationRuntime(server)
	cfg.values["CONTENT_MODERATION_PROVIDER"] = "none"
	cfg.values["CONTENT_MODERATION_PROXY_URL"] = server.URL
	result, err := cfg.moderate(context.Background(), testModerationInput())
	if err != nil || result.Decision != "error" {
		t.Fatalf("proxy-only failure allowed: %+v %v", result, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = cfg.moderate(ctx, testModerationInput())
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation not preserved: %v", err)
	}
	cfg.enabled = false
	result, err = cfg.moderate(context.Background(), testModerationInput())
	if err != nil || result.Decision != "skipped" {
		t.Fatal("disabled moderation should skip")
	}
}
func TestModerationProviderTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		select {
		case <-r.Context().Done():
		case <-time.After(time.Second):
		}
	}))
	defer server.Close()
	cfg := testModerationRuntime(server)
	cfg.providerTimeout = 10 * time.Millisecond
	result, err := cfg.moderate(context.Background(), testModerationInput())
	if err != nil || result.Decision != "error" || !strings.Contains(result.Reason, "deadline exceeded") {
		t.Fatalf("timeout result=%+v err=%v", result, err)
	}
}
func TestModerationProvidersRequireCredentialsAndRespectSelection(t *testing.T) {
	c := moderationRuntime{enabled: true, values: map[string]string{"CONTENT_MODERATION_PROVIDER": "aliyun"}}
	if len(c.providers()) != 0 {
		t.Fatal("unconfigured aliyun advertised")
	}
	c.values["ALIYUN_MODERATION_ACCESS_KEY_ID"] = "id"
	c.values["ALIYUN_MODERATION_ACCESS_KEY_SECRET"] = "secret"
	c.values["OPENAI_MODERATION_API_KEY"] = "key"
	if strings.Join(c.providers(), ",") != "aliyun" {
		t.Fatal("explicit provider selection ignored")
	}
	c.values["CONTENT_MODERATION_PROVIDER"] = "auto"
	if strings.Join(c.providers(), ",") != "aliyun,openai" {
		t.Fatal("fallback order differs")
	}
	c.values["CONTENT_MODERATION_PROVIDER"] = "none"
	if len(c.providers()) != 0 {
		t.Fatal("none provider should disable local providers")
	}
}
func TestModerationAliyunServicesAndThreshold(t *testing.T) {
	for _, tt := range []struct {
		name, service, app, risk, threshold, decision string
		image                                         bool
		wantAction                                    string
	}{
		{"text plus allows low", "text-service", "", "low", "high", "allow", false, "TextModerationPlus"},
		{"text threshold blocks", "text-service", "", "medium", "medium", "block", false, "TextModerationPlus"},
		{"image service", "image-service", "", "high", "high", "block", true, "ImageModeration"},
		{"text agent", "", "app-1", "none", "high", "allow", false, "MultiModalAgent"},
		{"image agent", "", "app-2", "pass", "low", "allow", true, "MultiModalAgent"},
		{"unknown label", "text-service", "", "review", "high", "block", false, "TextModerationPlus"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("X-Acs-Action") != tt.wantAction || !strings.HasPrefix(r.Header.Get("Authorization"), "ACS3-HMAC-SHA256 Credential=aliyun-id,") {
					t.Error("missing signed Aliyun RPC request")
				}
				_ = r.ParseForm()
				if tt.service != "" && r.Form.Get("Service") != tt.service {
					t.Error("service missing")
				}
				if tt.app != "" && r.Form.Get("AppID") != tt.app {
					t.Error("app id missing")
				}
				var payload map[string]any
				if json.Unmarshal([]byte(r.Form.Get("ServiceParameters")), &payload) != nil {
					t.Error("invalid service parameters")
				}
				if tt.image && payload["imageUrl"] == nil && payload["images"] == nil {
					t.Error("image omitted from moderation")
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"Code": 200, "Data": map[string]any{"RiskLevel": tt.risk, "Result": []any{map[string]string{"Label": "policy"}}}})
			}))
			defer server.Close()
			cfg := testModerationRuntime(server)
			cfg.values["CONTENT_MODERATION_PROVIDER"] = "aliyun"
			cfg.values["ALIYUN_MODERATION_ACCESS_KEY_ID"] = "aliyun-id"
			cfg.values["ALIYUN_MODERATION_ACCESS_KEY_SECRET"] = "aliyun-secret"
			cfg.values["ALIYUN_MODERATION_ENDPOINT"] = server.URL
			prefix := "ALIYUN_MODERATION_TEXT_"
			input := testModerationInput()
			input.EffectiveBlockRiskLevel = tt.threshold
			if tt.image {
				prefix = "ALIYUN_MODERATION_IMAGE_"
				input.Images = []moderationImage{{URL: "https://example.com/image.png"}}
			}
			cfg.values[prefix+"SERVICE"] = tt.service
			cfg.values[prefix+"APP_ID"] = tt.app
			result, err := cfg.moderate(context.Background(), input)
			if err != nil || result.Decision != tt.decision {
				t.Fatalf("got %+v err=%v", result, err)
			}
		})
	}
}
func TestModerationAliyunMalformedResultAndFallback(t *testing.T) {
	aliyunCalls, openAICalls := 0, 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/moderations" {
			openAICalls++
			_, _ = io.WriteString(w, `{"results":[{"flagged":false}]}`)
			return
		}
		aliyunCalls++
		_, _ = io.WriteString(w, `{"Code":200,"Data":{}}`)
	}))
	defer server.Close()
	cfg := testModerationRuntime(server)
	cfg.values["CONTENT_MODERATION_PROVIDER"] = "auto"
	cfg.values["ALIYUN_MODERATION_ACCESS_KEY_ID"] = "id"
	cfg.values["ALIYUN_MODERATION_ACCESS_KEY_SECRET"] = "secret"
	cfg.values["ALIYUN_MODERATION_TEXT_SERVICE"] = "text"
	cfg.values["ALIYUN_MODERATION_ENDPOINT"] = server.URL
	result, err := cfg.moderate(context.Background(), testModerationInput())
	if err != nil || result.Provider != "openai" || aliyunCalls != 1 || openAICalls != 1 {
		t.Fatalf("fallback failed: %+v %v", result, err)
	}
	cfg.values["CONTENT_MODERATION_PROVIDER"] = "aliyun"
	result, err = cfg.moderate(context.Background(), testModerationInput())
	if err != nil || result.Decision != "error" {
		t.Fatal("malformed provider result must fail closed")
	}
}
func TestModerationTextChunkingAndProxyAuthorization(t *testing.T) {
	for _, input := range []string{"", strings.Repeat("a", 4001), strings.Repeat("🌟", 1001)} {
		chunks := moderationChunks(input)
		if strings.Join(chunks, "") != input {
			t.Fatal("chunking lost text")
		}
		for _, chunk := range chunks {
			units := 0
			for _, r := range chunk {
				units++
				if r > 0xffff {
					units++
				}
			}
			if units > 2000 {
				t.Fatal("chunk over provider limit")
			}
		}
	}
	r := httptest.NewRequest(http.MethodPost, "/moderate", nil)
	r.Header.Set("Authorization", "Bearer old-secret")
	if !moderationProxyAuthorized(r, "old-secret", "new-secret") {
		t.Fatal("proxy primary rejected")
	}
	r.Header.Set("Authorization", "Bearer new-secret")
	if !moderationProxyAuthorized(r, "old-secret", "new-secret") {
		t.Fatal("gateway rejected")
	}
	if moderationProxyAuthorized(r, "", "") {
		t.Fatal("blank auth accepted")
	}
}
func TestAliyunModerationSignatureHeadersAndEndpointValidation(t *testing.T) {
	h, err := signAliyunModeration("https://green.cn-shanghai.aliyuncs.com/", "TextModerationPlus", []byte(url.Values{"Service": []string{"text"}}.Encode()), "id", "secret")
	if err != nil || h.Get("X-Acs-Content-Sha256") == "" || h.Get("X-Acs-Version") != "2022-03-02" {
		t.Fatal("bad signature headers")
	}
	if _, err := signAliyunModeration("https://green.example/?key=secret", "action", nil, "id", "secret"); err == nil {
		t.Fatal("query endpoint accepted")
	}
}

func TestAliyunModerationSignatureMatchesOfficialSDKFixture(t *testing.T) {
	// Fixture generated by @alicloud/openapi-util 0.3.3 Client.getAuthorization
	// for this request, with fixed time and nonce to detect canonicalization bugs.
	now := time.Date(2026, 9, 13, 0, 0, 0, 0, time.UTC)
	h, err := signAliyunModerationAt("https://green.cn-shanghai.aliyuncs.com/", "TextModerationPlus", []byte("Service=text"), "id", "secret", now, "moderation-fixture")
	if err != nil {
		t.Fatal(err)
	}
	want := "ACS3-HMAC-SHA256 Credential=id,SignedHeaders=content-type;host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version,Signature=3fe4d810198f0e7fec38dcb0d9949727899b3e653f770708b658ba41c8860251"
	if h.Get("Authorization") != want {
		t.Fatalf("signature differs from SDK: %s", h.Get("Authorization"))
	}
}

func TestModerationProxyFallbackPreservesLocalImageBytes(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/proxy" {
			var in moderationInput
			_ = json.NewDecoder(r.Body).Decode(&in)
			if len(in.Images) != 1 || in.Images[0].Data != "" || in.Images[0].URL == "" {
				t.Error("proxy must use signed URL")
			}
			_, _ = io.WriteString(w, `{"decision":"skipped"}`)
			return
		}
		raw, _ := io.ReadAll(r.Body)
		if !strings.Contains(string(raw), "data:image/png;base64,aGVsbG8=") {
			t.Error("proxy fallback mutated original image bytes")
		}
		_, _ = io.WriteString(w, `{"results":[{"flagged":false}]}`)
	}))
	defer server.Close()
	cfg := testModerationRuntime(server)
	cfg.values["CONTENT_MODERATION_PROXY_URL"] = server.URL + "/proxy"
	in := testModerationInput()
	in.Images = []moderationImage{{Data: "aGVsbG8=", URL: "https://media.example/image", Type: "image/png"}}
	if _, err := cfg.moderate(context.Background(), in); err != nil {
		t.Fatal(err)
	}
	if in.Images[0].Data != "aGVsbG8=" {
		t.Fatal("input mutated")
	}
}

func TestModerationRequestRequiresPromptAndProtectsProxyRecursionFlag(t *testing.T) {
	for _, raw := range []string{`{"effectiveBlockRiskLevel":"high"}`, `{"prompt":null,"effectiveBlockRiskLevel":"high"}`, `{"prompt":"safe","effectiveBlockRiskLevel":"high","skipProxy":false}`, `{"prompt":"safe","effectiveBlockRiskLevel":"high","unknown":true}`} {
		r := httptest.NewRequest(http.MethodPost, "/moderate", strings.NewReader(raw))
		if _, err := decodeModerationRequest(r, false); err == nil {
			t.Fatalf("invalid proxy request accepted: %s", raw)
		}
	}
	r := httptest.NewRequest(http.MethodPost, "/moderate", strings.NewReader(`{"prompt":"","effectiveBlockRiskLevel":"high"}`))
	in, err := decodeModerationRequest(r, false)
	if err != nil || in.Prompt != "" || in.EffectiveBlockRiskLevel != "high" {
		t.Fatalf("empty string prompt contract changed: %+v %v", in, err)
	}
}
