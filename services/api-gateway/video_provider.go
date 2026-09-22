package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const videoProviderMaxResponse = 2 << 20
const videoProviderMaxDownload = 512 << 20

type videoProviderError struct {
	code         string
	status       int
	retryAfter   int
	transient    bool
	switchMember bool
	terminal     bool
}

func (e *videoProviderError) Error() string { return "video provider " + e.code }

type videoProviderMedia struct{ value any }

func videoProviderURL(cfg providerConfig, operation, identity string) (*url.URL, error) {
	path := "/videos/generations"
	if operation == "videos.query" {
		path = "/videos/{task_id}"
	}
	if op, ok := cfg.operations[operation].(map[string]any); ok && extractString(op, "path") != "" {
		path = extractString(op, "path")
	}
	mode := extractString(cfg.adapter, "videoProtocolMode")
	if mode == "seedance" {
		path = "/api/v3/contents/generations/tasks"
		if strings.HasSuffix(cfg.baseURL, "/api/v3") {
			path = "/contents/generations/tasks"
		}
		if operation == "videos.query" {
			path += "/{task_id}"
		}
	}
	if mode == "gemini" {
		if operation == "videos.query" {
			parts := strings.Split(identity, "/")
			if len(parts) != 4 || parts[0] != "models" || parts[2] != "operations" || !videoProviderIdentifier(parts[1]) || !videoProviderIdentifier(parts[3]) {
				return nil, errors.New("invalid Gemini operation identity")
			}
			path = "/v1beta/" + identity
		} else {
			identity = imageUpstreamModel(cfg, identity)
			if !videoProviderIdentifier(identity) {
				return nil, errors.New("invalid Gemini model identity")
			}
			path = "/v1beta/models/" + identity + ":predictLongRunning"
		}
	}
	placeholder := "flux-video-" + newWorkerToken()
	if operation == "videos.query" && mode != "gemini" {
		if identity == "" || identity == "." || identity == ".." || len(identity) > 512 || strings.ContainsAny(identity, "\r\n\x00") {
			return nil, errors.New("invalid video task identity")
		}
		path = strings.ReplaceAll(path, "{taskId}", "{task_id}")
		if strings.Count(path, "{task_id}") != 1 {
			return nil, errors.New("invalid video query path")
		}
		path = strings.ReplaceAll(path, "{task_id}", placeholder)
	}
	copy := cfg
	copy.operations = map[string]any{operation: map[string]any{"path": path}}
	target, err := imageProviderURL(copy, operation)
	if err != nil {
		return nil, err
	}
	return url.Parse(strings.ReplaceAll(target.String(), placeholder, url.PathEscape(identity)))
}

func videoProviderIdentifier(value string) bool {
	if value == "" || value == "." || value == ".." || len(value) > 512 {
		return false
	}
	for _, c := range value {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("._:-", c)) {
			return false
		}
	}
	return true
}

