package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const imageOpaquePrefix = "__fluxmedia_opaque_"

// Bytes stay in Go. Only the token representing each file is sent to QuickJS.
type imageProviderFile struct {
	Name, MIME string
	Data       []byte
}

func imageUpstreamModel(cfg providerConfig, model string) string {
	if mappings, ok := cfg.adapter["modelMappings"].([]any); ok {
		for _, value := range mappings {
			mapping, _ := value.(map[string]any)
			if strings.EqualFold(strings.TrimSpace(extractString(mapping, "modelId")), strings.TrimSpace(model)) {
				if upstream := extractString(mapping, "upstreamModelId"); upstream != "" {
					return upstream
				}
			}
		}
	}
	return model
}

func imageProviderParameters(cfg providerConfig, model string, body map[string]any) (map[string]any, error) {
	prompt := extractString(body, "prompt")
	if body["promptOptimization"] != false && body["promptOptimization"] != "false" {
		if optimized := extractString(body, "apiPrompt"); optimized != "" {
			prompt = optimized
		}
	}
	if context := extractString(body, "fileContext"); context != "" {
		prompt += "\n\n" + context
	}
	out := map[string]any{"model": imageUpstreamModel(cfg, model), "prompt": prompt, "n": 1, "response_format": "b64_json"}
	if cfg.adapter["useStream"] == true {
		out["stream"], out["partial_images"] = true, 2
	}
	ratio, resolution := extractString(body, "aspectRatio", "aspect_ratio"), extractString(body, "resolution")
	sizeConfig, _ := cfg.adapter["imageSizeConfig"].(map[string]any)
	if byModel, ok := cfg.adapter["imageSizeConfigsByModel"].(map[string]any); ok {
		if selected, ok := byModel[strings.ToLower(strings.TrimSpace(model))].(map[string]any); ok {
			sizeConfig = selected
		}
	}
	if sizeConfig != nil {
		mappings, _ := sizeConfig["mappings"].([]any)
		for _, item := range mappings {
			mapping, _ := item.(map[string]any)
			if ratio != "" && resolution != "" && strings.EqualFold(extractString(mapping, "aspectRatio"), ratio) && strings.EqualFold(extractString(mapping, "resolution"), resolution) {
				out["size"] = extractString(mapping, "size")
				break
			}
		}
		if out["size"] == nil || out["size"] == "" {
			return nil, errors.New("image provider size configuration does not support the requested aspect ratio and resolution")
		}
	} else {
		if ratio != "" {
			out["aspect_ratio"] = ratio
		}
		if resolution != "" {
			out["resolution"] = resolution
		}
		// Legacy persisted requests may already have resolved size, without a
		// model-specific snapshot. Preserve that explicit upstream value.
		if size := extractString(body, "size"); size != "" {
			out["size"] = size
		}
	}
	if size, ok := out["size"].(string); ok {
		if parts := imageSizePattern.FindStringSubmatch(size); len(parts) == 3 {
			out["width"], _ = strconv.Atoi(parts[1])
			out["height"], _ = strconv.Atoi(parts[2])
		}
	}
	for _, key := range []string{"quality", "moderation", "background"} {
		if value := extractString(body, key); value != "" && !(key == "quality" && value == "auto") {
			out[key] = value
		}
	}
	if value := extractString(body, "outputFormat", "output_format"); value != "" {
		out["output_format"] = value
	}
	for _, key := range []string{"outputCompression", "output_compression"} {
		if value, exists := body[key]; exists && value != nil {
			out["output_compression"] = value
			break
		}
	}
	return out, nil
}

