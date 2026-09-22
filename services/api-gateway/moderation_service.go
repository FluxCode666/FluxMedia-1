package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

type moderationImage struct {
	Data string `json:"data,omitempty"`
	Type string `json:"type,omitempty"`
	Name string `json:"name,omitempty"`
	URL  string `json:"url,omitempty"`
}
type moderationInput struct {
	Prompt                  string            `json:"prompt"`
	Images                  []moderationImage `json:"images,omitempty"`
	Mode                    string            `json:"mode,omitempty"`
	UserID                  string            `json:"userId,omitempty"`
	EffectiveBlockRiskLevel string            `json:"effectiveBlockRiskLevel"`
	GenerationID            string            `json:"generationId,omitempty"`
	SkipProxy               bool              `json:"skipProxy,omitempty"`
}
type moderationResult struct {
	Decision string `json:"decision"`
	Provider string `json:"provider,omitempty"`
	Reason   string `json:"reason,omitempty"`
	Details  any    `json:"details,omitempty"`
}
type moderationRuntime struct {
	enabled, failClosed           bool
	values                        map[string]string
	providerTimeout, proxyTimeout time.Duration
	client                        *http.Client
}

func (b *backend) moderationRuntime(ctx context.Context) (moderationRuntime, error) {
	cfg := moderationRuntime{values: map[string]string{}, client: &http.Client{Timeout: 2 * time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	var err error
	cfg.enabled, err = b.settingBool(ctx, "CONTENT_MODERATION_ENABLED", true)
	if err != nil {
		return cfg, err
	}
	cfg.failClosed, err = b.settingBool(ctx, "CONTENT_MODERATION_FAIL_CLOSED", true)
	if err != nil {
		return cfg, err
	}
	for _, key := range []string{"CONTENT_MODERATION_PROVIDER", "CONTENT_MODERATION_PROXY_URL", "CONTENT_MODERATION_PROXY_SECRET", "CONTENT_MODERATION_PROXY_GATEWAY_SECRET", "CONTENT_MODERATION_PROXY_TIMEOUT_MS", "CONTENT_MODERATION_PROVIDER_TIMEOUT_MS", "OPENAI_MODERATION_API_KEY", "OPENAI_MODERATION_MODEL", "ALIYUN_MODERATION_ACCESS_KEY_ID", "ALIYUN_MODERATION_ACCESS_KEY_SECRET", "ALIYUN_MODERATION_REGION_ID", "ALIYUN_MODERATION_ENDPOINT", "ALIYUN_MODERATION_TEXT_REGION_ID", "ALIYUN_MODERATION_TEXT_ENDPOINT", "ALIYUN_MODERATION_TEXT_SERVICE", "ALIYUN_MODERATION_IMAGE_REGION_ID", "ALIYUN_MODERATION_IMAGE_ENDPOINT", "ALIYUN_MODERATION_IMAGE_SERVICE", "ALIYUN_MODERATION_TEXT_APP_ID", "ALIYUN_MODERATION_IMAGE_APP_ID"} {
		value, e := b.settingString(ctx, key, "")
		if e != nil {
			return cfg, e
		}
		cfg.values[key] = strings.TrimSpace(value)
	}
	if cfg.values["OPENAI_MODERATION_API_KEY"] == "" {
		cfg.values["OPENAI_MODERATION_API_KEY"] = strings.TrimSpace(os.Getenv("MODERATION_OPENAI_API_KEY"))
	}
	cfg.values["OPENAI_BASE_URL"] = strings.TrimSpace(os.Getenv("OPENAI_BASE_URL"))
	if cfg.values["ALIYUN_MODERATION_TEXT_APP_ID"] == "" {
		cfg.values["ALIYUN_MODERATION_TEXT_APP_ID"] = strings.TrimSpace(os.Getenv("ALIYUN_MODERATION_APP_ID"))
	}
	cfg.providerTimeout = moderationTimeout(cfg.values["CONTENT_MODERATION_PROVIDER_TIMEOUT_MS"])
	cfg.proxyTimeout = moderationTimeout(cfg.values["CONTENT_MODERATION_PROXY_TIMEOUT_MS"])
	return cfg, nil
}
func moderationTimeout(raw string) time.Duration {
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 || n > 120000 {
		n = 10000
	}
	return time.Duration(n) * time.Millisecond
}
func (c moderationRuntime) providers() []string {
	providers := []string{}
	if !c.enabled {
		return providers
	}
	configured := c.values["CONTENT_MODERATION_PROVIDER"]
	if configured == "none" {
		return providers
	}
	if configured != "openai" && c.values["ALIYUN_MODERATION_ACCESS_KEY_ID"] != "" && c.values["ALIYUN_MODERATION_ACCESS_KEY_SECRET"] != "" {
		providers = append(providers, "aliyun")
	}
	if configured != "aliyun" && c.values["OPENAI_MODERATION_API_KEY"] != "" {
		providers = append(providers, "openai")
	}
	return providers
}
func validateModerationInput(in moderationInput) error {
	if in.EffectiveBlockRiskLevel != "low" && in.EffectiveBlockRiskLevel != "medium" && in.EffectiveBlockRiskLevel != "high" {
		return invalid("审核级别不合法")
	}
	if in.Mode != "" && in.Mode != "text" && in.Mode != "image" {
		return invalid("审核模式不合法")
	}
	for _, image := range in.Images {
		if image.Data != "" {
			if _, err := base64.StdEncoding.DecodeString(image.Data); err != nil {
				return invalid("审核图片数据必须为 base64")
			}
		}
		if image.URL != "" {
			u, err := url.Parse(image.URL)
			if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil {
				return invalid("审核图片 URL 不合法")
			}
		}
	}
	return nil
}
func (c moderationRuntime) moderate(ctx context.Context, in moderationInput) (moderationResult, error) {
	if err := validateModerationInput(in); err != nil {
		return moderationResult{}, err
	}
	if err := ctx.Err(); err != nil {
		return moderationResult{}, err
	}
	if !c.enabled {
		return moderationResult{Decision: "skipped"}, nil
	}
	failures := []map[string]string{}
	run := func(provider string, timeout time.Duration, work func(context.Context) (moderationResult, error)) (moderationResult, bool, error) {
		deadline, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()
		result, err := work(deadline)
		if ctx.Err() != nil {
			return moderationResult{}, false, ctx.Err()
		}
		if err == nil && (result.Decision == "allow" || result.Decision == "block" || (provider == "proxy" && result.Decision == "error")) {
			return result, true, nil
		}
		if err == nil && provider == "proxy" && result.Decision == "skipped" {
			return moderationResult{}, false, nil
		}
		message := "moderation skipped unexpectedly"
		if err != nil {
			message = err.Error()
		}
		failures = append(failures, map[string]string{"provider": provider, "error": message})
		return moderationResult{}, false, nil
	}
	if c.values["CONTENT_MODERATION_PROXY_URL"] != "" && !in.SkipProxy {
		result, done, err := run("proxy", c.proxyTimeout, func(ctx context.Context) (moderationResult, error) { return c.proxy(ctx, in) })
		if done || err != nil {
			return result, err
		}
	}
	for _, provider := range c.providers() {
		result, done, err := run(provider, c.providerTimeout, func(ctx context.Context) (moderationResult, error) {
			if provider == "aliyun" {
				return c.aliyun(ctx, in)
			}
			return c.openAI(ctx, in)
		})
		if done || err != nil {
			return result, err
		}
	}
	if len(failures) == 0 {
		return moderationResult{Decision: "skipped"}, nil
	}
	if !c.failClosed {
		return moderationResult{Decision: "allow", Details: failures}, nil
	}
	messages := []string{}
	for _, failure := range failures {
		messages = append(messages, failure["provider"]+": "+failure["error"])
	}
	return moderationResult{Decision: "error", Reason: strings.Join(messages, "; "), Details: failures}, nil
}

// send consumes and closes each response and rejects oversized/malformed
// responses. Provider response bodies and credentials never enter error text.
func (c moderationRuntime) send(ctx context.Context, endpoint, contentType string, body []byte, headers http.Header, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return errors.New("moderation endpoint is invalid")
	}
	req.Header = headers.Clone()
	req.Header.Set("Content-Type", contentType)
	client := c.client
	if client == nil {
		client = &http.Client{Timeout: 2 * time.Minute}
	}
	response, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("moderation request canceled: %w", ctx.Err())
		}
		return errors.New("moderation request failed")
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, (4<<20)+1))
	if err != nil {
		return errors.New("moderation response read failed")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("moderation request failed: HTTP %d", response.StatusCode)
	}
	if len(raw) > 4<<20 || json.Unmarshal(raw, out) != nil {
		return errors.New("moderation response is invalid")
	}
	return nil
}
func (c moderationRuntime) proxy(ctx context.Context, in moderationInput) (moderationResult, error) {
	in.Images = append([]moderationImage(nil), in.Images...)
	for i := range in.Images {
		if in.Images[i].URL != "" {
			in.Images[i].Data = ""
		}
	}
	in.SkipProxy = false
	raw, err := json.Marshal(in)
	if err != nil {
		return moderationResult{}, err
	}
	headers := http.Header{}
	if secret := c.values["CONTENT_MODERATION_PROXY_SECRET"]; secret != "" {
		headers.Set("Authorization", "Bearer "+secret)
		headers.Set("X-Moderation-Proxy-Secret", secret)
	}
	var result moderationResult
	if err = c.send(ctx, c.values["CONTENT_MODERATION_PROXY_URL"], "application/json", raw, headers, &result); err != nil {
		return result, err
	}
	switch result.Decision {
	case "allow", "block", "error", "skipped":
		return result, nil
	default:
		return moderationResult{}, errors.New("moderation proxy returned an invalid decision")
	}
}
func (c moderationRuntime) openAI(ctx context.Context, in moderationInput) (moderationResult, error) {
	inputs := []any{map[string]any{"type": "text", "text": in.Prompt}}
	for _, image := range in.Images {
		source := image.URL
		if image.Data != "" {
			mime := image.Type
			if mime == "" {
				mime = "image/png"
			}
			source = "data:" + mime + ";base64," + image.Data
		}
		if source == "" {
			return moderationResult{}, errors.New("OpenAI moderation image is empty")
		}
		inputs = append(inputs, map[string]any{"type": "image_url", "image_url": map[string]string{"url": source}})
	}
	model := c.values["OPENAI_MODERATION_MODEL"]
	if model == "" {
		model = "omni-moderation-latest"
	}
	raw, _ := json.Marshal(map[string]any{"model": model, "input": inputs})
	endpoint := strings.TrimRight(c.values["OPENAI_BASE_URL"], "/")
	if endpoint == "" {
		endpoint = "https://api.openai.com/v1"
	}
	var response struct {
		Results []struct {
			Flagged    *bool           `json:"flagged"`
			Categories map[string]bool `json:"categories"`
		} `json:"results"`
	}
	if err := c.send(ctx, endpoint+"/moderations", "application/json", raw, http.Header{"Authorization": []string{"Bearer " + c.values["OPENAI_MODERATION_API_KEY"]}}, &response); err != nil {
		return moderationResult{}, err
	}
	if len(response.Results) == 0 {
		return moderationResult{}, errors.New("OpenAI moderation returned no results")
	}
	for _, result := range response.Results {
		if result.Flagged == nil {
			return moderationResult{}, errors.New("OpenAI moderation returned an invalid result")
		}
		if *result.Flagged {
			categories := []string{}
			for name, value := range result.Categories {
				if value {
					categories = append(categories, name)
				}
			}
			sort.Strings(categories)
			reason := "Content blocked by OpenAI moderation"
			if len(categories) > 0 {
				reason += ": " + strings.Join(categories, ", ")
			}
			return moderationResult{Decision: "block", Provider: "openai", Reason: reason, Details: response}, nil
		}
	}
	return moderationResult{Decision: "allow", Provider: "openai", Details: response}, nil
}
func shouldBlockAliyunRisk(risk, threshold string) bool {
	order := map[string]int{"none": 0, "low": 1, "medium": 2, "high": 3}
	risk = strings.ToLower(risk)
	rank, known := order[risk]
	if !known {
		return risk != "pass"
	}
	return rank >= order[threshold]
}
func moderationChunks(content string) []string {
	runes := []rune(content)
	chunks := []string{}
	start, units := 0, 0
	for i, r := range runes {
		size := 1
		if r > 0xffff {
			size = 2
		}
		if units+size > 2000 {
			chunks = append(chunks, string(runes[start:i]))
			start = i
			units = 0
		}
		units += size
	}
	chunks = append(chunks, string(runes[start:]))
	return chunks
}
func (c moderationRuntime) aliyun(ctx context.Context, in moderationInput) (moderationResult, error) {
	isImage := in.Mode == "image" || len(in.Images) > 0
	prefix := "ALIYUN_MODERATION_TEXT_"
	if isImage {
		prefix = "ALIYUN_MODERATION_IMAGE_"
	}
	service, app := c.values[prefix+"SERVICE"], c.values[prefix+"APP_ID"]
	action := "MultiModalAgent"
	if service != "" {
		action = "TextModerationPlus"
		if isImage {
			action = "ImageModeration"
		}
	} else if app == "" {
		return moderationResult{}, errors.New(prefix + "APP_ID is not configured")
	}
	region := c.values["ALIYUN_MODERATION_REGION_ID"]
	if region == "" {
		region = "cn-shanghai"
	}
	endpoint := c.values["ALIYUN_MODERATION_ENDPOINT"]
	if service != "" {
		if v := c.values[prefix+"REGION_ID"]; v != "" {
			region = v
		}
		if v := c.values[prefix+"ENDPOINT"]; v != "" {
			endpoint = v
		}
	}
	if endpoint == "" {
		endpoint = aliyunModerationEndpoint(region)
	}
	if !strings.Contains(endpoint, "://") {
		endpoint = "https://" + endpoint
	}
	images := []moderationImage{{}}
	if isImage {
		images = in.Images
		if len(images) == 0 {
			return moderationResult{}, errors.New("Aliyun image moderation requires an image")
		}
	}
	for _, image := range images {
		if isImage && image.URL == "" {
			return moderationResult{}, errors.New("Aliyun image moderation requires public image URLs")
		}
		chunks := moderationChunks(in.Prompt)
		if action == "ImageModeration" {
			chunks = []string{""}
		}
		for _, chunk := range chunks {
			payload := map[string]any{}
			if in.GenerationID != "" {
				payload["dataId"] = in.GenerationID
			}
			if action == "ImageModeration" {
				payload["imageUrl"] = image.URL
			} else {
				payload["content"] = chunk
				if isImage {
					payload["images"] = []any{map[string]string{"imageUrl": image.URL}}
				}
			}
			raw, _ := json.Marshal(payload)
			form := url.Values{"ServiceParameters": []string{string(raw)}}
			if service != "" {
				form.Set("Service", service)
			} else {
				form.Set("AppID", app)
			}
			body := []byte(form.Encode())
			headers, err := signAliyunModeration(endpoint, action, body, c.values["ALIYUN_MODERATION_ACCESS_KEY_ID"], c.values["ALIYUN_MODERATION_ACCESS_KEY_SECRET"])
			if err != nil {
				return moderationResult{}, err
			}
			var result struct {
				Code json.RawMessage `json:"Code"`
				Data *struct {
					RiskLevel *string `json:"RiskLevel"`
					Result    []struct {
						Label string `json:"Label"`
					} `json:"Result"`
					AttackResult []struct {
						Label string `json:"Label"`
					} `json:"AttackResult"`
					SensitiveResult []struct {
						Label string `json:"Label"`
					} `json:"SensitiveResult"`
				} `json:"Data"`
			}
			if err := c.send(ctx, endpoint, "application/x-www-form-urlencoded", body, headers, &result); err != nil {
				return moderationResult{}, err
			}
			code := strings.Trim(string(result.Code), "\"")
			if code != "" && code != "200" {
				return moderationResult{}, errors.New("Aliyun moderation returned an unsuccessful status")
			}
			if result.Data == nil || result.Data.RiskLevel == nil {
				return moderationResult{}, errors.New("Aliyun moderation returned no risk result")
			}
			if shouldBlockAliyunRisk(*result.Data.RiskLevel, in.EffectiveBlockRiskLevel) {
				labels := []string{}
				for _, item := range append(append(result.Data.Result, result.Data.AttackResult...), result.Data.SensitiveResult...) {
					if item.Label != "" {
						labels = append(labels, item.Label)
					}
				}
				reason := *result.Data.RiskLevel
				if len(labels) > 0 {
					reason = strings.Join(labels, ", ")
				}
				return moderationResult{Decision: "block", Provider: "aliyun", Reason: "Content blocked by Aliyun moderation: " + reason, Details: result.Data}, nil
			}
		}
	}
	return moderationResult{Decision: "allow", Provider: "aliyun"}, nil
}
func aliyunModerationEndpoint(region string) string {
	switch region {
	case "cn-chengdu", "cn-hongkong", "cn-huhehaote", "cn-qingdao", "cn-zhangjiakou", "cn-hangzhou-finance", "cn-shenzhen-finance-1", "cn-shanghai-finance-1", "cn-north-2-gov-1":
		return "green.aliyuncs.com"
	case "ap-northeast-1", "ap-south-1", "ap-southeast-2", "ap-southeast-3", "ap-southeast-5", "eu-central-1", "eu-west-1", "me-east-1", "us-east-1":
		return "green.ap-southeast-1.aliyuncs.com"
	}
	return "green." + region + ".aliyuncs.com"
}
func signAliyunModeration(endpoint, action string, body []byte, access, secret string) (http.Header, error) {
	return signAliyunModerationAt(endpoint, action, body, access, secret, time.Now(), newRequestID())
}
func signAliyunModerationAt(endpoint, action string, body []byte, access, secret string, now time.Time, nonce string) (http.Header, error) {
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Host == "" || parsed.RawQuery != "" || parsed.User != nil || parsed.Fragment != "" || (parsed.Scheme != "https" && parsed.Scheme != "http") {
		return nil, errors.New("Aliyun moderation endpoint is invalid")
	}
	hash := func(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }
	headers := http.Header{"Content-Type": []string{"application/x-www-form-urlencoded"}, "X-Acs-Action": []string{action}, "X-Acs-Version": []string{"2022-03-02"}, "X-Acs-Date": []string{now.UTC().Format("2006-01-02T15:04:05Z")}, "X-Acs-Signature-Nonce": []string{nonce}, "X-Acs-Content-Sha256": []string{hash(body)}}
	names := []string{"content-type", "host", "x-acs-action", "x-acs-content-sha256", "x-acs-date", "x-acs-signature-nonce", "x-acs-version"}
	canonical := ""
	for _, name := range names {
		value := headers.Get(name)
		if name == "host" {
			value = parsed.Host
		}
		canonical += name + ":" + strings.TrimSpace(value) + "\n"
	}
	path := parsed.EscapedPath()
	if path == "" {
		path = "/"
	}
	request := "POST\n" + path + "\n\n" + canonical + "\n" + strings.Join(names, ";") + "\n" + hash(body)
	toSign := "ACS3-HMAC-SHA256\n" + hash([]byte(request))
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(toSign))
	headers.Set("Authorization", "ACS3-HMAC-SHA256 Credential="+access+",SignedHeaders="+strings.Join(names, ";")+",Signature="+hex.EncodeToString(mac.Sum(nil)))
	return headers, nil
}
