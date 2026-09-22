package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const imageProviderMaxResponse = 128 << 20

var errImageTransparentUnsupported = errors.New("image provider does not support transparent backgrounds")

type imageProviderTransportError struct{ retryAfterSeconds int }

func (*imageProviderTransportError) Error() string {
	return "image provider transport temporarily unavailable"
}

func imageProviderQueryURL(cfg providerConfig, operation, taskID string) (*url.URL, error) {
	if operation != "images.generate.query" && operation != "images.edit.query" {
		return nil, errors.New("invalid image query operation")
	}
	op, _ := cfg.operations[operation].(map[string]any)
	configured := strings.TrimSpace(extractString(op, "path"))
	if strings.Count(configured, "{task_id}") != 1 || taskID == "" || taskID == "." || taskID == ".." {
		return nil, errors.New("image provider query requires a fixed path with one task ID placeholder")
	}
	copy := cfg
	placeholder := "flux-task-" + newWorkerToken()
	copy.operations = map[string]any{operation: map[string]any{"path": strings.Replace(configured, "{task_id}", placeholder, 1)}}
	target, err := imageProviderURL(copy, operation)
	if err != nil {
		return nil, err
	}
	return url.Parse(strings.Replace(target.String(), placeholder, url.PathEscape(taskID), 1))
}

func (b *backend) queryImageProvider(ctx context.Context, cfg providerConfig, operation, taskID, model string) (map[string]any, error) {
	target, err := imageProviderQueryURL(cfg, operation, taskID)
	if err != nil {
		return nil, err
	}
	authHeader, authValue, err := imageProviderAuthentication(cfg)
	if err != nil {
		return nil, err
	}
	envelope := map[string]any{}
	op, _ := cfg.operations[operation].(map[string]any)
	if script := strings.TrimSpace(extractString(op, "requestScript")); script != "" {
		client := newScriptRuntimeClient(b.config.scriptRuntimeURL, b.config.scriptRuntimeToken)
		if client == nil {
			return nil, errors.New("image query script runtime unavailable")
		}
		raw, err := client.execute(ctx, scriptRuntimeRequest{Script: script, Operation: operation, Stage: "request", Input: map[string]any{"query": map[string]any{}}, Context: map[string]any{"operation": operation, "stage": "request", "contentType": "application/json", "taskId": taskID, "platformModelId": model, "upstreamModelId": imageUpstreamModel(cfg, model)}})
		if err != nil {
			return nil, err
		}
		if json.Unmarshal(raw, &envelope) != nil || envelope == nil {
			return nil, errors.New("image query script returned an invalid envelope")
		}
	}
	if _, exists := envelope["body"]; exists {
		return nil, errors.New("image query scripts cannot provide a request body")
	}
	if err := validateImageProviderTree(envelope, nil, false); err != nil {
		return nil, err
	}
	headers, err := mergeImageProviderEnvelope(target, envelope, authHeader)
	if err != nil {
		return nil, err
	}
	ctx, releaseResponse, err := b.reserveProviderResponse(ctx, cfg, operation)
	if err != nil {
		return nil, err
	}
	defer releaseResponse()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header = headers
	req.Header.Set("Accept", "application/json")
	if authHeader != "" {
		req.Header.Set(authHeader, authValue)
	}
	client := &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(req)
	if err != nil {
		return nil, &imageProviderTransportError{}
	}
	defer response.Body.Close()
	return b.decodeImageProviderResponse(ctx, cfg, operation, response, taskID, model)
}