func (b *backend) prepareVideoProviderInput(ctx context.Context, cfg providerConfig, id, userID, model, prompt, ratio, resolution string, duration int, metadata, manifest map[string]any) (map[string]any, error) {
	body := map[string]any{"client_request_id": id, "model": imageUpstreamModel(cfg, model), "prompt": prompt, "duration": duration, "aspect_ratio": ratio, "resolution": resolution, "generate_audio": metadata["generateAudio"] == true}
	if value := extractString(metadata, "negativePrompt"); value != "" {
		body["negative_prompt"] = value
	}
	mode := extractString(cfg.adapter, "videoProtocolMode")
	named, err := namedVideoReferences(manifest)
	if err != nil {
		return nil, err
	}
	_, bucket, err := b.storageBuckets(ctx)
	if err != nil {
		return nil, err
	}
	resolved := map[string]any{}
	total := 0
	for _, entry := range named {
		ref := entry.reference
		key, bk, mime := extractString(ref, "storageKey"), extractString(ref, "storageBucket"), extractString(ref, "mimeType")
		if extractString(ref, "source") != "storage" || bk != bucket || !strings.HasPrefix(key, userID+"/video-inputs/"+id+"/") || !validStorageObjectPath(bk, key) {
			return nil, errors.New("video input is not owned by this task")
		}
		image := entry.field != "referenceVideos" && entry.field != "referenceAudios"
		var value any
		if image && (extractString(cfg.adapter, "videoInputFormat") == "base64" || mode == "gemini" || mode == "seedance") {
			data, err := b.readStorageObjectLimited(ctx, bk, key, 200<<20)
			if err != nil {
				return nil, errors.New("video input could not be read")
			}
			total += len(data)
			if len(data) == 0 || len(data) > 200<<20 || total > 512<<20 {
				return nil, errors.New("video input exceeds the media limit")
			}
			encoded := base64.StdEncoding.EncodeToString(data)
			value = "data:" + mime + ";base64," + encoded
			if mode == "gemini" {
				value = map[string]any{"inlineData": map[string]any{"mimeType": mime, "data": encoded}}
			}
		} else {
			signed, err := b.storageSignedReadURL(ctx, bk, key, 3600)
			if err != nil {
				return nil, err
			}
			parsed, err := url.Parse(signed)
			if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil {
				return nil, errors.New("video provider inputs require HTTPS object storage URLs")
			}
			value = signed
		}
		media := &videoProviderMedia{value: value}
		if entry.field == "firstFrame" || entry.field == "lastFrame" {
			resolved[entry.field] = media
		} else {
			list, _ := resolved[entry.field].([]any)
			resolved[entry.field] = append(list, media)
		}
	}
	if mode == "gemini" {
		if body["generate_audio"] != true || body["negative_prompt"] != nil {
			return nil, &videoProviderError{code: "invalid_request", terminal: true}
		}
		instance := map[string]any{"prompt": prompt}
		if value := resolved["firstFrame"]; value != nil {
			instance["image"] = value
		}
		if value := resolved["lastFrame"]; value != nil {
			instance["lastFrame"] = value
		}
		if values, ok := resolved["referenceImages"].([]any); ok {
			refs := []any{}
			for _, value := range values {
				refs = append(refs, map[string]any{"image": value, "referenceType": "asset"})
			}
			instance["referenceImages"] = refs
		}
		if value := resolved["referenceVideos"]; value != nil {
			instance["reference_videos"] = value
		}
		if value := resolved["referenceAudios"]; value != nil {
			instance["reference_audios"] = value
		}
		return map[string]any{"instances": []any{instance}, "parameters": map[string]any{"aspectRatio": ratio, "resolution": resolution, "durationSeconds": fmt.Sprint(duration)}}, nil
	}
	if mode == "seedance" {
		content := []any{map[string]any{"type": "text", "text": prompt}}
		for _, field := range []string{"firstFrame", "lastFrame", "referenceImages"} {
			values := []any{}
			if list, ok := resolved[field].([]any); ok {
				values = list
			} else if resolved[field] != nil {
				values = append(values, resolved[field])
			}
			for _, value := range values {
				content = append(content, map[string]any{"type": "image_url", "image_url": map[string]any{"url": value}})
			}
		}
		body = map[string]any{"model": imageUpstreamModel(cfg, model), "content": content, "ratio": ratio, "duration": duration, "resolution": resolution, "watermark": false}
		if metadata["generateAudio"] == true {
			body["generate_audio"] = true
		}
	}
	for field, target := range map[string]string{"firstFrame": "first_frame", "lastFrame": "last_frame", "referenceImages": "reference_images", "referenceVideos": "reference_videos", "referenceAudios": "reference_audios"} {
		if value := resolved[field]; value != nil && (mode != "seedance" || field == "referenceVideos" || field == "referenceAudios") {
			body[target] = value
		}
	}
	return body, nil
}

func tokenizeVideoBody(value any, media map[string]*videoProviderMedia, files map[string]*imageProviderFile) any {
	switch value := value.(type) {
	case *videoProviderMedia:
		token := imageOpaquePrefix + newWorkerToken()
		media[token] = value
		files[token] = nil
		return token
	case map[string]any:
		out := map[string]any{}
		for key, item := range value {
			out[key] = tokenizeVideoBody(item, media, files)
		}
		return out
	case []any:
		out := make([]any, len(value))
		for i, item := range value {
			out[i] = tokenizeVideoBody(item, media, files)
		}
		return out
	default:
		return value
	}
}

func resolveVideoTokens(value any, media map[string]*videoProviderMedia) any {
	switch value := value.(type) {
	case string:
		if item, ok := media[value]; ok {
			return item.value
		}
		return value
	case map[string]any:
		out := map[string]any{}
		for key, item := range value {
			out[key] = resolveVideoTokens(item, media)
		}
		return out
	case []any:
		out := make([]any, len(value))
		for i, item := range value {
			out[i] = resolveVideoTokens(item, media)
		}
		return out
	default:
		return value
	}
}

