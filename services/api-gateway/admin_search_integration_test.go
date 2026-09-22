//go:build integration

package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestAdminDocumentationSearchUsesFumadocsCollectionAndArrayContract(t *testing.T) {
	b := integrationBackend(t)
	root := t.TempDir()
	t.Setenv("FLUXMEDIA_WEB_ROOT", root)
	writeContentFixture(t, root, "src/content/docs/index.mdx", "---\ntitle: 文档目录\ndescription: 快速开始指南\n---\n欢迎来到文档。\n")
	writeContentFixture(t, root, "src/content/docs/system.mdx", "---\ntitle: 系统文档\ndescription: 架构和外部 API\ntags: [internal]\n---\n## 积分结算\n\n"+strings.Repeat("中文上下文", 120)+"积分 lease recovery。\n\n## 积分结算\n\n另一个 lease 说明。\n")
	writeContentFixture(t, root, "src/content/docs/nested/index.mdx", "---\ntitle: Nested Lease\n---\nLease overview.\n")
	writeContentFixture(t, root, "docs/private.md", "RepositoryOnlySecretToken should never be in the site documentation index")
	admin, email := seedAuthUser(t, b)
	if _, err := b.db.Exec(context.Background(), `UPDATE "user" SET role='admin' WHERE id=$1`, admin); err != nil {
		t.Fatal(err)
	}
	cookie := signInTestUser(t, b, email)
	read := func(query string) []adminSearchResult {
		t.Helper()
		response := authRequest(t, b, http.MethodGet, "/api/search?"+query, "", cookie)
		if response.Code != http.StatusOK {
			t.Fatalf("search status=%d body=%s", response.Code, response.Body)
		}
		var results []adminSearchResult
		if err := json.Unmarshal(response.Body.Bytes(), &results); err != nil || results == nil {
			t.Fatalf("Fumadocs expects a JSON array, got %s: %v", response.Body, err)
		}
		if !strings.Contains(response.Header().Get("Cache-Control"), "no-store") {
			t.Fatal("private search response must not be cached")
		}
		return results
	}
	for _, query := range []string{"query=", "query=RepositoryOnlySecretToken", "query=nonexistent", "query=lease&tag=unknown"} {
		if results := read(query); len(results) != 0 {
			t.Fatalf("unexpected matches for %s: %v", query, results)
		}
	}
	results := read("query=LEASE")
	if len(results) < 3 || results[0].Type != "page" || results[0].URL != "/docs/nested" {
		t.Fatalf("title ranking or canonical index URL incorrect: %v", results)
	}
	for _, result := range results {
		if result.ID == "" || result.Content == "" || !strings.HasPrefix(result.URL, "/docs") || strings.Contains(result.URL, ".md") || strings.Contains(result.URL, "..") || !utf8.ValidString(result.Content) {
			t.Fatalf("invalid search entry: %#v", result)
		}
	}
	if limited := read("query=lease&limit=1"); len(limited) != 1 || limited[0].URL != "/docs/nested" {
		t.Fatalf("limit was ignored: %v", limited)
	}
	results = read("query=%E7%A7%AF%E5%88%86%20lease&tag=internal")
	if len(results) < 2 || results[0].URL != "/docs/system" || !strings.Contains(results[1].Content, "积分 lease recovery") || !strings.Contains(results[1].URL, "#") {
		t.Fatalf("body search must find the matching snippet and heading link: %v", results)
	}
	results = read("query=%E7%A7%AF%E5%88%86%E7%BB%93%E7%AE%97")
	foundDuplicate := false
	for _, result := range results {
		if strings.HasSuffix(result.URL, "-1") {
			foundDuplicate = true
		}
	}
	if !foundDuplicate {
		t.Fatalf("duplicate heading anchor was lost: %v", results)
	}
	_, userEmail := seedAuthUser(t, b)
	userCookie := signInTestUser(t, b, userEmail)
	for _, entry := range []struct {
		cookie *http.Cookie
		status int
	}{{nil, 401}, {userCookie, 403}} {
		cookies := []*http.Cookie{}
		if entry.cookie != nil {
			cookies = append(cookies, entry.cookie)
		}
		requireCreditResponse(t, authRequest(t, b, http.MethodGet, "/api/search?query=lease", "", cookies...), entry.status)
	}
	for _, limit := range []string{"0", "-1", "201", "1.5", "bad"} {
		requireCreditResponse(t, authRequest(t, b, http.MethodGet, "/api/search?query=lease&limit="+limit, "", cookie), 400)
	}
	// Broken deployment packaging must not report a successful empty index.
	t.Setenv("FLUXMEDIA_WEB_ROOT", t.TempDir())
	requireCreditResponse(t, authRequest(t, b, http.MethodGet, "/api/search?query=lease", "", cookie), 503)
}
