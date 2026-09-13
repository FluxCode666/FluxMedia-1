package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// internalPrincipal is a short lived, signed identity assertion from the
// trusted Next UOL process. It exists only for API-key operations that cannot
// carry a browser session cookie through the server action boundary.
type internalPrincipal struct {
	Type           string `json:"type"`
	UserID         string `json:"userId"`
	Role           string `json:"role,omitempty"`
	CredentialKind string `json:"credentialKind,omitempty"`
	APIKeyID       string `json:"apiKeyId,omitempty"`
	IssuedAt       int64  `json:"issuedAt"`
}

func (b *backend) signedInternalPrincipal(r *http.Request) (*internalPrincipal, bool) {
	secret := strings.TrimSpace(b.config.internalPrincipalSecret)
	encoded := r.Header.Get("X-Flux-Principal")
	signature := r.Header.Get("X-Flux-Principal-Signature")
	if secret == "" || encoded == "" || signature == "" {
		return nil, false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(encoded))
	expected := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(expected), []byte(signature)) {
		return nil, false
	}
	payload, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return nil, false
	}
	var principal internalPrincipal
	if json.Unmarshal(payload, &principal) != nil || principal.UserID == "" || principal.IssuedAt == 0 {
		return nil, false
	}
	if delta := time.Now().Unix() - principal.IssuedAt; delta < -30 || delta > 90 {
		return nil, false
	}
	switch principal.Type {
	case "user":
		if principal.Role != "user" && principal.Role != "admin" && principal.Role != "super_admin" {
			return nil, false
		}
	case "apiKey":
		if (principal.CredentialKind != "external" && principal.CredentialKind != "mcp") || principal.APIKeyID == "" {
			return nil, false
		}
	default:
		return nil, false
	}
	return &principal, true
}

func (b *backend) requireAnalyticsPrincipal(r *http.Request) (userID string, role string, apiKey bool, err error) {
	if p, ok := b.signedInternalPrincipal(r); ok {
		return p.UserID, p.Role, p.Type == "apiKey", nil
	}
	s, err := b.requireSession(r)
	if err != nil {
		return "", "", false, err
	}
	return s.User.ID, s.User.Role, false, nil
}

func internalPrincipalHeaders(principal internalPrincipal, secret string) (string, string, bool) {
	if strings.TrimSpace(secret) == "" {
		return "", "", false
	}
	principal.IssuedAt = time.Now().Unix()
	payload, err := json.Marshal(principal)
	if err != nil {
		return "", "", false
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(encoded))
	return encoded, base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), true
}