func (b *backend) prepareImageProviderInput(ctx context.Context, cfg providerConfig, userID, operation, model string, body map[string]any) (string, map[string]any, error) {
	params, err := imageProviderParameters(cfg, model, body)
	if err != nil {
		return "", nil, err
	}
	if operation == "generate" {
		return "images.generate", params, nil
	}
	if operation != "edit" && operation != "mask" {
		return "", nil, errors.New("unsupported image task operation")
	}
	refs, ok := body["images"].([]any)
	if !ok || len(refs) == 0 {
		return "", nil, errors.New("image edit task has no stored source images")
	}
	publicURL, _ := cfg.adapter["convertReferenceImagesToPublicUrl"].(bool)
	if publicURL {
		if len(refs) > 10 {
			return "", nil, errors.New("public URL image edits support at most 10 references")
		}
		if body["mask"] != nil || operation == "mask" {
			return "", nil, errors.New("public URL image edits do not support masks")
		}
		urls := []string{}
		for _, ref := range refs {
			bucket, key, _, _, err := b.imageProviderStorageReference(ctx, userID, ref)
			if err != nil {
				return "", nil, err
			}
			signed, err := b.storageSignedReadURL(ctx, bucket, key, 3600)
			if err != nil {
				return "", nil, err
			}
			if strings.HasPrefix(signed, "/") {
				origin := b.config.publicAppURL
				if origin == "" {
					origin = b.config.authURL
				}
				signed = strings.TrimRight(origin, "/") + signed
			}
			parsed, err := url.Parse(signed)
			if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") {
				return "", nil, errors.New("image edit reference has no absolute signed URL")
			}
			urls = append(urls, signed)
		}
		params["image_urls"] = urls
		return "images.edit", params, nil
	}
	files := []any{}
	for _, ref := range refs {
		file, err := b.loadImageProviderFile(ctx, userID, ref)
		if err != nil {
			return "", nil, err
		}
		files = append(files, file)
	}
	if len(files) == 1 {
		params["image"] = files[0]
	} else {
		params["image[]"] = files
	}
	if ref := body["mask"]; ref != nil {
		file, err := b.loadImageProviderFile(ctx, userID, ref)
		if err != nil {
			return "", nil, err
		}
		params["mask"] = file
	} else if operation == "mask" {
		return "", nil, errors.New("image mask task has no stored mask")
	}
	// Browser FormData supplies strings to the script, including numeric options.
	for key, value := range params {
		if _, ok := value.(*imageProviderFile); !ok {
			if _, ok := value.([]any); !ok {
				params[key] = fmt.Sprint(value)
			}
		}
	}
	return "images.edit", params, nil
}

func (b *backend) imageProviderStorageReference(ctx context.Context, userID string, ref any) (string, string, string, string, error) {
	value, ok := ref.(map[string]any)
	if !ok {
		return "", "", "", "", errors.New("invalid persisted image reference")
	}
	bucket, key := extractString(value, "storageBucket"), extractString(value, "storageKey")
	if source := extractString(value, "source"); source != "" && source != "storage" {
		return "", "", "", "", errors.New("image worker requires staged storage references")
	}
	if err := b.validateModerationStorageOwner(ctx, userID, bucket, key); err != nil {
		return "", "", "", "", err
	}
	mimeType := extractString(value, "mimeType", "type")
	if mimeType != "image/png" && mimeType != "image/jpeg" && mimeType != "image/webp" {
		return "", "", "", "", errors.New("unsupported stored image type")
	}
	name := extractString(value, "name")
	if name == "" {
		name = path.Base(key)
	}
	return bucket, key, mimeType, name, nil
}
func (b *backend) loadImageProviderFile(ctx context.Context, userID string, ref any) (*imageProviderFile, error) {
	bucket, key, mimeType, name, err := b.imageProviderStorageReference(ctx, userID, ref)
	if err != nil {
		return nil, err
	}
	data, err := b.readStorageObjectLimited(ctx, bucket, key, imageProviderMaxResponse)
	if err != nil {
		return nil, errors.New("stored image input could not be read")
	}
	if len(data) == 0 {
		return nil, errors.New("stored image input is empty")
	}
	return &imageProviderFile{Name: name, MIME: mimeType, Data: data}, nil
}

// The original multipart script contract is a flat object with a token per
// file, e.g. { image: token, mask: token }, or image[] for repeated files.
func tokenizeImageProviderBody(value any, files map[string]*imageProviderFile) any {
	switch value := value.(type) {
	case *imageProviderFile:
		token := imageOpaquePrefix + strings.ReplaceAll(newRequestID(), "-", "")
		files[token] = value
		return token
	case map[string]any:
		copy := map[string]any{}
		for key, item := range value {
			copy[key] = tokenizeImageProviderBody(item, files)
		}
		return copy
	case []any:
		copy := make([]any, len(value))
		for i, item := range value {
			copy[i] = tokenizeImageProviderBody(item, files)
		}
		return copy
	default:
		return value
	}
}