func (b *backend) executeVideoProvider(ctx context.Context, cfg providerConfig, operation, rawURL string, body map[string]any, taskID, model string) (map[string]any, error) {
	target, err := url.Parse(rawURL)
	base, baseErr := url.Parse(cfg.baseURL)
	if err != nil || baseErr != nil || target.User != nil || target.Fragment != "" || target.Host == "" || (target.Scheme != "https" && target.Scheme != "http") || !strings.EqualFold(target.Host, base.Host) || !strings.EqualFold(target.Scheme, base.Scheme) {
		return nil, errors.New("video provider request origin does not match configured provider")
	}
	authHeader, authValue, err := imageProviderAuthentication(cfg)
	if err != nil {
		return nil, err
	}
	mode := extractString(cfg.adapter, "videoProtocolMode")
	if mode == "gemini" && (cfg.auth == "bearer" || cfg.auth == "") {
		if auth, ok := cfg.adapter["authentication"].(map[string]any); !ok || extractString(auth, "mode") == "bearer" {
			authHeader, authValue = "x-goog-api-key", cfg.apiKey
		}
	}
	media, files := map[string]*videoProviderMedia{}, map[string]*imageProviderFile{}
	payload := tokenizeVideoBody(body, media, files)
	envelope := map[string]any{}
	op, _ := cfg.operations[operation].(map[string]any)
	if script := extractString(op, "requestScript"); script != "" && mode != "gemini" && mode != "seedance" {
		client := newScriptRuntimeClient(b.config.scriptRuntimeURL, b.config.scriptRuntimeToken)
		if client == nil {
			return nil, &scriptRuntimeUnavailableError{}
		}
		query := map[string]any{}
		for key, values := range target.Query() {
			if len(values) == 1 {
				query[key] = values[0]
			} else {
				items := []any{}
				for _, value := range values {
					items = append(items, value)
				}
				query[key] = items
			}
		}
		input := map[string]any{"query": query}
		if operation == "videos.generate" {
			input["body"] = payload
		}
		raw, err := client.execute(ctx, scriptRuntimeRequest{Script: script, Operation: operation, Stage: "request", Input: input, Context: map[string]any{"operation": operation, "stage": "request", "contentType": "application/json", "platformModelId": model, "upstreamModelId": imageUpstreamModel(cfg, model), "taskId": taskID}})
		if err != nil {
			var busy *scriptRuntimeUnavailableError
			if errors.As(err, &busy) {
				return nil, err
			}
			return nil, &videoProviderError{code: "unknown_submission_failure", switchMember: true}
		}
		if json.Unmarshal(raw, &envelope) != nil || envelope == nil {
			return nil, &videoProviderError{code: "unknown_submission_failure", switchMember: true}
		}
	}
	if value, exists := envelope["body"]; exists {
		if operation == "videos.query" {
			return nil, errors.New("video query scripts cannot provide a body")
		}
		payload = value
	}
	if operation == "videos.generate" {
		if _, ok := payload.(map[string]any); !ok {
			return nil, errors.New("video request body must be an object")
		}
	}
	if err := validateImageProviderTree(payload, files, true); err != nil {
		return nil, err
	}
	if err := validateImageProviderTree(map[string]any{"body": payload, "query": envelope["query"], "headers": envelope["headers"]}, files, true); err != nil {
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
	if operation == "videos.generate" {
		if beforeSend, ok := ctx.Value(videoBeforeSendContextKey{}).(func() error); ok {
			if err := beforeSend(); err != nil {
				return nil, err
			}
		}
		if persist, ok := ctx.Value(videoSnapshotContextKey{}).(func(map[string]any) error); ok {
			if err := persist(videoRequestSnapshot(payload, media)); err != nil {
				return nil, err
			}
		}
	}
	var reader io.Reader
	method := http.MethodGet
	if operation == "videos.generate" {
		encoded, err := json.Marshal(resolveVideoTokens(payload, media))
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(encoded)
		method = http.MethodPost
	}
	req, err := http.NewRequestWithContext(ctx, method, target.String(), reader)
	if err != nil {
		return nil, err
	}
	req.Header = headers
	req.Header.Set("Accept", "application/json")
	if method == http.MethodPost {
		req.Header.Set("Content-Type", "application/json")
	}
	if authHeader != "" {
		req.Header.Set(authHeader, authValue)
	}
	client := &http.Client{Timeout: 5 * time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		return nil, &videoProviderError{code: "network_error", transient: true}
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, videoProviderMaxResponse+1))
	if err != nil {
		return nil, &videoProviderError{code: "response_read_failed", transient: operation == "videos.generate"}
	}
	if len(raw) > videoProviderMaxResponse {
		return nil, &videoProviderError{code: "response_read_failed"}
	}
	var output map[string]any
	validJSON := json.Unmarshal(raw, &output) == nil && output != nil
	script := extractString(op, "responseScript")
	if script != "" && mode != "gemini" && mode != "seedance" {
		if !validJSON {
			return nil, &videoProviderError{code: "response_parse_failed", terminal: operation == "videos.generate"}
		}
		output, err = b.applyProviderResponseScript(ctx, cfg, operation, output, resp.StatusCode, resp.Header, taskID, model)
		if err != nil {
			var busy *scriptRuntimeUnavailableError
			if operation == "videos.query" && errors.As(err, &busy) {
				return nil, err
			}
			return nil, &videoProviderError{code: "unknown_submission_failure", terminal: operation == "videos.generate"}
		}
		if err = validateScriptedVideoResult(output, operation == "videos.query"); err != nil {
			return nil, &videoProviderError{code: "response_parse_failed", terminal: operation == "videos.generate"}
		}
	} else if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if !(resp.StatusCode == 409 && operation == "videos.generate" && validJSON && videoResultTaskID(output) != "") {
			e := &videoProviderError{code: "invalid_request", status: resp.StatusCode, retryAfter: imageProviderRetryAfter(resp.Header.Get("Retry-After"), time.Now()), terminal: true}
			switch {
			case resp.StatusCode == 429:
				e.code, e.transient, e.terminal = "rate_limited", true, false
			case resp.StatusCode == 408:
				e.code, e.transient, e.terminal = "submission_timeout", true, false
			case resp.StatusCode >= 500:
				e.code, e.transient, e.terminal = "upstream_unavailable", true, false
			case resp.StatusCode == 401:
				e.code, e.switchMember, e.terminal = "authentication_failed", true, false
			case resp.StatusCode == 403:
				e.code, e.switchMember, e.terminal = "permission_denied", true, false
			case resp.StatusCode == 409:
				e.code = "submission_conflict"
			}
			return nil, e
		}
	} else if !validJSON {
		return nil, &videoProviderError{code: "response_parse_failed"}
	}
	if mode == "gemini" {
		output, err = normalizeGeminiVideoResult(output, taskID, imageUpstreamModel(cfg, model), operation == "videos.query")
		if err != nil {
			return nil, err
		}
	}
	seconds := 5
	if n := goInt64(output["pollAfterSeconds"]); n >= 1 && n <= 300 {
		seconds = int(n)
	}
	if retry := imageProviderRetryAfter(resp.Header.Get("Retry-After"), time.Now()); retry > seconds {
		seconds = retry
	}
	output["__fluxVideoPollAfterSeconds"] = seconds
	return output, nil
}

