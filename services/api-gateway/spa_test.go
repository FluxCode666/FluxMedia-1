package main

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

const testIndexHTML = `<!doctype html>
<html lang="en">
  <head>
    <title>FluxMedia</title>
    <!--app-config-->
    <meta name="description" content="site" data-route-meta />
    <!--route-meta-->
    <script type="module" crossorigin src="/static/index-abc.js"></script>
  </head>
  <body><div id="root"></div></body>
</html>
`

func testWebApp(t *testing.T) *webApp {
	t.Helper()
	files := fstest.MapFS{
		"index.html":           {Data: []byte(testIndexHTML)},
		"static/index-abc.js":  {Data: []byte("console.log(1)")},
		"favicon.ico":          {Data: []byte("ico")},
		"cinema/wall/w01.webp": {Data: []byte("webp")},
	}
	app, err := newWebApp(files, "https://media.example/", func(context.Context) string { return "Asia/Shanghai</script>" })
	if err != nil {
		t.Fatal(err)
	}
	return app
}

func serveWeb(app http.Handler, method, target string, prepare func(*http.Request)) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "https://media.example"+target, nil)
	if prepare != nil {
		prepare(r)
	}
	w := httptest.NewRecorder()
	app.ServeHTTP(w, r)
	return w
}

func withSession(r *http.Request) {
	r.AddCookie(&http.Cookie{Name: "__Secure-better-auth.session_token", Value: "token"})
}

func TestWebAppRedirectsUnprefixedPagesToNegotiatedLocale(t *testing.T) {
	app := testWebApp(t)
	cases := []struct {
		target   string
		prepare  func(*http.Request)
		location string
	}{
		{"/", nil, "/en"},
		{"/", func(r *http.Request) { r.Header.Set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8") }, "/zh"},
		{"/", func(r *http.Request) { r.Header.Set("Accept-Language", "fr-FR,en;q=0.5,zh;q=0.8") }, "/zh"},
		{"/", func(r *http.Request) {
			r.Header.Set("Accept-Language", "zh-CN")
			r.AddCookie(&http.Cookie{Name: "NEXT_LOCALE", Value: "en"})
		}, "/en"},
		{"/", func(r *http.Request) {
			r.Header.Set("Accept-Language", "zh-TW")
			r.AddCookie(&http.Cookie{Name: "NEXT_LOCALE", Value: "fr"})
		}, "/zh"},
		{"/models?provider=flux", nil, "/en/models?provider=flux"},
	}
	for _, tc := range cases {
		w := serveWeb(app, http.MethodGet, tc.target, tc.prepare)
		if w.Code != http.StatusTemporaryRedirect || w.Header().Get("Location") != tc.location {
			t.Fatalf("%s: status=%d location=%q, want 307 %q", tc.target, w.Code, w.Header().Get("Location"), tc.location)
		}
	}
}

func TestWebAppGatesDashboardWithoutSessionCookie(t *testing.T) {
	app := testWebApp(t)
	w := serveWeb(app, http.MethodGet, "/zh/dashboard/history?tab=video", nil)
	if w.Code != http.StatusTemporaryRedirect {
		t.Fatalf("status=%d, want 307", w.Code)
	}
	if got, want := w.Header().Get("Location"), "/zh/sign-in?callbackUrl=%2Fzh%2Fdashboard%2Fhistory%3Ftab%3Dvideo"; got != want {
		t.Fatalf("location=%q, want %q", got, want)
	}
	if !strings.Contains(w.Header().Get("Cache-Control"), "no-store") {
		t.Fatalf("dashboard redirect must not be cached: %q", w.Header().Get("Cache-Control"))
	}

	unprefixed := serveWeb(app, http.MethodGet, "/dashboard", nil)
	if got, want := unprefixed.Header().Get("Location"), "/en/sign-in?callbackUrl=%2Fdashboard"; got != want {
		t.Fatalf("unprefixed location=%q, want %q", got, want)
	}

	signedIn := serveWeb(app, http.MethodGet, "/dashboard", withSession)
	if got := signedIn.Header().Get("Location"); got != "/en/dashboard" {
		t.Fatalf("signed-in unprefixed location=%q", got)
	}
}

func TestWebAppRendersLocalizedShell(t *testing.T) {
	app := testWebApp(t)
	w := serveWeb(app, http.MethodGet, "/zh/blog/hello?utm=1", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d", w.Code)
	}
	body := w.Body.String()
	for _, want := range []string{
		`<html lang="zh">`,
		`<script>window.__FLUXMEDIA_CONFIG__={"appTimeZone":"Asia/Shanghai\u003c/script\u003e"}</script>`,
		`<link rel="canonical" href="https://media.example/zh/blog/hello" data-route-meta />`,
		`<link rel="alternate" href="https://media.example/en/blog/hello" hreflang="en" data-route-meta />`,
		`<link rel="alternate" href="https://media.example/en/blog/hello" hreflang="x-default" data-route-meta />`,
		`<meta property="og:locale" content="zh_CN" data-route-meta />`,
		`<meta property="og:image" content="https://media.example/og-image.png" data-route-meta />`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("shell missing %s\n%s", want, body)
		}
	}
	if strings.Contains(body, "<!--app-config-->") || strings.Contains(body, "<!--route-meta-->") || strings.Contains(body, "robots") {
		t.Fatalf("public shell kept placeholders or robots tag:\n%s", body)
	}
	if got := w.Header().Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("cache-control=%q", got)
	}
	if got := w.Header().Get("Set-Cookie"); !strings.HasPrefix(got, "NEXT_LOCALE=zh;") {
		t.Fatalf("locale cookie=%q", got)
	}

	home := serveWeb(app, http.MethodGet, "/en", func(r *http.Request) {
		r.AddCookie(&http.Cookie{Name: "NEXT_LOCALE", Value: "en"})
	})
	if !strings.Contains(home.Body.String(), `<link rel="canonical" href="https://media.example/en" data-route-meta />`) {
		t.Fatalf("home canonical missing:\n%s", home.Body.String())
	}
	if home.Header().Get("Set-Cookie") != "" {
		t.Fatal("matching locale cookie must not be rewritten")
	}
}