func validateImageProviderTree(value any, files map[string]*imageProviderFile, required bool) error {
	counts := map[string]int{}
	nodes := 0
	var visit func(any, int) error
	visit = func(value any, depth int) error {
		nodes++
		if nodes > 10000 || depth > 16 {
			return errors.New("image request exceeds the adapter JSON limit")
		}
		switch value := value.(type) {
		case string:
			if _, exists := files[value]; exists {
				counts[value]++
			} else if len(files) > 0 && strings.HasPrefix(value, imageOpaquePrefix) {
				return errors.New("image request script forged a media token")
			}
		case map[string]any:
			for key, item := range value {
				if key == "__proto__" || key == "constructor" || key == "prototype" || (len(files) > 0 && strings.HasPrefix(key, imageOpaquePrefix)) {
					return errors.New("image request contains a forbidden property")
				}
				if err := visit(item, depth+1); err != nil {
					return err
				}
			}
		case []any:
			for _, item := range value {
				if err := visit(item, depth+1); err != nil {
					return err
				}
			}
		}
		return nil
	}
	if err := visit(value, 0); err != nil {
		return err
	}
	if required {
		for token := range files {
			if counts[token] != 1 {
				return errors.New("image request script must preserve each media file exactly once")
			}
		}
	}
	raw, err := json.Marshal(value)
	if err != nil || len(raw) > 2<<20 {
		return errors.New("image request exceeds the adapter serialization limit")
	}
	return nil
}

func encodeImageProviderMultipart(body any, files map[string]*imageProviderFile) ([]byte, string, error) {
	fields, ok := body.(map[string]any)
	if !ok {
		return nil, "", errors.New("multipart image request body must be an object")
	}
	var encoded bytes.Buffer
	writer := multipart.NewWriter(&encoded)
	keys := make([]string, 0, len(fields))
	for key := range fields {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if strings.ContainsAny(key, "\r\n") {
			return nil, "", errors.New("invalid multipart field name")
		}
		values := []any{fields[key]}
		if list, ok := fields[key].([]any); ok {
			values = list
		}
		for _, value := range values {
			if value == nil {
				continue
			}
			if token, ok := value.(string); ok {
				if file, exists := files[token]; exists {
					name := strings.ReplaceAll(strings.ReplaceAll(file.Name, "\r", ""), "\n", "")
					header := textproto.MIMEHeader{"Content-Disposition": []string{mime.FormatMediaType("form-data", map[string]string{"name": key, "filename": name})}, "Content-Type": []string{file.MIME}}
					part, err := writer.CreatePart(header)
					if err != nil {
						return nil, "", err
					}
					if _, err = part.Write(file.Data); err != nil {
						return nil, "", err
					}
					continue
				}
			}
			// A token nested inside an object would otherwise become JSON text and
			// lose its file bytes. Only top-level fields/array elements can be files.
			if err := rejectNestedImageTokens(value, files); err != nil {
				return nil, "", err
			}
			text := fmt.Sprint(value)
			switch value.(type) {
			case map[string]any, []any:
				raw, err := json.Marshal(value)
				if err != nil {
					return nil, "", err
				}
				text = string(raw)
			}
			if err := writer.WriteField(key, text); err != nil {
				return nil, "", err
			}
		}
	}
	if err := writer.Close(); err != nil {
		return nil, "", err
	}
	return encoded.Bytes(), writer.FormDataContentType(), nil
}
func rejectNestedImageTokens(value any, files map[string]*imageProviderFile) error {
	switch value := value.(type) {
	case string:
		if _, exists := files[value]; exists {
			return errors.New("image request script nested a media file")
		}
	case map[string]any:
		for _, item := range value {
			if err := rejectNestedImageTokens(item, files); err != nil {
				return err
			}
		}
	case []any:
		for _, item := range value {
			if err := rejectNestedImageTokens(item, files); err != nil {
				return err
			}
		}
	}
	return nil
}

func imageProviderURL(cfg providerConfig, operation string) (*url.URL, error) {
	base, err := url.Parse(cfg.baseURL)
	if err != nil || base.Host == "" || base.User != nil || base.RawQuery != "" || base.Fragment != "" || (base.Scheme != "https" && base.Scheme != "http") {
		return nil, errors.New("invalid image provider base URL")
	}
	operationPath := "/images/generations"
	if operation == "images.edit" {
		operationPath = "/images/edits"
	}
	if op, ok := cfg.operations[operation].(map[string]any); ok {
		if configured := strings.TrimSpace(extractString(op, "path")); configured != "" {
			operationPath = configured
		}
	}
	decoded := operationPath
	for range 4 {
		next, err := url.PathUnescape(decoded)
		if err != nil {
			return nil, errors.New("invalid image operation path")
		}
		if next == decoded {
			break
		}
		decoded = next
	}
	if !strings.HasPrefix(operationPath, "/") || strings.HasPrefix(decoded, "//") || strings.ContainsAny(decoded, "\\?#\r\n\t") || strings.Contains(decoded, "{task_id}") {
		return nil, errors.New("image operation path must be relative to its configured provider")
	}
	for _, segment := range strings.Split(decoded, "/") {
		if segment == "." || segment == ".." {
			return nil, errors.New("image operation path escapes its configured provider")
		}
	}
	return url.Parse(strings.TrimRight(cfg.baseURL, "/") + operationPath)
}

