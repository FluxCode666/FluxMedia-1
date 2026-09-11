//go:build integration

package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

type oauthTransport func(*http.Request) (*http.Response, error)

func (f oauthTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestOAuthUsesVerifiedProviderIdentityAndConsumesState(t *testing.T) {
	b := integrationBackend(t)
	id, email := seedAuthUser(t, b)
	t.Setenv("GOOGLE_CLIENT_ID", "test-client")
	t.Setenv("GOOGLE_CLIENT_SECRET", "test-secret")
	calls := 0
	b.oauthHTTPClient = &http.Client{Transport: oauthTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		var payload string
		switch r.URL.String() {
		case "https://oauth2.googleapis.com/token":
			if err := r.ParseForm(); err != nil {
				t.Fatal(err)
			}
			if r.Form.Get("code_verifier") == "" || r.Form.Get("code") != "test-code" {
				t.Fatal("OAuth exchange missing code or PKCE")
			}
			payload = `{"access_token":"test-access-token","token_type":"Bearer","expires_in":3600}`
		case "https://openidconnect.googleapis.com/v1/userinfo":
			if r.Header.Get("Authorization") != "Bearer test-access-token" {
				t.Fatal("profile request did not use exchanged access token")
			}
			raw, _ := json.Marshal(map[string]any{"sub": "test-provider-" + id, "email": email, "name": "Provider user", "email_verified": true})
			payload = string(raw)
		default:
			t.Fatalf("unexpected OAuth request: %s", r.URL.String())
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(payload))}, nil
	})}
	w := authRequest(t, b, "POST", "/api/auth/sign-in/social", `{"provider":"google","callbackURL":"/dashboard"}`)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var result struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	redirect, err := url.Parse(result.URL)
	if err != nil {
		t.Fatal(err)
	}
	state := redirect.Query().Get("state")
	if state == "" || redirect.Query().Get("code_challenge") == "" {
		t.Fatal("OAuth request lacks state or PKCE")
	}
	cookie := w.Result().Cookies()[0]
	callback := "/api/auth/callback/google?state=" + url.QueryEscape(state) + "&code=test-code"
	w = authRequest(t, b, "GET", callback, "")
	if w.Code != 400 || calls != 0 {
		t.Fatal("OAuth callback accepted without browser state")
	}
	w = authRequest(t, b, "GET", callback, "", cookie)
	if w.Code != 302 || w.Header().Get("Location") != "http://localhost:3000/dashboard" {
		t.Fatalf("OAuth callback failed: %d %s", w.Code, w.Body.String())
	}
	var sessionCookie *http.Cookie
	for _, c := range w.Result().Cookies() {
		if c.Name == "better-auth.session_token" {
			sessionCookie = c
		}
	}
	if sessionCookie == nil {
		t.Fatal("OAuth did not establish session")
	}
	w = authRequest(t, b, "GET", "/api/session/current", "", sessionCookie)
	if w.Code != 200 || !strings.Contains(w.Body.String(), id) {
		t.Fatal("OAuth session has wrong account")
	}
	w = authRequest(t, b, "GET", callback, "", cookie)
	if w.Code != 400 || calls != 2 {
		t.Fatal("OAuth state replay accepted")
	}
}