func videoResultRecord(output map[string]any) map[string]any {
	if nested, ok := output["data"].(map[string]any); ok {
		return nested
	}
	return output
}
func videoResultTaskID(output map[string]any) string {
	return extractString(videoResultRecord(output), "taskId", "task_id", "id", "generation_id", "job_id", "jobId", "operation_name", "operationName")
}

func validateScriptedVideoResult(result map[string]any, query bool) error {
	switch extractString(result, "status") {
	case "pending", "processing":
		if err := imageProviderResultKeys(result, "status", "taskId", "progress", "pollAfterSeconds"); err != nil {
			return err
		}
		if !query && extractString(result, "taskId") == "" {
			return errors.New("video response omitted task identity")
		}
		if value, exists := result["taskId"]; exists {
			identity, ok := value.(string)
			if !ok || len(strings.TrimSpace(identity)) == 0 || len(identity) > 1024 {
				return errors.New("invalid video response task ID")
			}
		}
		for key, limit := range map[string]float64{"progress": 100, "pollAfterSeconds": 300} {
			if value, exists := result[key]; exists {
				n, ok := value.(float64)
				if !ok || math.IsNaN(n) || n < 0 || n > limit || (key == "pollAfterSeconds" && (n < 1 || math.Trunc(n) != n)) {
					return errors.New("invalid video response progress or poll delay")
				}
			}
		}
	case "completed":
		if err := imageProviderResultKeys(result, "status", "outputs"); err != nil {
			return err
		}
		outputs, ok := result["outputs"].([]any)
		if !ok || len(outputs) == 0 {
			return errors.New("video response requires an output")
		}
		for _, raw := range outputs {
			output, ok := raw.(map[string]any)
			if !ok || output["kind"] != "video" || extractString(output, "url") == "" {
				return errors.New("video response requires a video URL")
			}
			if err := imageProviderResultKeys(output, "kind", "url"); err != nil {
				return err
			}
			u, err := url.Parse(extractString(output, "url"))
			if err != nil || u.Host == "" || u.User != nil || (u.Scheme != "https" && u.Scheme != "http") {
				return errors.New("invalid video response output URL")
			}
		}
	case "failed":
		if err := imageProviderResultKeys(result, "status", "error", "retryable"); err != nil {
			return err
		}
		errorRecord, ok := result["error"].(map[string]any)
		if !ok || extractString(errorRecord, "category") == "" || extractString(errorRecord, "code") == "" {
			return errors.New("video response requires a classified error")
		}
		if err := imageProviderResultKeys(errorRecord, "category", "code", "adminDetails"); err != nil {
			return err
		}
		if !regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`).MatchString(extractString(errorRecord, "code")) {
			return errors.New("invalid video response error code")
		}
		switch extractString(errorRecord, "category") {
		case "invalid_request", "authentication", "permission", "rate_limit", "capacity", "moderation", "not_found", "timeout", "upstream", "unknown":
		default:
			return errors.New("invalid video response error category")
		}
		if detail, exists := errorRecord["adminDetails"]; exists {
			text, ok := detail.(string)
			if !ok || strings.TrimSpace(text) == "" || len(text) > 1024 {
				return errors.New("invalid video response error details")
			}
		}
		if value, exists := result["retryable"]; exists {
			if _, ok := value.(bool); !ok {
				return errors.New("invalid video response retry flag")
			}
		}
		if query && result["retryable"] == true {
			return errors.New("accepted video cannot request resubmission")
		}
	default:
		return errors.New("video response has invalid status")
	}
	return nil
}

func normalizeGeminiVideoResult(output map[string]any, taskID, model string, query bool) (map[string]any, error) {
	name := extractString(output, "name")
	if name == "" && query {
		name = taskID
	}
	if !strings.HasPrefix(name, "models/"+model+"/operations/") || strings.Count(name, "/") != 3 {
		return nil, &videoProviderError{code: "missing_upstream_task_id"}
	}
	if output["done"] == true {
		if output["error"] != nil {
			return map[string]any{"status": "failed", "taskId": name}, nil
		}
		response, _ := output["response"].(map[string]any)
		generated, _ := response["generateVideoResponse"].(map[string]any)
		samples, _ := generated["generatedSamples"].([]any)
		if len(samples) > 0 {
			sample, _ := samples[0].(map[string]any)
			video, _ := sample["video"].(map[string]any)
			if uri := extractString(video, "uri"); uri != "" {
				return map[string]any{"status": "completed", "taskId": name, "video_url": uri}, nil
			}
		}
		if query {
			return nil, &videoProviderError{code: "response_parse_failed", terminal: true}
		}
	}
	return map[string]any{"status": "processing", "taskId": name}, nil
}

func inspectVideoProviderResult(cfg providerConfig, output map[string]any, expectedID string) (string, string, error) {
	record := videoResultRecord(output)
	status := strings.ToLower(extractString(record, "status", "state"))
	id := videoResultTaskID(output)
	if expectedID != "" && id != "" && id != expectedID {
		return "", "", &videoProviderError{code: "response_parse_failed"}
	}
	if id == "" {
		id = expectedID
	}
	if status == "failed" || status == "error" || status == "rejected" || status == "cancelled" || status == "canceled" {
		detail, _ := record["error"].(map[string]any)
		category := extractString(detail, "category")
		e := &videoProviderError{code: "unknown_submission_failure", terminal: true}
		if category == "moderation" {
			e.code = "moderation_rejected"
		} else if category == "invalid_request" {
			e.code = "invalid_request"
		} else if category == "authentication" || category == "permission" {
			e.switchMember = true
			e.terminal = false
			e.code = "authentication_failed"
		} else if record["retryable"] == true {
			e.transient = true
			e.terminal = false
			e.code = "upstream_unavailable"
		}
		return "", id, e
	}
	mediaURL := extractMediaURL(record)
	if mediaURL == "" {
		mediaURL = extractString(record, "output_url")
		if content, ok := record["content"].(map[string]any); ok {
			mediaURL = extractString(content, "video_url", "url")
		}
		if content, ok := record["content"].([]any); ok {
			for _, item := range content {
				entry, _ := item.(map[string]any)
				if mediaURL = extractString(entry, "video_url"); mediaURL != "" {
					break
				}
				if video, ok := entry["video_url"].(map[string]any); ok {
					mediaURL = extractString(video, "url")
					if mediaURL != "" {
						break
					}
				}
			}
		}
	}
	if mediaURL != "" && (status == "" || status == "completed" || status == "succeeded" || status == "success" || status == "done") {
		base, err := url.Parse(strings.TrimRight(cfg.baseURL, "/") + "/")
		if err != nil {
			return "", "", err
		}
		u, err := url.Parse(mediaURL)
		if err != nil {
			return "", "", err
		}
		u = base.ResolveReference(u)
		if u.Host == "" || u.User != nil || u.Fragment != "" || (u.Scheme != "http" && u.Scheme != "https") {
			return "", "", errors.New("invalid video output URL")
		}
		return u.String(), id, nil
	}
	if status == "completed" || status == "succeeded" || status == "done" {
		return "", id, &videoProviderError{code: "response_parse_failed"}
	}
	switch status {
	case "", "pending", "processing", "queued", "running", "created", "in_progress", "submitted":
	default:
		return "", id, &videoProviderError{code: "response_parse_failed"}
	}
	if id == "" {
		return "", "", &videoProviderError{code: "missing_upstream_task_id"}
	}
	return "", id, nil
}

func downloadVideoMedia(ctx context.Context, rawURL string) ([]byte, string, error) {
	u, err := url.Parse(rawURL)
	if err != nil || u.Host == "" || u.User != nil || u.Fragment != "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, "", errors.New("invalid video output URL")
	}
	client := &http.Client{Timeout: 20 * time.Minute, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) > 3 || req.URL.User != nil || (req.URL.Scheme != "https" && req.URL.Scheme != "http") {
			return errors.New("invalid video download redirect")
		}
		return nil
	}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, "", err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, "", &videoProviderError{code: "network_error", transient: true}
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, "", &videoProviderError{code: "upstream_unavailable", status: resp.StatusCode, transient: true}
	}
	if resp.ContentLength > videoProviderMaxDownload {
		return nil, "", errors.New("video output exceeds the media limit")
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, videoProviderMaxDownload+1))
	if err != nil {
		return nil, "", &videoProviderError{code: "response_read_failed", transient: true}
	}
	if len(data) == 0 || len(data) > videoProviderMaxDownload {
		return nil, "", errors.New("video output exceeds the media limit")
	}
	return data, "video/mp4", nil
}

func (b *backend) videoProviderForTask(ctx context.Context, memberID, versionID string) (providerConfig, error) {
	var cfg providerConfig
	var raw []byte
	err := b.db.QueryRow(ctx, `SELECT v.member_id_snapshot,COALESCE(c.api_key,''),v.id,v.configuration,COALESCE(m.content_safety_enabled,true) FROM image_backend_member_api_adapter_version v JOIN image_backend_member_api_config c ON c.member_id=v.member_id_snapshot AND c.credential_scope=v.credential_scope LEFT JOIN image_backend_member m ON m.id=v.member_id_snapshot WHERE v.member_id_snapshot=$1 AND v.id=$2`, memberID, versionID).Scan(&cfg.memberID, &cfg.apiKey, &cfg.versionID, &raw, &cfg.contentSafetyEnabled)
	if err != nil {
		return cfg, err
	}
	if json.Unmarshal(raw, &cfg.adapter) != nil {
		return cfg, errors.New("invalid video adapter configuration")
	}
	cfg.baseURL = strings.TrimRight(extractString(cfg.adapter, "baseUrl", "baseURL"), "/")
	if cfg.baseURL == "" {
		return cfg, errors.New("video provider baseUrl is missing")
	}
	cfg.operations, _ = cfg.adapter["operations"].(map[string]any)
	cfg.auth = extractString(cfg.adapter, "authentication")
	if auth, ok := cfg.adapter["authentication"].(map[string]any); ok {
		cfg.auth = extractString(auth, "mode")
	}
	if cfg.auth == "" {
		cfg.auth = "bearer"
	}
	return cfg, nil
}
