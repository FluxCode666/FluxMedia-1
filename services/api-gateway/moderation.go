package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"net/http"
	"strings"
)

func (b *backend) handleModerate(w http.ResponseWriter, r *http.Request) error {
	proxy, err := b.settingString(r.Context(), "CONTENT_MODERATION_PROXY_SECRET", "")
	if err != nil {
		return err
	}
	gateway, err := b.settingString(r.Context(), "CONTENT_MODERATION_PROXY_GATEWAY_SECRET", "")
	if err != nil {
		return err
	}
	if !moderationProxyAuthorized(r, proxy, gateway) {
		return &apiError{http.StatusUnauthorized, "UNAUTHORIZED", "Unauthorized"}
	}
	in, err := decodeModerationRequest(r, false)
	if err != nil {
		return err
	}
	// An inbound proxy request always executes local providers. It cannot recurse
	// through the configured outbound moderation proxy, including a self URL.
	in.SkipProxy = true
	result, err := b.moderateContent(r.Context(), in)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, result)
	return nil
}
func moderationProxyAuthorized(r *http.Request, secrets ...string) bool {
	candidates := []string{r.Header.Get("X-Moderation-Proxy-Secret")}
	parts := strings.Fields(r.Header.Get("Authorization"))
	if len(parts) == 2 && strings.EqualFold(parts[0], "Bearer") {
		candidates = append(candidates, parts[1])
	}
	for _, candidate := range candidates {
		if candidate == "" {
			continue
		}
		for _, secret := range secrets {
			if secret == "" {
				continue
			}
			left := sha256.Sum256([]byte(candidate))
			right := sha256.Sum256([]byte(secret))
			if subtle.ConstantTimeCompare(left[:], right[:]) == 1 {
				return true
			}
		}
	}
	return false
}
