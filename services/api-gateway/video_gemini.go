package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

type geminiInlineVideoImage struct {
	InlineData *struct {
		MIME string `json:"mimeType"`
		Data string `json:"data"`
	} `json:"inlineData"`
}

type geminiNativeVideoRequest struct {
	Instances []struct {
		Prompt          string                  `json:"prompt"`
		Image           *geminiInlineVideoImage `json:"image,omitempty"`
		LastFrame       *geminiInlineVideoImage `json:"lastFrame,omitempty"`
		ReferenceImages []struct {
			Image         *geminiInlineVideoImage `json:"image"`
			ReferenceType string                  `json:"referenceType"`
		} `json:"referenceImages,omitempty"`
		ReferenceVideos []string `json:"reference_videos,omitempty"`
		ReferenceAudios []string `json:"reference_audios,omitempty"`
	} `json:"instances"`
	Parameters *struct {
		Duration    json.RawMessage `json:"durationSeconds,omitempty"`
		AspectRatio *string         `json:"aspectRatio,omitempty"`
		Resolution  *string         `json:"resolution,omitempty"`
	} `json:"parameters,omitempty"`
}

func parseGeminiNativeVideoRequest(r *http.Request, scope string, body map[string]json.RawMessage) (map[string]json.RawMessage, error) {
	model := strings.TrimSuffix(r.PathValue("model"), ":predictLongRunning")
	if !videoSafeLabel.MatchString(model) || len(model) > 120 {
		return nil, invalid("Invalid Gemini model name")
	}
	var supplied any
	if json.Unmarshal([]byte(mustJSON(body)), &supplied) != nil || geminiContainsNull(supplied) {
		return nil, invalid("Gemini request fields cannot be null")
	}
	var request geminiNativeVideoRequest
	decoder := json.NewDecoder(bytes.NewBufferString(mustJSON(body)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		return nil, invalid("Invalid Gemini request: " + err.Error())
	}
	if len(request.Instances) != 1 || strings.TrimSpace(request.Instances[0].Prompt) == "" {
		return nil, invalid("instances must contain exactly one item with a prompt")
	}
	instance := request.Instances[0]
	if len(instance.ReferenceImages) > 3 || len(instance.ReferenceVideos) > 3 || len(instance.ReferenceAudios) > 1 {
		return nil, invalid("Too many Gemini media references")
	}
	if (instance.ReferenceVideos != nil && len(instance.ReferenceVideos) == 0) || (instance.ReferenceAudios != nil && len(instance.ReferenceAudios) == 0) {
		return nil, invalid("Gemini media reference arrays cannot be empty")
	}
	idempotencyKey := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	requestID := strings.TrimSpace(r.Header.Get("X-Request-ID"))
	if idempotencyKey != "" && requestID != "" && idempotencyKey != requestID {
		return nil, invalid("Idempotency-Key and x-request-id must match")
	}
	if idempotencyKey == "" {
		idempotencyKey = requestID
	}
	if idempotencyKey == "" {
		idempotencyKey = newRequestID()
	}
	platformModel := map[string]string{"seedance2.0": "seedance2", "veo-3.1-generate-preview": "veo31", "veo-3.1-fast-generate-preview": "veo31-fast"}[model]
	if platformModel == "" {
		platformModel = model
	}
	// Stable transport identity makes HTTP retries replay the original operation.
	digest := sha256.Sum256([]byte("gemini-operation:" + nativeVideoTaskID(scope, idempotencyKey)))
	input := map[string]any{"clientRequestId": idempotencyKey, "model": platformModel, "geminiModel": model, "geminiOperationId": hex.EncodeToString(digest[:])[:24], "prompt": instance.Prompt, "duration": 8, "aspectRatio": "16:9", "resolution": "720p"}
	if parameters := request.Parameters; parameters != nil {
		if len(parameters.Duration) > 0 {
			var value any
			if json.Unmarshal(parameters.Duration, &value) != nil {
				return nil, invalid("Invalid Gemini durationSeconds")
			}
			duration := int(goInt64(value))
			if s, ok := value.(string); ok {
				duration = map[string]int{"4": 4, "6": 6, "8": 8}[s]
			}
			if duration != 4 && duration != 6 && duration != 8 {
				return nil, invalid("Gemini durationSeconds must be 4, 6 or 8")
			}
			input["duration"] = duration
		}
		if parameters.AspectRatio != nil {
			input["aspectRatio"] = *parameters.AspectRatio
		}
		if parameters.Resolution != nil {
			input["resolution"] = *parameters.Resolution
		}
	}
	image := func(value *geminiInlineVideoImage) (map[string]any, error) {
		if value == nil || value.InlineData == nil {
			return nil, invalid("Gemini image requires inlineData")
		}
		data := value.InlineData
		mime := strings.TrimSpace(data.MIME)
		if !strings.HasPrefix(mime, "image/") || len(mime) > 128 || len(data.Data) > 16777216 {
			return nil, invalid("Invalid Gemini inline image")
		}
		decoded, err := base64.StdEncoding.Strict().DecodeString(data.Data)
		if err != nil || len(decoded) == 0 {
			return nil, invalid("Gemini inlineData.data must be valid base64")
		}
		return map[string]any{"source": "data", "mimeType": mime, "base64": data.Data, "byteLength": len(decoded)}, nil
	}
	for slot, value := range map[string]*geminiInlineVideoImage{"firstFrame": instance.Image, "lastFrame": instance.LastFrame} {
		if value != nil {
			ref, err := image(value)
			if err != nil {
				return nil, err
			}
			input[slot] = ref
		}
	}
	if len(instance.ReferenceImages) > 0 {
		refs := []map[string]any{}
		for _, value := range instance.ReferenceImages {
			if value.ReferenceType != "asset" && value.ReferenceType != "style" {
				return nil, invalid("Invalid Gemini referenceType")
			}
			ref, err := image(value.Image)
			if err != nil {
				return nil, err
			}
			refs = append(refs, ref)
		}
		input["referenceImages"] = refs
	}
	if len(instance.ReferenceVideos) > 0 {
		input["referenceVideos"] = instance.ReferenceVideos
	}
	if len(instance.ReferenceAudios) > 0 {
		input["referenceAudios"] = instance.ReferenceAudios
	}
	var normalized map[string]json.RawMessage
	if err := json.Unmarshal([]byte(mustJSON(input)), &normalized); err != nil {
		return nil, err
	}
	if _, err := parseNativeVideoInput(normalized); err != nil {
		return nil, err
	}
	return normalized, nil
}

func geminiContainsNull(value any) bool {
	if value == nil {
		return true
	}
	switch object := value.(type) {
	case map[string]any:
		for _, child := range object {
			if geminiContainsNull(child) {
				return true
			}
		}
	case []any:
		for _, child := range object {
			if geminiContainsNull(child) {
				return true
			}
		}
	}
	return false
}

func (b *backend) geminiEndpoint(fn endpoint) http.HandlerFunc {
	return b.externalEndpoint(func(w http.ResponseWriter, r *http.Request) error {
		if err := fn(w, r); err != nil {
			var known *apiError
			if !errors.As(err, &known) {
				b.logger.ErrorContext(r.Context(), "Gemini operation failed", "request_id", requestID(r))
				known = &apiError{500, "INTERNAL", "Video operation failed"}
			}
			code, status := 13, "INTERNAL"
			switch known.status {
			case 400:
				code, status = 3, "INVALID_ARGUMENT"
			case 401:
				code, status = 16, "UNAUTHENTICATED"
			case 403:
				code, status = 7, "PERMISSION_DENIED"
			case 404:
				code, status = 5, "NOT_FOUND"
			case 409:
				code, status = 10, "ABORTED"
			case 429:
				code, status = 8, "RESOURCE_EXHAUSTED"
			}
			message := known.message
			if utf8.RuneCountInString(message) > 512 {
				message = string([]rune(message)[:512])
			}
			noStore(w)
			writeJSON(w, known.status, map[string]any{"error": map[string]any{"code": code, "message": message, "status": status}})
		}
		return nil
	})
}

func geminiNativeOperation(model, operationID string, task map[string]any) map[string]any {
	result := map[string]any{"name": "models/" + model + "/operations/" + operationID, "done": false}
	if task["status"] != "failed" && task["status"] != "completed" {
		return result
	}
	result["done"] = true
	if task["status"] == "completed" {
		if uri, ok := task["videoUrl"].(string); ok && uri != "" {
			result["response"] = map[string]any{"generateVideoResponse": map[string]any{"generatedSamples": []any{map[string]any{"video": map[string]any{"uri": uri}}}}}
			return result
		}
	}
	message, _ := task["error"].(string)
	message = strings.TrimSpace(message)
	if message == "" {
		message = "Video generation failed"
	}
	if utf8.RuneCountInString(message) > 512 {
		message = string([]rune(message)[:512])
	}
	result["error"] = map[string]any{"code": 13, "message": message, "status": "INTERNAL"}
	return result
}

func (b *backend) readNativeGeminiOperation(r *http.Request, userID, keyID, scope, model, operationID string) (map[string]any, error) {
	if !videoSafeLabel.MatchString(model) || len(model) > 120 || !videoOperationID.MatchString(operationID) {
		return nil, &apiError{404, "NOT_FOUND", "Operation not found"}
	}
	var id string
	err := b.db.QueryRow(r.Context(), `SELECT id FROM video_generation WHERE public_operation_id=$1 AND user_id=$2 AND principal_scope=$3 AND api_key_id IS NOT DISTINCT FROM NULLIF($4,'') AND metadata->>'geminiModel'=$5`, operationID, userID, scope, keyID, model).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, &apiError{404, "NOT_FOUND", "Operation not found"}
	}
	if err != nil {
		return nil, err
	}
	task, err := b.readNativeVideoStatus(r, id, userID, keyID, scope)
	if err != nil {
		return nil, err
	}
	return geminiNativeOperation(model, operationID, task), nil
}
