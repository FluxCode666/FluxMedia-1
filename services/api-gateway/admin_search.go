package main

import (
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"gopkg.in/yaml.v3"
)

// The default Fumadocs fetch client consumes a bare SortedResult[] and pushes
// each result URL directly. Only index the collection configured in source.config.ts.
type adminSearchResult struct {
	ID      string `json:"id"`
	Type    string `json:"type"`
	Content string `json:"content"`
	URL     string `json:"url"`
}
type adminSearchDocument struct {
	Title       string
	Description string
	URL         string
	Tags        []string
	Entries     []adminSearchResult
}

func (b *backend) handleAdminSearch(w http.ResponseWriter, r *http.Request) error {
	if _, err := b.requireAdmin(r, false); err != nil {
		return err
	}
	noStore(w)
	query := strings.TrimSpace(r.URL.Query().Get("query"))
	results := []adminSearchResult{}
	if query == "" {
		writeJSON(w, http.StatusOK, results)
		return nil
	}
	if len([]rune(query)) > 512 {
		return invalid("Search query is too long")
	}
	limit := 60
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 200 {
			return invalid("Invalid search limit")
		}
		limit = parsed
	}
	documents, err := loadAdminSearchDocuments(filepath.Join(contentRoot(), "src", "content", "docs"))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return &apiError{503, "NOT_READY", "Documentation search is unavailable"}
		}
		return err
	}
	terms := strings.Fields(strings.ToLower(query))
	tags := strings.FieldsFunc(r.URL.Query().Get("tag"), func(r rune) bool { return r == ',' })
	type group struct {
		score   int
		results []adminSearchResult
	}
	groups := []group{}
	for _, doc := range documents {
		if !adminSearchTagsMatch(doc.Tags, tags) {
			continue
		}
		text := doc.Title + "\n" + doc.Description
		for _, entry := range doc.Entries {
			text += "\n" + entry.Content
		}
		if !adminSearchMatches(text, terms) {
			continue
		}
		score := 1
		if adminSearchMatches(doc.Description, terms) {
			score = 2
		}
		if adminSearchMatches(doc.Title, terms) {
			score = 3
		}
		items := []adminSearchResult{{ID: doc.URL, Type: "page", Content: doc.Title, URL: doc.URL}}
		for _, entry := range doc.Entries {
			if adminSearchMatches(entry.Content, terms) {
				entry.Content = adminSearchSnippet(entry.Content, terms)
				items = append(items, entry)
				if len(items) == 8 {
					break
				}
			}
		}
		groups = append(groups, group{score, items})
	}
	sort.SliceStable(groups, func(i, j int) bool {
		if groups[i].score != groups[j].score {
			return groups[i].score > groups[j].score
		}
		return groups[i].results[0].URL < groups[j].results[0].URL
	})
	for _, group := range groups {
		results = append(results, group.results...)
		if len(results) >= limit {
			results = results[:limit]
			break
		}
	}
	writeJSON(w, http.StatusOK, results)
	return nil
}

func adminSearchMatches(text string, terms []string) bool {
	text = strings.ToLower(text)
	for _, term := range terms {
		if !strings.Contains(text, term) {
			return false
		}
	}
	return true
}
func adminSearchTagsMatch(tags, requested []string) bool {
	for _, wanted := range requested {
		found := false
		for _, tag := range tags {
			if tag == wanted {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

func adminSearchSnippet(text string, terms []string) string {
	chars := []rune(text)
	if len(chars) <= 300 {
		return text
	}
	start := 0
	lower := strings.ToLower(text)
	for _, term := range terms {
		if index := strings.Index(lower, term); index >= 0 {
			start = len([]rune(lower[:index])) - 70
			if start < 0 {
				start = 0
			}
			break
		}
	}
	end := start + 300
	if end > len(chars) {
		end = len(chars)
	}
	result := string(chars[start:end])
	if start > 0 {
		result = "…" + result
	}
	if end < len(chars) {
		result += "…"
	}
	return result
}

func loadAdminSearchDocuments(root string) ([]adminSearchDocument, error) {
	documents := []adminSearchDocument{}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		ext := strings.ToLower(filepath.Ext(path))
		if ext != ".md" && ext != ".mdx" {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		lines := strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n")
		var meta struct {
			Title       string   `yaml:"title"`
			Description string   `yaml:"description"`
			Tags        []string `yaml:"tags"`
		}
		if len(lines) < 3 || strings.TrimSpace(lines[0]) != "---" {
			return fmt.Errorf("search document has no frontmatter")
		}
		end := 1
		for end < len(lines) && strings.TrimSpace(lines[end]) != "---" {
			end++
		}
		if end == len(lines) {
			return fmt.Errorf("search document frontmatter is unclosed")
		}
		if err = yaml.Unmarshal([]byte(strings.Join(lines[1:end], "\n")), &meta); err != nil {
			return err
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		slug := strings.TrimSuffix(filepath.ToSlash(relative), filepath.Ext(relative))
		if slug == "index" {
			slug = ""
		} else {
			slug = strings.TrimSuffix(slug, "/index")
		}
		pageURL := "/docs"
		if slug != "" {
			pageURL += "/" + urlPathEscape(slug)
		}
		if meta.Title == "" {
			meta.Title = strings.TrimSuffix(filepath.Base(path), ext)
		}
		doc := adminSearchDocument{Title: meta.Title, Description: meta.Description, Tags: meta.Tags, URL: pageURL}
		currentURL := pageURL
		paragraph := []string{}
		flush := func() {
			if len(paragraph) == 0 {
				return
			}
			doc.Entries = append(doc.Entries, adminSearchResult{ID: fmt.Sprintf("%s:text:%d", pageURL, len(doc.Entries)), Type: "text", Content: strings.Join(paragraph, " "), URL: currentURL})
			paragraph = nil
		}
		headingCounts := map[string]int{}
		fenced := false
		for _, raw := range lines[end+1:] {
			line := strings.TrimSpace(raw)
			if strings.HasPrefix(line, "```") || strings.HasPrefix(line, "~~~") {
				fenced = !fenced
				continue
			}
			if line == "" {
				flush()
				continue
			}
			if !fenced && (strings.HasPrefix(line, "import ") || strings.HasPrefix(line, "export ") || strings.HasPrefix(line, "<!--")) {
				continue
			}
			if !fenced && strings.HasPrefix(line, "#") {
				count := len(line) - len(strings.TrimLeft(line, "#"))
				if count <= 6 && len(line) > count && line[count] == ' ' {
					flush()
					title := strings.TrimSpace(strings.TrimRight(strings.TrimSpace(line[count:]), "#"))
					anchor := strings.Map(func(ch rune) rune {
						if unicode.IsLetter(ch) || unicode.IsNumber(ch) || ch == '_' || ch == '-' {
							return unicode.ToLower(ch)
						}
						if ch == ' ' {
							return '-'
						}
						return -1
					}, title)
					occurrence := headingCounts[anchor]
					headingCounts[anchor]++
					if occurrence > 0 {
						anchor += "-" + strconv.Itoa(occurrence)
					}
					currentURL = pageURL + "#" + url.PathEscape(anchor)
					doc.Entries = append(doc.Entries, adminSearchResult{ID: currentURL, Type: "heading", Content: title, URL: currentURL})
					continue
				}
			}
			paragraph = append(paragraph, line)
		}
		flush()
		documents = append(documents, doc)
		return nil
	})
	return documents, err
}