func (b *backend) decodeImageProviderResponse(ctx context.Context, cfg providerConfig, operation string, response *http.Response, taskID, model string) (map[string]any, error) {
	var raw []byte
	var err error
	var streamed map[string]any
	var streamError error
	if response.StatusCode >= 200 && response.StatusCode < 300 && strings.Contains(strings.ToLower(response.Header.Get("Content-Type")), "text/event-stream") {
		var buffer bytes.Buffer
		onPartial, _ := ctx.Value(imagePreviewContextKey{}).(func(map[string]any))
		limited := io.LimitReader(response.Body, imageProviderMaxResponse+1)
		streamed, streamError = parseImageProviderSSEReader(io.TeeReader(limited, &buffer), onPartial)
		if _, err = io.Copy(&buffer, limited); err != nil {
			return nil, &imageProviderTransportError{}
		}
		raw = buffer.Bytes()
	} else {
		raw, err = io.ReadAll(io.LimitReader(response.Body, imageProviderMaxResponse+1))
		if err != nil {
			return nil, &imageProviderTransportError{}
		}
	}
	if len(raw) > imageProviderMaxResponse {
		return nil, errors.New("image provider response exceeds the media limit")
	}
	// Classify only an explicit rejection. Never turn an ambiguous transport
	// failure into another billable submission, or expose the provider body.
	if response.StatusCode == http.StatusBadRequest && len(raw) <= 65536 && bytes.Contains(bytes.ToLower(raw), []byte("transparent background is not supported")) {
		return nil, errImageTransparentUnsupported
	}
	op, _ := cfg.operations[operation].(map[string]any)
	script := strings.TrimSpace(extractString(op, "responseScript"))
	var result map[string]any
	if script != "" {
		result, err = b.runImageProviderResponseScript(ctx, cfg, operation, script, raw, response, taskID, model)
	} else if response.StatusCode < 200 || response.StatusCode >= 300 {
		if response.StatusCode == 429 || response.StatusCode >= 500 {
			return nil, &imageProviderTransportError{retryAfterSeconds: imageProviderRetryAfter(response.Header.Get("Retry-After"), time.Now())}
		}
		return nil, fmt.Errorf("image provider HTTP %d", response.StatusCode)
	} else if strings.Contains(strings.ToLower(response.Header.Get("Content-Type")), "text/event-stream") || bytes.HasPrefix(bytes.TrimSpace(raw), []byte("event:")) || bytes.HasPrefix(bytes.TrimSpace(raw), []byte("data:")) {
		if streamed != nil || streamError != nil {
			result, err = streamed, streamError
		} else {
			result, err = parseImageProviderSSE(raw)
		}
	} else if json.Unmarshal(raw, &result) != nil || result == nil {
		return nil, errors.New("image provider returned invalid JSON")
	}
	if err != nil {
		return nil, err
	}
	if result["status"] == "failed" {
		failure, _ := result["error"].(map[string]any)
		if failure["category"] == "invalid_request" && (failure["code"] == "transparent_background_unsupported" || strings.Contains(strings.ToLower(extractString(failure, "adminDetails")), "transparent background is not supported")) {
			return nil, errImageTransparentUnsupported
		}
	}
	seconds := 5
	if n, ok := result["pollAfterSeconds"].(float64); ok && n >= 1 && n <= 300 {
		seconds = int(n)
	}
	if retry := imageProviderRetryAfter(response.Header.Get("Retry-After"), time.Now()); retry > seconds {
		seconds = retry
	}
	result["__fluxImagePollAfterSeconds"] = seconds
	return result, nil
}

func imageProviderRetryAfter(value string, now time.Time) int {
	n, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil {
		at, e := http.ParseTime(value)
		if e != nil {
			return 0
		}
		n = int(at.Sub(now).Seconds() + 0.999)
	}
	if n <= 0 {
		return 0
	}
	if n > 300 {
		return 300
	}
	return n
}

// Partial frames are progress only. A completed event wins over any earlier
// full-frame fallback; malformed event data does not erase a valid final image.
func parseImageProviderSSE(raw []byte) (map[string]any, error) {
	return parseImageProviderSSEReader(bytes.NewReader(raw), nil)
}

func parseImageProviderSSEReader(reader io.Reader, onPartial func(map[string]any)) (map[string]any, error) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 4096), imageProviderMaxResponse)
	var completed, fallback map[string]any
	event := ""
	data := []string{}
	flush := func() error {
		text := strings.TrimSpace(strings.Join(data, "\n"))
		defer func() { event = ""; data = nil }()
		if text == "" || text == "[DONE]" {
			return nil
		}
		var item map[string]any
		if json.Unmarshal([]byte(text), &item) != nil {
			return nil
		}
		kind := extractString(item, "type")
		if event == "error" || kind == "upstream_error" || item["error"] != nil {
			return errors.New("image provider stream reported an error")
		}
		if strings.Contains(event, "partial_image") || strings.Contains(kind, "partial_image") {
			if onPartial != nil {
				onPartial(item)
			}
			return nil
		}
		if !imageProviderHasOutput(item) {
			return nil
		}
		if strings.HasSuffix(event, ".completed") || strings.HasSuffix(kind, ".completed") {
			completed = item
		} else if fallback == nil {
			fallback = item
		}
		return nil
	}
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			if err := flush(); err != nil {
				return nil, err
			}
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		field, value, _ := strings.Cut(line, ":")
		value = strings.TrimPrefix(value, " ")
		if field == "event" {
			event = value
		}
		if field == "data" {
			data = append(data, value)
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, errors.New("image provider stream could not be parsed")
	}
	if err := flush(); err != nil {
		return nil, err
	}
	if completed != nil {
		return completed, nil
	}
	if fallback != nil {
		return fallback, nil
	}
	return nil, errors.New("image provider stream ended without a completed image")
}