var imageHeaderName = regexp.MustCompile("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")

func imageProviderAuthentication(cfg providerConfig) (string, string, error) {
	mode, header := cfg.auth, "Authorization"
	if auth, ok := cfg.adapter["authentication"].(map[string]any); ok {
		mode = extractString(auth, "mode")
		if mode == "custom_header" {
			header = extractString(auth, "headerName")
		}
	}
	if mode == "" {
		mode = "bearer"
	}
	if mode == "none" {
		return "", "", nil
	}
	if strings.TrimSpace(cfg.apiKey) == "" || strings.ContainsAny(cfg.apiKey, "\r\n") {
		return "", "", errors.New("image provider credentials are missing or invalid")
	}
	value := cfg.apiKey
	switch mode {
	case "bearer":
		value = "Bearer " + value
	case "raw_authorization":
	case "api-key":
		header = "x-api-key"
	case "custom_header":
		if !imageHeaderName.MatchString(header) {
			return "", "", errors.New("invalid image provider authentication header")
		}
	default:
		return "", "", errors.New("unsupported image provider authentication mode")
	}
	return header, value, nil
}

func mergeImageProviderEnvelope(target *url.URL, envelope map[string]any, authHeader string) (http.Header, error) {
	for key := range envelope {
		if key != "body" && key != "query" && key != "headers" {
			return nil, errors.New("image request script returned an unsupported envelope field")
		}
	}
	if value, exists := envelope["query"]; exists {
		query, ok := value.(map[string]any)
		if !ok {
			return nil, errors.New("image request query must be an object")
		}
		values := target.Query()
		count := 0
		for key, value := range query {
			if key == "" || len(key) > 256 {
				return nil, errors.New("invalid image request query key")
			}
			values.Del(key)
			if value == nil {
				continue
			}
			items := []any{value}
			if list, ok := value.([]any); ok {
				items = list
			}
			for _, item := range items {
				switch item.(type) {
				case string, float64, bool, int:
				default:
					return nil, errors.New("image request query value must be scalar")
				}
				count++
				values.Add(key, fmt.Sprint(item))
			}
		}
		if count > 64 || len(values.Encode()) > 16<<10 {
			return nil, errors.New("image request query exceeds the adapter limit")
		}
		target.RawQuery = values.Encode()
	}
	headers := http.Header{}
	if value, exists := envelope["headers"]; exists {
		items, ok := value.(map[string]any)
		if !ok || len(items) > 32 {
			return nil, errors.New("invalid image request headers")
		}
		blocked := map[string]bool{}
		for _, name := range strings.Fields("authorization connection content-length content-type cookie forwarded host keep-alive origin proxy-authenticate proxy-authorization referer te trailer transfer-encoding upgrade via x-forwarded-for x-forwarded-host x-forwarded-proto") {
			blocked[name] = true
		}
		seen := map[string]bool{}
		for name, value := range items {
			lower := strings.ToLower(name)
			text, ok := value.(string)
			if !ok || !imageHeaderName.MatchString(name) || blocked[lower] || strings.EqualFold(name, authHeader) || strings.HasPrefix(lower, "proxy-") || strings.HasPrefix(lower, "sec-") || strings.HasPrefix(lower, "x-fluxmedia-") || seen[lower] || strings.ContainsAny(text, "\r\n") || len(text) > 8192 {
				return nil, errors.New("image request script returned an invalid or protected header")
			}
			seen[lower] = true
			headers.Set(name, text)
		}
	}
	return headers, nil
}

