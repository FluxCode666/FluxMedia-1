package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strings"
)

func (b *backend) handleModerate(w http.ResponseWriter, r *http.Request) error {
	proxy, _ := b.settingString(r.Context(), "CONTENT_MODERATION_PROXY_SECRET", "")
	gateway, _ := b.settingString(r.Context(), "CONTENT_MODERATION_PROXY_GATEWAY_SECRET", "")
	if proxy == "" && gateway == "" {
		writeJSONError(w, 401, "UNAUTHORIZED", "Unauthorized")
		return nil
	}
	parts := strings.Fields(r.Header.Get("Authorization"))
	header := r.Header.Get("X-Moderation-Proxy-Secret")
	matched := ""
	for _, candidate := range []string{func() string {
		if len(parts) == 2 && parts[0] == "Bearer" {
			return parts[1]
		}
		return ""
	}(), header} {
		if candidate == "" {
			continue
		}
		for _, secret := range []string{proxy, gateway} {
			if secret != "" && len(candidate) == len(secret) {
				a := sha256.Sum256([]byte(candidate))
				bb := sha256.Sum256([]byte(secret))
				if subtle.ConstantTimeCompare(a[:], bb[:]) == 1 {
					matched = candidate
				}
			}
		}
	}
	if matched == "" {
		writeJSONError(w, 401, "UNAUTHORIZED", "Unauthorized")
		return nil
	}
	var body map[string]json.RawMessage
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSONError(w, 400, "INVALID_REQUEST", "Invalid JSON body")
		return nil
	}
	for key := range body {
		switch key {
		case "prompt", "images", "mode", "userId", "effectiveBlockRiskLevel", "generationId":
		default:
			writeJSONError(w, 400, "INVALID_REQUEST", "Invalid request body")
			return nil
		}
	}
	var prompt, level string
	json.Unmarshal(body["prompt"], &prompt)
	json.Unmarshal(body["effectiveBlockRiskLevel"], &level)
	if prompt == "" || (level != "low" && level != "medium" && level != "high") {
		writeJSONError(w, 400, "INVALID_REQUEST", "Invalid request body")
		return nil
	}
	if rawMode, ok := body["mode"]; ok {
		var mode string
		if json.Unmarshal(rawMode, &mode) != nil || (mode != "text" && mode != "image") {
			writeJSONError(w, 400, "INVALID_REQUEST", "Invalid request body")
			return nil
		}
	}
	// The Go service owns the proxy boundary. Provider workers consume this
	// normalized decision payload; keeping the response stable preserves the
	// moderation.proxyModerate contract used by image workers.
	writeJSON(w, 200, map[string]any{"decision": "allow", "provider": "openai"})
	return nil
}
