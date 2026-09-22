package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func writeContentFixture(t *testing.T, root, relative, body string) string {
	t.Helper()
	path := filepath.Join(root, relative)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestContentFrontmatterYAML(t *testing.T) {
	root := t.TempDir()
	path := writeContentFixture(t, root, "quoted.mdx", `---
title: "Title: with # punctuation"
description: >-
  First line
  second line.
date: 2026-09-14
author: 'The "Team"'
tags: [image, 'news: release']
image: /cover.png
---
# Body that must not become DTO fields
`)
	post, err := parseFrontmatter(path)
	if err != nil {
		t.Fatal(err)
	}
	want := contentBlogPost{Slug: "quoted", Title: "Title: with # punctuation", Description: "First line second line.", Date: "2026-09-14", Author: `The "Team"`, Tags: []string{"image", "news: release"}}
	if !reflect.DeepEqual(post, want) {
		t.Fatalf("post = %#v, want %#v", post, want)
	}
	for _, body := range []string{"no frontmatter", "---\ntitle: unclosed\nbody", "---\ntags: [invalid\n---\n"} {
		path = writeContentFixture(t, root, "invalid.mdx", body)
		if _, err = parseFrontmatter(path); err == nil {
			t.Fatalf("accepted malformed frontmatter: %q", body)
		}
	}
}

func TestContentBlogHTTPContract(t *testing.T) {
	root := t.TempDir()
	t.Setenv("FLUXMEDIA_WEB_ROOT", root)
	writeContentFixture(t, root, "src/content/blog/en/older.mdx", "---\ntitle: Older\ndate: 2026-08-10\nauthor: A\n---\n")
	writeContentFixture(t, root, "src/content/blog/en/newer-b.mdx", "---\ntitle: Newer B\ndate: 2026-08-13T00:00:00Z\nauthor: B\ntags:\n - news\n---\n")
	writeContentFixture(t, root, "src/content/blog/en/newer-a.mdx", "---\ntitle: Newer A\ndate: 2026-08-13\nauthor: A\n---\n")
	writeContentFixture(t, root, "src/content/blog/en/ignored.txt", "ignored")
	writeContentFixture(t, root, "src/content/blog/zh/only.mdx", "---\ntitle: 中文\ndate: 2026-09-14\nauthor: Team\n---\n")
	backend := &backend{}
	mux := http.NewServeMux()
	backend.registerContentRoutes(mux)
	var first map[string]any
	for _, tc := range []struct {
		query                    string
		page, size, total, pages int
		slugs                    []string
	}{
		{"locale=en&page=1&pageSize=2", 1, 2, 3, 2, []string{"newer-a", "newer-b"}},
		{"locale=en&page=99&pageSize=2", 2, 2, 3, 2, []string{"older"}},
		{"locale=zh&page=0&pageSize=999", 1, 50, 1, 1, []string{"only"}},
	} {
		rr := httptest.NewRecorder()
		mux.ServeHTTP(rr, httptest.NewRequest("GET", "/api/content/blog?"+tc.query, nil))
		if rr.Code != 200 {
			t.Fatalf("status=%d body=%s", rr.Code, rr.Body)
		}
		var payload struct {
			Records    []map[string]any `json:"records"`
			Page       int              `json:"page"`
			PageSize   int              `json:"pageSize"`
			TotalCount int              `json:"totalCount"`
			TotalPages int              `json:"totalPages"`
		}
		if err := json.Unmarshal(rr.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		if payload.Page != tc.page || payload.PageSize != tc.size || payload.TotalCount != tc.total || payload.TotalPages != tc.pages {
			t.Fatalf("wrong pagination: %+v", payload)
		}
		slugs := []string{}
		for _, row := range payload.Records {
			slugs = append(slugs, row["slug"].(string))
			if len(row) != 6 {
				t.Fatalf("unexpected summary keys: %#v", row)
			}
			for _, key := range []string{"slug", "title", "description", "date", "author", "tags"} {
				if _, ok := row[key]; !ok {
					t.Fatalf("missing %s in %#v", key, row)
				}
			}
			if _, ok := row["tags"].([]any); !ok {
				t.Fatalf("tags must be JSON array: %#v", row["tags"])
			}
		}
		if !reflect.DeepEqual(slugs, tc.slugs) {
			t.Fatalf("slugs=%v want=%v", slugs, tc.slugs)
		}
		if first == nil {
			first = payload.Records[0]
		}
	}
	if first["date"] != "2026-08-13" {
		t.Fatalf("date changed: %#v", first)
	}
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest("GET", "/api/content/blog?locale=../../en", nil))
	if rr.Code != 400 {
		t.Fatalf("invalid locale status=%d", rr.Code)
	}
	if err := os.MkdirAll(filepath.Join(root, "src/content/blog/zh-empty"), 0755); err != nil {
		t.Fatal(err)
	}
	empty := contentPagination([]contentBlogPost{}, 999, 1)
	encoded, err := json.Marshal(empty)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `{"page":1,"pageSize":1,"records":[],"totalCount":0,"totalPages":1}` {
		t.Fatalf("empty page=%s", encoded)
	}
}

func TestContentPSEOHTTPContract(t *testing.T) {
	root := t.TempDir()
	t.Setenv("FLUXMEDIA_WEB_ROOT", root)
	writeContentFixture(t, root, "src/features/pseo/data/pseo-pages.json", `[
 {"slug":"z-page","category":"image","locales":{"en":{"hero":{"title":"English", "highlight":"Page"},"seo":{"description":"English summary"}}}},
 {"slug":"a-page","category":"video","locales":{"en":{"hero":{"title":"Fallback"}},"zh":{"hero":{"title":"中文", "highlight":"页面"},"seo":{"description":"中文摘要"}}}},
 {"slug":"excluded","category":"image","locales":{"fr":{"hero":{"title":"French"}}}}
]`)
	b := &backend{}
	for _, tc := range []struct {
		query                    string
		page                     int
		slug, title, description string
	}{
		{"locale=zh&page=1&pageSize=1", 1, "a-page", "中文 页面", "中文摘要"},
		{"locale=zh&page=99&pageSize=1", 2, "z-page", "English Page", "English summary"},
	} {
		rr := httptest.NewRecorder()
		if err := b.handleContentPSEO(rr, httptest.NewRequest("GET", "/api/content/pseo?"+tc.query, nil)); err != nil {
			t.Fatal(err)
		}
		var payload map[string]any
		if err := json.Unmarshal(rr.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		records := payload["records"].([]any)
		if payload["page"] != float64(tc.page) || payload["totalCount"] != float64(2) || len(records) != 1 {
			t.Fatalf("page=%#v", payload)
		}
		want := map[string]any{"slug": tc.slug, "category": map[string]string{"a-page": "video", "z-page": "image"}[tc.slug], "title": tc.title, "description": tc.description}
		if !reflect.DeepEqual(records[0], want) {
			t.Fatalf("summary=%#v want=%#v", records[0], want)
		}
	}
}
