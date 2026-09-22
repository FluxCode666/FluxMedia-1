package main

import (
	"encoding/json"
	"errors"
	"gopkg.in/yaml.v3"
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
	Slug        string   `json:"slug" yaml:"-"`
	Title       string   `json:"title" yaml:"title"`
	Description string   `json:"description" yaml:"description"`
	Date        string   `json:"date" yaml:"date"`
	Author      string   `json:"author" yaml:"author"`
	Tags        []string `json:"tags" yaml:"tags"`
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
	frontmatter := []string{}
	closed := false
	for _, line := range lines[1:] {
		if strings.TrimSpace(line) == "---" {
			closed = true
			break
		}
		frontmatter = append(frontmatter, line)
	}
	if !closed {
		return contentBlogPost{}, errors.New("unclosed frontmatter")
	}
	out := contentBlogPost{Tags: []string{}}
	if err = yaml.Unmarshal([]byte(strings.Join(frontmatter, "\n")), &out); err != nil {
		return contentBlogPost{}, err
	}
	if out.Tags == nil {
		out.Tags = []string{}
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
		ta := contentDate(a.Date)
		tb := contentDate(b.Date)
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
	type summary struct {
		Slug        string `json:"slug"`
		Category    string `json:"category"`
		Title       string `json:"title"`
		Description string `json:"description"`
	}
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

func contentDate(value string) time.Time {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02"} {
		if at, err := time.Parse(layout, value); err == nil {
			return at
		}
	}
	return time.Time{}
}