func (b *backend) callImageProvider(ctx context.Context, cfg providerConfig, operation string, body map[string]any, taskID, model string) (map[string]any, error) {
	target, err := imageProviderURL(cfg, operation)
	if err != nil {
		return nil, err
	}
	authHeader, authValue, err := imageProviderAuthentication(cfg)
	if err != nil {
		return nil, err
	}
	files := map[string]*imageProviderFile{}
	payload := tokenizeImageProviderBody(body, files)
	contentType := "application/json"
	if operation == "images.edit" && len(files) > 0 {
		contentType = "multipart/form-data"
	}
	if err := validateImageProviderTree(payload, files, true); err != nil {
		return nil, err
	}
	envelope := map[string]any{}
	if op, ok := cfg.operations[operation].(map[string]any); ok {
		if script := strings.TrimSpace(extractString(op, "requestScript")); script != "" {
			client := newScriptRuntimeClient(b.config.scriptRuntimeURL, b.config.scriptRuntimeToken)
			if client == nil {
				return nil, errors.New("image provider script runtime is unavailable")
			}
			raw, err := client.execute(ctx, scriptRuntimeRequest{Script: script, Operation: operation, Stage: "request", Input: map[string]any{"query": map[string]any{}, "body": payload}, Context: map[string]any{"operation": operation, "stage": "request", "contentType": contentType, "platformModelId": model, "upstreamModelId": imageUpstreamModel(cfg, model), "taskId": taskID}})
			if err != nil {
				return nil, err
			}
			if json.Unmarshal(raw, &envelope) != nil || envelope == nil {
				return nil, errors.New("image provider script returned an invalid request envelope")
			}
		}
	}
	if value, exists := envelope["body"]; exists {
		payload = value
	}
	if err := validateImageProviderTree(payload, files, true); err != nil {
		return nil, err
	}
	// Tokens cannot be copied/moved to headers or query as well as the body.
	combined := map[string]any{"body": payload, "query": envelope["query"], "headers": envelope["headers"]}
	if err := validateImageProviderTree(combined, files, true); err != nil {
		return nil, err
	}
	headers, err := mergeImageProviderEnvelope(target, envelope, authHeader)
	if err != nil {
		return nil, err
	}
	var encoded []byte
	if contentType == "multipart/form-data" {
		encoded, contentType, err = encodeImageProviderMultipart(payload, files)
	} else {
		encoded, err = json.Marshal(payload)
	}
	if err != nil {
		return nil, err
	}
	ctx, releaseResponse, err := b.reserveProviderResponse(ctx, cfg, operation)
	if err != nil {
		return nil, err
	}
	defer releaseResponse()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target.String(), bytes.NewReader(encoded))
	if err != nil {
		return nil, err
	}
	req.Header = headers
	req.Header.Set("Content-Type", contentType)
	if req.Header.Get("Accept") == "" {
		req.Header.Set("Accept", "application/json")
	}
	if authHeader != "" {
		req.Header.Set(authHeader, authValue)
	}
	client := &http.Client{Timeout: 15 * time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	if beforeSend, ok := ctx.Value(imageBeforeSendContextKey{}).(func() error); ok {
		if err := beforeSend(); err != nil {
			return nil, err
		}
	}
	response, err := client.Do(req)
	if err != nil {
		return nil, &imageProviderTransportError{}
	}
	defer response.Body.Close()
	return b.decodeImageProviderResponse(ctx, cfg, operation, response, taskID, model)
}

func readImageProviderOutput(ctx context.Context, output map[string]any) ([]byte, string, error) {
	mimeType := ""
	var findBase64 func(any) string
	findBase64 = func(value any) string {
		switch value := value.(type) {
		case map[string]any:
			for _, key := range []string{"b64_json", "base64", "imageBase64"} {
				if text := extractString(value, key); text != "" {
					mimeType = extractString(value, "mediaType")
					return text
				}
			}
			for _, key := range []string{"data", "images", "outputs", "output", "result"} {
				if text := findBase64(value[key]); text != "" {
					return text
				}
			}
		case []any:
			for _, item := range value {
				if text := findBase64(item); text != "" {
					return text
				}
			}
		}
		return ""
	}
	encoded := findBase64(output)
	if encoded != "" {
		if strings.HasPrefix(encoded, "data:") {
			header, body, ok := strings.Cut(encoded, ",")
			if !ok || !strings.HasSuffix(header, ";base64") {
				return nil, "", errors.New("image provider returned an invalid data URL")
			}
			mimeType = strings.TrimSuffix(strings.TrimPrefix(header, "data:"), ";base64")
			encoded = body
		}
		data, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil || len(data) == 0 || len(data) > imageProviderMaxResponse {
			return nil, "", errors.New("image provider returned invalid base64 image data")
		}
		if mimeType == "" {
			mimeType = http.DetectContentType(data)
		}
		return data, mimeType, nil
	}
	imageURL := extractMediaURL(output)
	if imageURL == "" {
		return nil, "", errors.New("image provider response omitted image output")
	}
	if strings.HasPrefix(imageURL, "data:") {
		return readImageProviderOutput(ctx, map[string]any{"base64": imageURL})
	}
	return downloadMediaWithLimit(ctx, imageURL, imageProviderMaxResponse)
}