func protectImageResponse(value any, field string, tokens map[string]*imageProviderFile) any {
	switch value := value.(type) {
	case string:
		normalized := strings.NewReplacer("_", "", "-", "").Replace(strings.ToLower(field))
		imageField := map[string]bool{"b64": true, "b64json": true, "base64": true, "base64image": true, "imageb64": true, "imagebase64": true, "partialimageb64": true}[normalized]
		prefix := value
		if len(prefix) > 128 {
			prefix = prefix[:128]
		}
		decoded, _ := base64.StdEncoding.DecodeString(prefix)
		protected := strings.HasPrefix(value, "data:image/") || (imageField && !strings.HasPrefix(value, "http")) || strings.HasPrefix(http.DetectContentType(decoded), "image/")
		if protected {
			token := imageOpaquePrefix + strings.ReplaceAll(newRequestID(), "-", "")
			tokens[token] = &imageProviderFile{Data: []byte(value)}
			return token
		}
		return value
	case map[string]any:
		out := map[string]any{}
		for key, item := range value {
			out[key] = protectImageResponse(item, key, tokens)
		}
		return out
	case []any:
		out := make([]any, len(value))
		for i, item := range value {
			out[i] = protectImageResponse(item, field, tokens)
		}
		return out
	default:
		return value
	}
}
func restoreImageResponse(value any, tokens map[string]*imageProviderFile) any {
	switch value := value.(type) {
	case string:
		if token, ok := tokens[value]; ok {
			return string(token.Data)
		}
		return value
	case map[string]any:
		out := map[string]any{}
		for key, item := range value {
			out[key] = restoreImageResponse(item, tokens)
		}
		return out
	case []any:
		out := make([]any, len(value))
		for i, item := range value {
			out[i] = restoreImageResponse(item, tokens)
		}
		return out
	default:
		return value
	}
}

func (b *backend) runImageProviderResponseScript(ctx context.Context, cfg providerConfig, operation, script string, raw []byte, response *http.Response, taskID, model string) (map[string]any, error) {
	var body any
	if json.Unmarshal(raw, &body) != nil {
		body = string(raw)
	}
	tokens := map[string]*imageProviderFile{}
	body = protectImageResponse(body, "", tokens)
	if err := validateImageProviderTree(body, tokens, true); err != nil {
		return nil, err
	}
	headers := map[string]any{}
	for _, key := range []string{"content-type", "retry-after", "request-id", "x-request-id"} {
		if value := response.Header.Get(key); value != "" {
			headers[key] = value
		}
	}
	client := newScriptRuntimeClient(b.config.scriptRuntimeURL, b.config.scriptRuntimeToken)
	if client == nil {
		return nil, errors.New("image response script runtime unavailable")
	}
	contentType := "application/json"
	if operation == "images.edit" && cfg.adapter["convertReferenceImagesToPublicUrl"] != true {
		contentType = "multipart/form-data"
	}
	encoded, err := client.execute(ctx, scriptRuntimeRequest{Script: script, Operation: operation, Stage: "response", ResponsePermitID: providerResponsePermitID(ctx), Input: map[string]any{"body": body, "headers": headers, "statusCode": response.StatusCode}, Context: map[string]any{"operation": operation, "stage": "response", "contentType": contentType, "platformModelId": model, "upstreamModelId": imageUpstreamModel(cfg, model), "taskId": taskID}})
	if err != nil {
		return nil, err
	}
	var result map[string]any
	if json.Unmarshal(encoded, &result) != nil || result == nil {
		return nil, errors.New("image response script returned invalid JSON")
	}
	if err := validateImageProviderTree(result, tokens, true); err != nil {
		return nil, err
	}
	result = restoreImageResponse(result, tokens).(map[string]any)
	if err := validateImageProviderScriptResult(result, operation, taskID); err != nil {
		return nil, err
	}
	return result, nil
}

var imageProviderStableErrorCode = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)

