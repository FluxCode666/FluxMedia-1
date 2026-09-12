package main

import (
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

type contentBlogPost struct {
	Slug, Title, Description, Date, Author string
	Tags                                   []string
}
type contentPSEORecord struct {
	Slug, Category string
	Locales        map[string]struct {
		SEO struct {
			Description string `json:"description"`
		} `json:"seo"`
		Hero struct{ Title, Highlight string } `json:"hero"`
	} `json:"locales"`
}

func (b *backend) registerContentRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/content/blog", b.endpoint(b.handleContentBlog))
	mux.HandleFunc("GET /api/content/pseo", b.endpoint(b.handleContentPSEO))
}

func contentRoot() string {
	if root := os.Getenv("FLUXMEDIA_WEB_ROOT"); root != "" {
		return root
	}
	return filepath.Join("..", "..", "apps", "web")
}

func contentPagination[T any](records []T, page, pageSize int) map[string]any {
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 20
	}
	if pageSize > 50 {
		pageSize = 50
	}
	total := len(records)
	pages := int(math.Ceil(float64(total) / float64(pageSize)))
	if pages < 1 {
		pages = 1
	}
	if page > pages {
		page = pages
	}
	start := (page - 1) * pageSize
	end := start + pageSize
	if start > total {
		start = total
	}
	if end > total {
		end = total
	}
	return map[string]any{"records": records[start:end], "page": page, "pageSize": pageSize, "totalCount": total, "totalPages": pages}
}

func parseFrontmatter(path string) (contentBlogPost, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return contentBlogPost{}, err
	}
	lines := strings.Split(strings.ReplaceAll(string(b), "\r\n", "\n"), "\n")
	if len(lines) < 3 || strings.TrimSpace(lines[0]) != "---" {
		return contentBlogPost{}, errors.New("missing frontmatter")
	}
	var out contentBlogPost
	inTags := false
	for _, line := range lines[1:] {
		line = strings.TrimSpace(line)
		if line == "---" {
			break
		}
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "- ") && inTags {
			out.Tags = append(out.Tags, strings.Trim(strings.TrimSpace(strings.TrimPrefix(line, "- ")), "\"'"))
			continue
		}
		parts := strings.SplitN(line, ":", 2)
		if len(parts) != 2 {
			continue
		}
		key, val := strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1])
		inTags = key == "tags"
		val = strings.Trim(val, "\"'")
		switch key {
		case "title":
			out.Title = val
		case "description":
			out.Description = val
		case "date":
			out.Date = val
		case "author":
			out.Author = val
		case "tags":
			if strings.HasPrefix(val, "[") {
				_ = json.Unmarshal([]byte(val), &out.Tags)
			}
		}
	}
	name := filepath.Base(path)
	out.Slug = strings.TrimSuffix(name, filepath.Ext(name))
	return out, nil
}

func loadContentBlogs(locale string) ([]contentBlogPost, error) {
	entries, err := os.ReadDir(filepath.Join(contentRoot(), "src", "content", "blog", locale))
	if err != nil {
		return nil, err
	}
	posts := make([]contentBlogPost, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".mdx") {
			continue
		}
		p, err := parseFrontmatter(filepath.Join(contentRoot(), "src", "content", "blog", locale, e.Name()))
		if err != nil {
			return nil, err
		}
		posts = append(posts, p)
	}
	sort.Slice(posts, func(i, j int) bool {
		a, b := posts[i], posts[j]
		ta, _ := time.Parse("2006-01-02", a.Date)
		tb, _ := time.Parse("2006-01-02", b.Date)
		if !ta.Equal(tb) {
			return tb.Before(ta)
		}
		return a.Slug < b.Slug
	})
	return posts, nil
}

func (b *backend) handleContentBlog(w http.ResponseWriter, r *http.Request) error {
	locale := r.URL.Query().Get("locale")
	if locale != "en" && locale != "zh" {
		return invalid("locale must be en or zh")
	}
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	size, _ := strconv.Atoi(r.URL.Query().Get("pageSize"))
	posts, err := loadContentBlogs(locale)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, contentPagination(posts, page, size))
	return nil
}

func (b *backend) handleContentPSEO(w http.ResponseWriter, r *http.Request) error {
	locale := r.URL.Query().Get("locale")
	if locale != "en" && locale != "zh" {
		return invalid("locale must be en or zh")
	}
	bts, err := os.ReadFile(filepath.Join(contentRoot(), "src", "features", "pseo", "data", "pseo-pages.json"))
	if err != nil {
		return err
	}
	var raw []contentPSEORecord
	if err = json.Unmarshal(bts, &raw); err != nil {
		return err
	}
	type summary struct{ Slug, Category, Title, Description string }
	records := make([]summary, 0, len(raw))
	for _, p := range raw {
		d, ok := p.Locales[locale]
		if !ok {
			d, ok = p.Locales["en"]
		}
		if !ok {
			continue
		}
		records = append(records, summary{p.Slug, p.Category, strings.TrimSpace(d.Hero.Title + " " + d.Hero.Highlight), d.SEO.Description})
	}
	sort.Slice(records, func(i, j int) bool { return records[i].Slug < records[j].Slug })
	writeJSON(w, http.StatusOK, contentPagination(records, pageFrom(r), sizeFrom(r)))
	return nil
}
func pageFrom(r *http.Request) int { n, _ := strconv.Atoi(r.URL.Query().Get("page")); return n }
func sizeFrom(r *http.Request) int { n, _ := strconv.Atoi(r.URL.Query().Get("pageSize")); return n }
