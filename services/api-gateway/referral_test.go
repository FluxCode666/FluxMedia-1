package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHandleReferralMatchesNextContract(t *testing.T) {
	b := &backend{config: config{
		authURL:      "https://media.example",
		publicAppURL: "https://configured.example",
		production:   true,
	}}
	r := httptest.NewRequest(http.MethodGet, "https://incoming.example/r/abc123", nil)
	r.SetPathValue("code", " abc123 ")
	r.AddCookie(&http.Cookie{Name: "NEXT_LOCALE", Value: "zh"})
	r.Header.Set("Accept-Language", "en-US,en;q=0.9")
	w := httptest.NewRecorder()

	if err := b.handleReferral(w, r); err != nil {
		t.Fatal(err)
	}
	if w.Code != http.StatusSeeOther {
		t.Fatalf("status=%d, want %d", w.Code, http.StatusSeeOther)
	}
	if got, want := w.Header().Get("Location"), "https://media.example/zh/sign-up"; got != want {
		t.Fatalf("location=%q, want %q", got, want)
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != "fluxmedia_referral_code" || cookies[0].Value != "ABC123" {
		t.Fatalf("cookies=%v, want one uppercase referral cookie", cookies)
	}
	if !cookies[0].Secure || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteLaxMode {
		t.Fatalf("cookie attributes=%+v, want secure httponly lax", cookies[0])
	}
}

func TestHandleReferralInvalidCodeDoesNotSetCookie(t *testing.T) {
	b := &backend{config: config{authURL: "http://localhost:3000"}}
	for _, rawCode := range []string{"short", "ABC_123", "ABC-123", strings.Repeat("A", 33)} {
		r := httptest.NewRequest(http.MethodGet, "http://internal:8080/r/"+rawCode, nil)
		r.SetPathValue("code", rawCode)
		r.Header.Set("X-Forwarded-Proto", "https")
		r.Header.Set("X-Forwarded-Host", "promo.example")
		w := httptest.NewRecorder()

		if err := b.handleReferral(w, r); err != nil {
			t.Fatal(err)
		}
		if got, want := w.Header().Get("Location"), "https://promo.example/zh/sign-up"; got != want {
			t.Errorf("code %q location=%q, want %q", rawCode, got, want)
		}
		if cookies := w.Result().Cookies(); len(cookies) != 0 {
			t.Errorf("code %q wrote cookies=%v, want none", rawCode, cookies)
		}
	}
}

func TestHandleReferralLocaleAndPublicOriginFallback(t *testing.T) {
	b := &backend{config: config{
		authURL:      "http://localhost:3000",
		publicAppURL: "https://public.example",
	}}
	r := httptest.NewRequest(http.MethodGet, "http://internal:8080/r/ABC123", nil)
	r.SetPathValue("code", "ABC123")
	r.AddCookie(&http.Cookie{Name: "NEXT_LOCALE", Value: "zh"})
	r.Header.Set("Accept-Language", "en-US")
	w := httptest.NewRecorder()

	if err := b.handleReferral(w, r); err != nil {
		t.Fatal(err)
	}
	if got, want := w.Header().Get("Location"), "https://public.example/zh/sign-up"; got != want {
		t.Fatalf("location=%q, want %q", got, want)
	}

	// Unsupported locale cookies are ignored, allowing the language header to
	// select English just as the Next implementation does.
	r = httptest.NewRequest(http.MethodGet, "http://internal:8080/r/ABC123", nil)
	r.SetPathValue("code", "ABC123")
	r.AddCookie(&http.Cookie{Name: "NEXT_LOCALE", Value: "fr"})
	r.Header.Set("Accept-Language", "en-US")
	w = httptest.NewRecorder()
	if err := b.handleReferral(w, r); err != nil {
		t.Fatal(err)
	}
	if got, want := w.Header().Get("Location"), "https://public.example/en/sign-up"; got != want {
		t.Fatalf("unsupported cookie location=%q, want %q", got, want)
	}
}