func TestWebAppMarksPrivatePagesNoStoreAndNoIndex(t *testing.T) {
	app := testWebApp(t)
	for _, target := range []string{"/en/sign-in", "/zh/sign-up", "/en/dashboard/admin"} {
		w := serveWeb(app, http.MethodGet, target, withSession)
		if w.Code != http.StatusOK {
			t.Fatalf("%s: status=%d", target, w.Code)
		}
		if !strings.Contains(w.Header().Get("Cache-Control"), "no-store") {
			t.Fatalf("%s: cache-control=%q", target, w.Header().Get("Cache-Control"))
		}
		if !strings.Contains(w.Body.String(), `<meta name="robots" content="noindex, nofollow" data-route-meta />`) {
			t.Fatalf("%s: robots tag missing", target)
		}
	}
}

func TestWebAppServesBuildFiles(t *testing.T) {
	app := testWebApp(t)
	asset := serveWeb(app, http.MethodGet, "/static/index-abc.js", nil)
	if asset.Code != http.StatusOK || asset.Body.String() != "console.log(1)" {
		t.Fatalf("asset: %d %q", asset.Code, asset.Body.String())
	}
	if got := asset.Header().Get("Cache-Control"); got != immutableAssetCache {
		t.Fatalf("asset cache-control=%q", got)
	}
	if !strings.Contains(asset.Header().Get("Content-Type"), "javascript") {
		t.Fatalf("asset content-type=%q", asset.Header().Get("Content-Type"))
	}

	public := serveWeb(app, http.MethodGet, "/cinema/wall/w01.webp", nil)
	if public.Code != http.StatusOK || public.Header().Get("Cache-Control") != publicFileCache {
		t.Fatalf("public file: %d %q", public.Code, public.Header().Get("Cache-Control"))
	}

	for _, target := range []string{"/static/missing.js", "/missing.png", "/index.html"} {
		if w := serveWeb(app, http.MethodGet, target, nil); w.Code != http.StatusNotFound {
			t.Fatalf("%s: status=%d, want 404", target, w.Code)
		}
	}
}

func TestWebAppMethods(t *testing.T) {
	app := testWebApp(t)
	post := serveWeb(app, http.MethodPost, "/en", nil)
	if post.Code != http.StatusMethodNotAllowed || post.Header().Get("Allow") != "GET, HEAD" {
		t.Fatalf("post: %d allow=%q", post.Code, post.Header().Get("Allow"))
	}
	head := serveWeb(app, http.MethodHead, "/en", nil)
	if head.Code != http.StatusOK || head.Body.Len() != 0 || head.Header().Get("Content-Length") == "" {
		t.Fatalf("head: %d body=%d length=%q", head.Code, head.Body.Len(), head.Header().Get("Content-Length"))
	}
}

func TestBackendFallbackKeepsBackendNamespacesOutOfWebApp(t *testing.T) {
	b := &backend{
		config: config{maxBodyBytes: 1024},
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		web:    testWebApp(t),
	}
	handler := b.handler()
	for _, target := range []string{"/api/not-implemented", "/api", "/v1/unknown", "/v1beta", "/moderate/x", "/api/go/en", "/api/go/static/index-abc.js"} {
		w := serveWeb(handler, http.MethodGet, target, nil)
		if w.Code != http.StatusNotImplemented || !strings.Contains(w.Body.String(), "route_not_migrated") {
			t.Fatalf("%s: %d %s", target, w.Code, w.Body.String())
		}
	}
	page := serveWeb(handler, http.MethodGet, "/en/models", nil)
	if page.Code != http.StatusOK || !strings.Contains(page.Body.String(), `<html lang="en">`) {
		t.Fatalf("page through backend: %d", page.Code)
	}

	withoutWeb := &backend{config: config{maxBodyBytes: 1024}, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	if w := serveWeb(withoutWeb.handler(), http.MethodGet, "/en", nil); w.Code != http.StatusNotImplemented {
		t.Fatalf("backend without web build: %d", w.Code)
	}
}
