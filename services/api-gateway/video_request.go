package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

type nativeVideoInput struct {
	ClientRequestID   string           `json:"clientRequestId"`
	Prompt            string           `json:"prompt"`
	NegativePrompt    string           `json:"negativePrompt,omitempty"`
	Model             string           `json:"model"`
	Duration          int              `json:"duration"`
	AspectRatio       string           `json:"aspectRatio"`
	Resolution        string           `json:"resolution"`
	GenerateAudio     *bool            `json:"generateAudio,omitempty"`
	BackendGroupID    string           `json:"backendGroupId,omitempty"`
	QuoteToken        string           `json:"quoteToken,omitempty"`
	GeminiModel       string           `json:"geminiModel,omitempty"`
	GeminiOperationID string           `json:"geminiOperationId,omitempty"`
	CallbackURL       string           `json:"callbackUrl,omitempty"`
	FirstFrame        map[string]any   `json:"firstFrame,omitempty"`
	LastFrame         map[string]any   `json:"lastFrame,omitempty"`
	ReferenceImages   []map[string]any `json:"referenceImages,omitempty"`
	ReferenceVideos   []map[string]any `json:"referenceVideos,omitempty"`
	ReferenceAudios   []map[string]any `json:"referenceAudios,omitempty"`
}

var videoSafeLabel = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]*$`)
var videoOperationID = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)
var videoRatios = []string{"1:1", "4:3", "3:4", "16:9", "9:16", "21:9"}

// Normalize transport aliases before validation, rejecting conflicting values.
func parseNativeVideoInput(body map[string]json.RawMessage) (nativeVideoInput, error) {
	var input nativeVideoInput
	aliases := map[string]string{"client_request_id": "clientRequestId", "duration_seconds": "duration", "seconds": "duration", "aspect_ratio": "aspectRatio", "generate_audio": "generateAudio", "negative_prompt": "negativePrompt", "backend_group_id": "backendGroupId", "quote_token": "quoteToken", "first_frame": "firstFrame", "last_frame": "lastFrame", "reference_images": "referenceImages", "reference_videos": "referenceVideos", "reference_audios": "referenceAudios", "callback_url": "callbackUrl", "gemini_model": "geminiModel", "gemini_operation_id": "geminiOperationId"}
	normalized := map[string]json.RawMessage{}
	for key, value := range body {
		if key == "async" {
			var async bool
			if bytes.Equal(value, []byte("null")) || json.Unmarshal(value, &async) != nil {
				return input, invalid("async must be a boolean")
			}
			continue
		}
		if key == "seconds" {
			var seconds string
			if json.Unmarshal(value, &seconds) == nil {
				seconds = strings.TrimSpace(seconds)
				duration, err := strconv.Atoi(seconds)
				if err != nil || duration <= 0 || strconv.Itoa(duration) != seconds {
					return input, invalid("seconds must be a positive integer")
				}
				value = json.RawMessage(strconv.Itoa(duration))
			}
		}
		if alias := aliases[key]; alias != "" {
			key = alias
		}
		if old, exists := normalized[key]; exists {
			var a, b any
			if json.Unmarshal(old, &a) != nil || json.Unmarshal(value, &b) != nil || !reflect.DeepEqual(a, b) {
				return input, invalid("Conflicting video input aliases: " + key)
			}
		}
		normalized[key] = value
	}
	for _, key := range []string{"firstFrame", "lastFrame", "referenceImages", "referenceVideos", "referenceAudios"} {
		raw, exists := normalized[key]
		if !exists {
			continue
		}
		var value any
		if err := json.Unmarshal(raw, &value); err != nil {
			return input, invalid("Invalid video media input")
		}
		convert := func(value any) (map[string]any, error) {
			if object, ok := value.(map[string]any); ok {
				return object, nil
			}
			text, ok := value.(string)
			if !ok {
				return nil, invalid("Invalid video media reference")
			}
			text = strings.TrimSpace(text)
			if strings.HasPrefix(text, "data:") {
				header, encoded, ok := strings.Cut(strings.TrimPrefix(text, "data:"), ";base64,")
				if !ok || !strings.HasPrefix(header, "image/") {
					return nil, invalid("Invalid video image data URL")
				}
				data, err := base64.StdEncoding.Strict().DecodeString(encoded)
				if err != nil || len(data) == 0 {
					return nil, invalid("Invalid video image base64")
				}
				return map[string]any{"source": "data", "mimeType": header, "base64": encoded, "byteLength": len(data)}, nil
			}
			u, err := url.Parse(text)
			if err != nil || u.Host == "" || u.User != nil || (u.Scheme != "http" && u.Scheme != "https") {
				return nil, invalid("Invalid video reference URL")
			}
			mime := ""
			ext := strings.ToLower(u.Path)
			for suffix, kind := range map[string]string{".mp4": "video/mp4", ".mov": "video/quicktime", ".mp3": "audio/mpeg", ".wav": "audio/wav"} {
				if strings.HasSuffix(ext, suffix) {
					mime = kind
				}
			}
			if (key != "referenceVideos" && key != "referenceAudios") || mime == "" || (key == "referenceVideos" && !strings.HasPrefix(mime, "video/")) || (key == "referenceAudios" && !strings.HasPrefix(mime, "audio/")) {
				return nil, invalid("Video frame inputs must be image data URLs or media references")
			}
			return map[string]any{"source": "remote", "mimeType": mime, "url": text}, nil
		}
		if strings.HasPrefix(key, "reference") {
			items, ok := value.([]any)
			if !ok || len(items) == 0 {
				return input, invalid("Video references must be a nonempty array")
			}
			refs := make([]map[string]any, 0, len(items))
			for _, item := range items {
				ref, err := convert(item)
				if err != nil {
					return input, err
				}
				refs = append(refs, ref)
			}
			normalized[key] = json.RawMessage(mustJSON(refs))
		} else {
			ref, err := convert(value)
			if err != nil {
				return input, err
			}
			normalized[key] = json.RawMessage(mustJSON(ref))
		}
	}
	decoder := json.NewDecoder(bytes.NewReader([]byte(mustJSON(normalized))))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		return input, invalid("Invalid video request: " + err.Error())
	}
	input.ClientRequestID = strings.TrimSpace(input.ClientRequestID)
	input.Prompt = strings.TrimSpace(input.Prompt)
	input.Model = strings.TrimSpace(input.Model)
	input.Resolution = strings.TrimSpace(input.Resolution)
	input.AspectRatio = strings.TrimSpace(input.AspectRatio)
	if input.ClientRequestID == "" || len(input.ClientRequestID) > 128 || strings.IndexFunc(input.ClientRequestID, func(r rune) bool { return r < 32 || r == 127 }) >= 0 {
		return input, invalid("clientRequestId is required and must be at most 128 characters")
	}
	if input.Prompt == "" || utf8.RuneCountInString(input.Prompt) > 100000 || utf8.RuneCountInString(input.NegativePrompt) > 100000 || input.Duration <= 0 || input.Duration > 86400 {
		return input, invalid("Invalid video prompt or duration")
	}
	if len(input.Model) > 120 || !videoSafeLabel.MatchString(input.Model) || strings.ToLower(input.Model) != input.Model || input.Model == "auto" || input.Model == "unknown" || strings.HasPrefix(input.Model, "firefly-") {
		return input, invalid("Video model must use an exact configured ID")
	}
	if len(input.Resolution) > 32 || !videoSafeLabel.MatchString(input.Resolution) || !containsString(videoRatios, input.AspectRatio) {
		return input, invalid("Invalid video resolution or aspect ratio")
	}
	if len(input.QuoteToken) > 2048 || len(input.BackendGroupID) > 128 {
		return input, invalid("Invalid video quote or group")
	}
	if input.GeminiModel != "" && (!videoSafeLabel.MatchString(input.GeminiModel) || len(input.GeminiModel) > 120) {
		return input, invalid("Invalid Gemini model")
	}
	if input.GeminiOperationID != "" && !videoOperationID.MatchString(input.GeminiOperationID) {
		return input, invalid("Invalid Gemini operation ID")
	}
	if input.CallbackURL != "" {
		u, err := url.Parse(input.CallbackURL)
		if err != nil || u.Host == "" || u.User != nil || (u.Scheme != "http" && u.Scheme != "https") || len(input.CallbackURL) > 2048 {
			return input, invalid("Invalid video callback URL")
		}
	}
	if input.LastFrame != nil && input.FirstFrame == nil {
		return input, invalid("lastFrame requires firstFrame")
	}
	refs := len(input.ReferenceImages) + len(input.ReferenceVideos) + len(input.ReferenceAudios)
	if refs > 256 || len(input.ReferenceVideos) > 3 || len(input.ReferenceAudios) > 1 {
		return input, invalid("Too many video media references")
	}
	if input.FirstFrame != nil && refs > 0 {
		return input, invalid("Frame inputs and reference media are mutually exclusive")
	}
	if input.GenerateAudio == nil {
		audio := input.GeminiModel != "" || goVideoCapabilities[input.Model].AudioDefault
		input.GenerateAudio = &audio
	}
	return input, nil
}

func (input nativeVideoInput) manifest() map[string]any {
	result := map[string]any{}
	if input.FirstFrame != nil {
		result["firstFrame"] = input.FirstFrame
	}
	if input.LastFrame != nil {
		result["lastFrame"] = input.LastFrame
	}
	if len(input.ReferenceImages) > 0 {
		result["referenceImages"] = input.ReferenceImages
	}
	if len(input.ReferenceVideos) > 0 {
		result["referenceVideos"] = input.ReferenceVideos
	}
	if len(input.ReferenceAudios) > 0 {
		result["referenceAudios"] = input.ReferenceAudios
	}
	return result
}

func (input nativeVideoInput) fingerprint() string {
	input.QuoteToken = ""
	digest := sha256.Sum256([]byte(mustJSON(input)))
	return hex.EncodeToString(digest[:])
}

func nativeVideoTaskID(scope, clientID string) string {
	digest := sha256.Sum256([]byte(fmt.Sprintf("%d:%s:%d:%s", len(scope), scope, len(clientID), clientID)))
	return "video_" + hex.EncodeToString(digest[:])[:40]
}

func validateNativeVideoCapability(input nativeVideoInput, cfg goVideoModelConfig) error {
	capability := cfg.Capability
	if !cfg.Custom {
		found := false
		for _, duration := range capability.Durations {
			if input.Duration == duration {
				found = true
			}
		}
		if !found {
			return invalid("Video model does not support requested duration")
		}
	}
	if !containsString(capability.Ratios, input.AspectRatio) || !containsString(cfg.SupportedResolutions, input.Resolution) {
		return invalid("Video model does not support requested output format")
	}
	if input.FirstFrame != nil && capability.Frames == "none" {
		return invalid("Video model does not support frame inputs")
	}
	if input.LastFrame != nil && capability.Frames != "first-and-optional-last" {
		return invalid("Video model does not support lastFrame")
	}
	max := capability.RefMax
	if input.GeminiModel != "" && max == 0 {
		max = 3
	}
	if len(input.ReferenceImages) > max {
		return invalid("Too many reference images for this video model")
	}
	if input.GenerateAudio != nil && *input.GenerateAudio && !capability.Audio && input.GeminiModel == "" {
		return invalid("Video model does not support audio generation")
	}
	if input.GeminiModel != "" && input.GenerateAudio != nil && !*input.GenerateAudio {
		return invalid("Gemini Veo cannot disable generated audio")
	}
	return nil
}

func nativeVideoOutputSize(input nativeVideoInput, cfg goVideoModelConfig) (int, int, error) {
	short := map[string]int{"480p": 480, "720p": 720, "1080p": 1080, "2k": 1440, "4k": 2160, "8k": 4320}[input.Resolution]
	if short > 0 {
		ratios := map[string][2]int{"1:1": {1, 1}, "4:3": {4, 3}, "3:4": {3, 4}, "16:9": {16, 9}, "9:16": {9, 16}, "21:9": {21, 9}}
		r := ratios[input.AspectRatio]
		w, h := short, short
		if r[0] > r[1] {
			w = int(math.Ceil(float64(short*r[0])/float64(r[1])/2) * 2)
		} else if r[1] > r[0] {
			h = int(math.Ceil(float64(short*r[1])/float64(r[0])/2) * 2)
		}
		return w, h, nil
	}
	pixels := goMapObject(cfg.OutputSizes, input.Resolution)[input.AspectRatio]
	value, _ := pixels.(map[string]any)
	w, h := goInt64(value["width"]), goInt64(value["height"])
	if w <= 0 || h <= 0 || w > 100000 || h > 100000 {
		return 0, 0, invalid("Custom video output pixel dimensions are not configured")
	}
	return int(w), int(h), nil
}