func imageProviderResultKeys(value map[string]any, allowed ...string) error {
	for key := range value {
		found := false
		for _, name := range allowed {
			found = found || key == name
		}
		if !found {
			return errors.New("image response script returned an unknown result property")
		}
	}
	return nil
}

func validateImageProviderScriptResult(result map[string]any, operation, taskID string) error {
	status := extractString(result, "status")
	query := strings.HasSuffix(operation, ".query")
	switch status {
	case "pending", "processing":
		if err := imageProviderResultKeys(result, "status", "taskId", "progress", "pollAfterSeconds"); err != nil {
			return err
		}
		id := extractString(result, "taskId")
		if value, exists := result["taskId"]; exists {
			if _, ok := value.(string); !ok || strings.TrimSpace(id) == "" || len([]rune(strings.TrimSpace(id))) > 1024 {
				return errors.New("image response script returned an invalid task ID")
			}
			id = strings.TrimSpace(id)
			result["taskId"] = id
		}
		if !query && id == "" {
			return errors.New("image response script omitted accepted task ID")
		}
		if query && id != "" && id != taskID {
			return errors.New("image response script changed the accepted task ID")
		}
		if query && id == "" {
			result["taskId"] = taskID
		}
		if value, exists := result["progress"]; exists {
			if n, ok := value.(float64); !ok || n < 0 || n > 100 {
				return errors.New("image response script returned invalid progress")
			}
		}
		if value, exists := result["pollAfterSeconds"]; exists {
			if n, ok := value.(float64); !ok || n < 1 || n > 300 || n != float64(int(n)) {
				return errors.New("image response script returned an invalid poll delay")
			}
		}
	case "completed":
		if err := imageProviderResultKeys(result, "status", "outputs"); err != nil {
			return err
		}
		outputs, ok := result["outputs"].([]any)
		if !ok || len(outputs) == 0 {
			return errors.New("image response script omitted image outputs")
		}
		for _, item := range outputs {
			out, ok := item.(map[string]any)
			if !ok || extractString(out, "kind") != "image" {
				return errors.New("image response script returned non-image output")
			}
			if err := imageProviderResultKeys(out, "kind", "url", "base64", "mediaType"); err != nil {
				return err
			}
			imageURL, hasURL := out["url"]
			base64Image, hasBase64 := out["base64"]
			if hasURL == hasBase64 {
				return errors.New("image response script output requires exactly one URL or base64 image")
			}
			if hasURL {
				value, ok := imageURL.(string)
				parsed, err := url.Parse(value)
				if !ok || err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
					return errors.New("image response script returned an invalid media URL")
				}
			}
			if hasBase64 {
				if value, ok := base64Image.(string); !ok || value == "" {
					return errors.New("image response script returned an invalid base64 image")
				}
			}
			if value, exists := out["mediaType"]; exists {
				mediaType, ok := value.(string)
				if !ok || !hasBase64 || strings.TrimSpace(mediaType) == "" || len([]rune(strings.TrimSpace(mediaType))) > 120 {
					return errors.New("image response script returned an invalid media type")
				}
				out["mediaType"] = strings.TrimSpace(mediaType)
			}
		}
	case "failed":
		if err := imageProviderResultKeys(result, "status", "error", "retryable"); err != nil {
			return err
		}
		if value, exists := result["retryable"]; exists {
			if _, ok := value.(bool); !ok {
				return errors.New("image response script returned an invalid retry flag")
			}
		}
		if query && result["retryable"] == true {
			return errors.New("accepted image queries cannot resubmit generation")
		}
		failure, ok := result["error"].(map[string]any)
		if !ok {
			return errors.New("image response script omitted the failure reason")
		}
		if err := imageProviderResultKeys(failure, "category", "code", "adminDetails"); err != nil {
			return err
		}
		category := extractString(failure, "category")
		switch category {
		case "invalid_request", "authentication", "permission", "rate_limit", "capacity", "moderation", "not_found", "timeout", "upstream", "unknown":
		default:
			return errors.New("image response script returned an invalid failure category")
		}
		if !imageProviderStableErrorCode.MatchString(extractString(failure, "code")) {
			return errors.New("image response script returned an invalid failure code")
		}
		if value, exists := failure["adminDetails"]; exists {
			details, ok := value.(string)
			if !ok || strings.TrimSpace(details) == "" || len([]rune(strings.TrimSpace(details))) > 1024 {
				return errors.New("image response script returned invalid administrator details")
			}
		}
	default:
		return errors.New("image response script returned an invalid task status")
	}
	return nil
}
