package main

// Native implementations for the remaining administrative HTTP adapters.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func (b *backend) requireAdmin(r *http.Request, super bool) (*sessionResponse, error) {
	s, err := b.requireSession(r)
	if err != nil {
		return nil, err
	}
	if super {
		if s.User.Role != "super_admin" {
			return nil, forbidden()
		}
	} else if s.User.Role != "admin" && s.User.Role != "super_admin" {
		return nil, forbidden()
	}
	return s, nil
}

func (b *backend) requireAdminViewer(r *http.Request) (*sessionResponse, error) {
	s, err := b.requireSession(r)
	if err != nil {
		return nil, err
	}
	if s.User.Role != "observer_admin" && s.User.Role != "admin" && s.User.Role != "super_admin" && s.User.Role != "owner" {
		return nil, forbidden()
	}
	return s, nil
}

// handleVideoReconciliation preserves the removed endpoint's explicit contract.
func (b *backend) handleVideoReconciliation(w http.ResponseWriter, r *http.Request) error {
	return &apiError{http.StatusGone, "REMOVED", "视频人工核对入口已移除"}
}

// handleAdminSearch provides a small Fumadocs-compatible result set from local docs.
func (b *backend) handleAdminSearch(w http.ResponseWriter, r *http.Request) error {
	if _, err := b.requireAdmin(r, false); err != nil {
		return err
	}
	q := strings.TrimSpace(r.URL.Query().Get("query"))
	if q == "" {
		writeJSON(w, http.StatusOK, map[string]any{"results": []any{}})
		return nil
	}
	type result struct {
		ID      string `json:"id"`
		Type    string `json:"type"`
		Content string `json:"content"`
		URL     string `json:"url"`
	}
	results := make([]result, 0, 20)
	roots := []string{"docs", "../../docs", "../docs"}
	seen := map[string]bool{}
	for _, root := range roots {
		_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, walkErr error) error {
			if walkErr != nil || d == nil || d.IsDir() || len(results) >= 20 {
				return nil
			}
			ext := strings.ToLower(filepath.Ext(path))
			if ext != ".md" && ext != ".mdx" {
				return nil
			}
			data, err := os.ReadFile(path)
			if err != nil {
				return nil
			}
			if !strings.Contains(strings.ToLower(string(data)), strings.ToLower(q)) {
				return nil
			}
			abs, _ := filepath.Abs(path)
			if seen[abs] {
				return nil
			}
			seen[abs] = true
			textContent := strings.TrimSpace(string(data))
			if len(textContent) > 500 {
				textContent = textContent[:500]
			}
			results = append(results, result{ID: strings.TrimSuffix(filepath.ToSlash(path), ext), Type: "page", Content: textContent, URL: "/" + filepath.ToSlash(path)})
			return nil
		})
		if len(results) >= 20 {
			break
		}
	}
	sort.Slice(results, func(i, j int) bool { return results[i].ID < results[j].ID })
	out := make([]any, 0, len(results))
	for _, item := range results {
		out = append(out, item)
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": out})
	return nil
}

func (b *backend) handleAdminLogoUpload(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireAdmin(r, true)
	if err != nil {
		return err
	}
	if err := r.ParseMultipartForm(6 << 20); err != nil {
		return invalid("Logo 上传表单无效")
	}
	clientRequestID := strings.TrimSpace(r.FormValue("clientRequestId"))
	if clientRequestID == "" || len(clientRequestID) > 128 {
		return invalid("上传请求标识无效")
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		return invalid("Logo 上传表单缺少文件")
	}
	defer file.Close()
	if header.Size <= 0 || header.Size > 5<<20 {
		return invalid("Logo 文件不能超过 5 MB")
	}
	data, err := io.ReadAll(io.LimitReader(file, 5<<20+1))
	if err != nil {
		return err
	}
	if len(data) == 0 || len(data) > 5<<20 {
		return invalid("Logo 文件不能超过 5 MB")
	}
	contentType := strings.ToLower(strings.TrimSpace(header.Header.Get("Content-Type")))
	ext := strings.ToLower(filepath.Ext(header.Filename))
	allowed := map[string]string{".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon"}
	if expected, ok := allowed[ext]; !ok || (contentType != "" && contentType != expected) {
		return invalid("仅支持 PNG、SVG 或 ICO Logo")
	} else {
		contentType = expected
	}
	// Content-addressed objects are immutable; retries safely target one key.
	hash := sha256.Sum256(data)
	name := hex.EncodeToString(hash[:]) + ext
	bucket, _, bucketErr := b.storageBuckets(r.Context())
	if bucketErr != nil {
		return bucketErr
	}
	key := filepath.ToSlash(filepath.Join("logo", name))
	if err := b.putStorageObject(r.Context(), bucket, key, data, contentType); err != nil {
		return err
	}
	logoURL := "/api/storage/" + urlPathEscape(bucket) + "/" + urlPathEscape(key)
	// Persist an idempotency receipt and the setting atomically. A repeated
	// clientRequestId with a different payload is rejected instead of silently
	// switching the active logo.
	requestHash := hex.EncodeToString(hash[:])
	receiptHash := sha256.Sum256([]byte(s.User.ID + ":" + clientRequestID))
	receiptID := "site-logo-upload:" + hex.EncodeToString(receiptHash[:])
	tx, err := b.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	metadata, _ := json.Marshal(map[string]any{"requestHash": requestHash, "sha256": requestHash, "contentType": contentType})
	after, _ := json.Marshal(map[string]any{"logoUrl": logoURL})
	inserted, err := tx.Exec(r.Context(), `INSERT INTO admin_audit_log(id,admin_user_id,target_user_id,action,reason,before,after,metadata,created_at) VALUES($1,$2,NULL,'system-settings.site-logo.upload','管理员上传网站 Logo',NULL,$3,$4,now()) ON CONFLICT(id) DO NOTHING`, receiptID, s.User.ID, after, metadata)
	if err != nil {
		return err
	}
	replayed := inserted.RowsAffected() == 0
	if replayed {
		var previousHash, previousURL string
		if err := tx.QueryRow(r.Context(), `SELECT COALESCE(metadata->>'requestHash',''), COALESCE(after->>'logoUrl','') FROM admin_audit_log WHERE id=$1`, receiptID).Scan(&previousHash, &previousURL); err != nil {
			return err
		}
		if previousHash != requestHash {
			return &apiError{409, "IDEMPOTENCY_CONFLICT", "该上传请求标识已用于另一份 Logo"}
		}
		logoURL = previousURL
	} else {
		value, _ := json.Marshal(logoURL)
		if _, err = tx.Exec(r.Context(), `INSERT INTO system_setting(key,value,is_secret,updated_by,updated_at) VALUES('SITE_LOGO_URL',$1,false,$2,now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_BY,updated_at=now()`, value, s.User.ID); err != nil {
			return err
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	noStore(w)
	writeJSON(w, http.StatusOK, map[string]any{"logoUrl": logoURL, "replayed": replayed, "clientRequestId": clientRequestID})
	return nil
}

// modelConfigurationRead returns the lightweight compatibility DTO used by the
// migrated server actions. The authoritative value is MODEL_MARKETPLACE_CONFIG;
// pricing/runtime discovery remains owned by the existing model catalog service.
func (b *backend) modelConfigurationRead(r *http.Request, canEdit bool) (map[string]any, error) {
	var raw []byte
	err := b.db.QueryRow(r.Context(), `SELECT value FROM system_setting WHERE key='MODEL_MARKETPLACE_CONFIG'`).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		raw = []byte(`{"version":2,"imageByModel":{},"videoByFamily":{},"customModels":[]}`)
	} else if err != nil {
		return nil, err
	}
	var cfg map[string]any
	if json.Unmarshal(raw, &cfg) != nil {
		cfg = map[string]any{}
	}
	// MODEL_MARKETPLACE_CONFIG stores overrides only. The visible model catalog is
	// discovered from enabled backend members, so an empty override must not make
	// the admin page appear empty after migration.
	for _, section := range []string{"imageByModel", "videoByFamily"} {
		if _, ok := cfg[section].(map[string]any); !ok {
			cfg[section] = map[string]any{}
		}
	}
	if rows, queryErr := b.db.Query(r.Context(), `SELECT supported_model_ids FROM image_backend_member WHERE is_enabled AND status <> 'error'`); queryErr == nil {
		defer rows.Close()
		for rows.Next() {
			var encoded []byte
			if rows.Scan(&encoded) != nil {
				continue
			}
			var ids []string
			if json.Unmarshal(encoded, &ids) != nil {
				continue
			}
			for _, id := range ids {
				key := normalizeModelID(id)
				if key == "" || strings.EqualFold(key, "default") || isLegacyVideoModel(key) {
					continue
				}
				section := "imageByModel"
				if isVideoModel(strings.ToLower(key)) {
					section = "videoByFamily"
				}
				items := cfg[section].(map[string]any)
				if _, exists := items[key]; !exists {
					items[key] = map[string]any{}
				}
			}
		}
	}
	entries := make([]map[string]any, 0, 128)
	addCommon := func(key string, value map[string]any) map[string]any {
		entry := map[string]any{
			"configKey": key, "displayName": key, "marketplaceApplicable": true,
			"enabled": true, "visible": true, "homepageVisible": false,
			"homepagePriority": 0, "description": "", "coverUrl": nil,
			"usesDefaultCover": true, "revision": int64(0),
		}
		for _, k := range []string{"displayName", "enabled", "visible", "homepageVisible", "homepagePriority", "description", "revision", "isCustom"} {
			if v, ok := value[k]; ok {
				entry[k] = v
			}
		}
		if cover, ok := value["cover"].(map[string]any); ok {
			if u, ok := cover["url"].(string); ok && u != "" {
				entry["coverUrl"] = u
				entry["usesDefaultCover"] = false
			}
		}
		return entry
	}
	addSection := func(section, category string) {
		items, _ := cfg[section].(map[string]any)
		for key, value := range items {
			obj, _ := value.(map[string]any)
			if obj == nil {
				obj = map[string]any{}
			}
			entry := addCommon(key, obj)
			entry["category"] = category
			if category == "image" {
				if pricing, ok := obj["pricing"].(map[string]any); ok {
					entry["pricingSource"] = "explicit"
					entry["pricing"] = pricing
					entry["minimumCredits"] = 1.0
				} else {
					entry["pricingSource"] = "unconfigured"
				}
			} else {
				entry["billingMode"] = "per_second"
				entry["creditsPerSecond"] = 1.0
				entry["creditsPerSecondByResolution"] = map[string]any{"720p": 1.0}
				entry["creditsPerItemByResolution"] = map[string]any{"720p": 1.0}
				entry["supportedResolutions"] = []string{"720p"}
				entry["minimumCredits"] = 1.0
			}
			entries = append(entries, entry)
		}
	}
	addSection("imageByModel", "image")
	addSection("videoByFamily", "video")
	return map[string]any{"canEdit": canEdit, "runtimeCatalogStatus": "unavailable", "entries": entries}, nil
}

func (b *backend) handleModelConfigurationRead(w http.ResponseWriter, r *http.Request, body map[string]json.RawMessage) error {
	s, err := b.requireAdminViewer(r)
	if err != nil {
		return err
	}
	canEdit := s.User.Role == "super_admin"
	snapshot, err := b.modelConfigurationRead(r, canEdit)
	if err != nil {
		return err
	}
	if body == nil {
		q := r.URL.Query()
		if q.Get("page") == "" && q.Get("pageSize") == "" && q.Get("query") == "" && q.Get("category") == "" {
			writeJSON(w, http.StatusOK, snapshot)
			return nil
		}
		body = map[string]json.RawMessage{}
		for _, key := range []string{"page", "pageSize", "query", "category"} {
			if value := q.Get(key); value != "" {
				body[key] = json.RawMessage(strconv.Quote(value))
			}
		}
	}
	page, pageSize := rawInt(body, "page"), rawInt(body, "pageSize")
	if page < 1 {
		page = 1
	}
	if pageSize != 10 && pageSize != 20 && pageSize != 50 {
		pageSize = 20
	}
	query, category := strings.ToLower(strings.TrimSpace(rawString(body, "query"))), rawString(body, "category")
	if category == "" {
		category = "all"
	}
	all := snapshot["entries"].([]map[string]any)
	filtered := make([]map[string]any, 0, len(all))
	for _, e := range all {
		if category != "all" && e["category"] != category {
			continue
		}
		if query != "" && !strings.Contains(strings.ToLower(fmt.Sprint(e["configKey"])), query) && !strings.Contains(strings.ToLower(fmt.Sprint(e["displayName"])), query) {
			continue
		}
		filtered = append(filtered, e)
	}
	total := len(filtered)
	pages := (total + pageSize - 1) / pageSize
	if pages < 1 {
		pages = 1
	}
	if page > pages {
		page = pages
	}
	from := (page - 1) * pageSize
	to := from + pageSize
	if from > total {
		from = total
	}
	if to > total {
		to = total
	}
	returnJSON := map[string]any{"records": filtered[from:to], "page": page, "pageSize": pageSize, "totalCount": total, "totalPages": pages, "canEdit": canEdit, "runtimeCatalogStatus": snapshot["runtimeCatalogStatus"]}
	writeJSON(w, http.StatusOK, returnJSON)
	return nil
}

func (b *backend) handleModelConfiguration(w http.ResponseWriter, r *http.Request) error {
	if r.Method == http.MethodGet {
		return b.handleModelConfigurationRead(w, r, nil)
	}
	if r.Method == http.MethodPost && strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "application/json") {
		body, err := decodeObject(r)
		if err != nil {
			return err
		}
		// UOL and server actions submit the strict model configuration command as
		// JSON.  Keep reads query driven while routing command shaped payloads
		// through the same authenticated mutation path as multipart admin forms.
		if rawString(body, "category") != "" && rawString(body, "configKey", "modelId") != "" {
			if _, err := b.requireAdmin(r, true); err != nil {
				return err
			}
			category := rawString(body, "category")
			if category != "image" && category != "video" {
				return invalid("模型配置参数无效")
			}
			key := rawString(body, "configKey", "modelId")
			entry := map[string]any{"configKey": key, "category": category}
			for field, raw := range body {
				if field == "configKey" || field == "modelId" || field == "category" || field == "clientRequestId" || field == "expectedRevision" {
					continue
				}
				var value any
				if json.Unmarshal(raw, &value) == nil {
					entry[field] = value
				}
			}
			return b.mutateModelConfig(w, r, key, entry, false)
		}
		return b.handleModelConfigurationRead(w, r, body)
	}
	if _, err := b.requireAdmin(r, true); err != nil {
		return err
	}
	if r.Method == http.MethodDelete {
		body, err := decodeObject(r)
		if err != nil {
			return err
		}
		key := rawString(body, "configKey", "modelId")
		if key == "" {
			return invalid("configKey is required")
		}
		return b.mutateModelConfig(w, r, key, nil, true)
	}
	if err := r.ParseMultipartForm(8 << 20); err != nil {
		return invalid("Invalid multipart request")
	}
	category := r.FormValue("category")
	key := strings.TrimSpace(r.FormValue("configKey"))
	if key == "" || (category != "image" && category != "video") {
		return invalid("模型配置参数无效")
	}
	entry := map[string]any{"configKey": key}
	for _, field := range []string{"enabled", "visible", "homepageVisible", "homepagePriority", "description", "iconKey", "isCustom", "supportedResolutions", "supportsQuality", "maxReferenceImages", "billingMode", "creditsPerSecondByResolution", "creditsPerItemByResolution", "outputSizesByResolution"} {
		if v := r.FormValue(field); v != "" {
			var x any = v
			if v == "true" || v == "false" {
				x = v == "true"
			} else if n, e := strconv.ParseInt(v, 10, 64); e == nil {
				x = n
			} else if strings.HasPrefix(v, "{") || strings.HasPrefix(v, "[") {
				_ = json.Unmarshal([]byte(v), &x)
			}
			entry[field] = x
		}
	}
	entry["category"] = category
	return b.mutateModelConfig(w, r, key, entry, false)
}

func (b *backend) mutateModelConfig(w http.ResponseWriter, r *http.Request, key string, entry map[string]any, remove bool) error {
	var raw []byte
	err := b.db.QueryRow(r.Context(), `SELECT value FROM system_setting WHERE key='MODEL_MARKETPLACE_CONFIG'`).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		raw = []byte(`{"version":2,"imageByModel":{},"videoByFamily":{},"customModels":[]}`)
	} else if err != nil {
		return err
	}
	var cfg map[string]any
	if json.Unmarshal(raw, &cfg) != nil {
		cfg = map[string]any{"version": 2}
	}
	if _, ok := cfg["imageByModel"]; !ok {
		cfg["imageByModel"] = map[string]any{}
	}
	if _, ok := cfg["videoByFamily"]; !ok {
		cfg["videoByFamily"] = map[string]any{}
	}
	cat := "image"
	if entry != nil {
		if c, ok := entry["category"].(string); ok {
			cat = c
		}
	}
	section := "imageByModel"
	if cat == "video" {
		section = "videoByFamily"
	}
	items, ok := cfg[section].(map[string]any)
	if !ok {
		items = map[string]any{}
	}
	if remove {
		delete(items, key)
	} else {
		previous, _ := items[key].(map[string]any)
		if previous == nil {
			previous = map[string]any{"revision": int64(0), "visible": true, "description": "", "cover": nil}
		}
		for k, v := range entry {
			if k != "configKey" && k != "category" {
				previous[k] = v
			}
		}
		var rev int64
		if n, ok := previous["revision"].(float64); ok {
			rev = int64(n)
		}
		if n, ok := previous["revision"].(int64); ok {
			rev = n
		}
		previous["revision"] = rev + 1
		if _, ok := previous["visible"]; !ok {
			previous["visible"] = true
		}
		if _, ok := previous["description"]; !ok {
			previous["description"] = ""
		}
		if _, ok := previous["cover"]; !ok {
			previous["cover"] = nil
		}
		items[key] = previous
	}
	cfg[section] = items
	cfg["version"] = 2
	updated, _ := json.Marshal(cfg)
	_, err = b.db.Exec(r.Context(), `INSERT INTO system_setting(key,value,is_secret,updated_at) VALUES('MODEL_MARKETPLACE_CONFIG',$1,false,now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`, updated)
	if err != nil {
		return err
	}
	noStore(w)
	writeJSON(w, http.StatusOK, map[string]any{"category": cat, "configKey": key, "revision": time.Now().Unix()})
	return nil
}

func (b *backend) handleExportDownload(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireAdmin(r, false)
	if err != nil {
		return err
	}
	id := r.PathValue("taskId")
	if id == "" {
		return invalid("taskId is required")
	}
	var owner, status, bucket, key, exportType string
	var expires *time.Time
	err = b.db.QueryRow(r.Context(), `SELECT created_by,status,COALESCE(object_bucket,''),COALESCE(object_key,''),export_type,expires_at FROM operations_export_task WHERE id=$1`, id).Scan(&owner, &status, &bucket, &key, &exportType, &expires)
	if errors.Is(err, pgx.ErrNoRows) {
		return &apiError{404, "NOT_FOUND", "任务不存在"}
	}
	if err != nil {
		return err
	}
	if s.User.Role != "admin" && s.User.Role != "super_admin" && owner != s.User.ID {
		return forbidden()
	}
	if status != "completed" || bucket == "" || key == "" || (expires != nil && expires.Before(time.Now())) {
		return &apiError{409, "CONFLICT", "导出不可用"}
	}
	if filepath.IsAbs(key) || filepath.Clean(key) != key || strings.Contains(key, "..") {
		return &apiError{409, "CONFLICT", "导出不可用"}
	}
	data, err := os.ReadFile(filepath.Join(b.config.storagePath, bucket, filepath.FromSlash(key)))
	if os.IsNotExist(err) {
		return &apiError{404, "NOT_FOUND", "导出文件不存在"}
	}
	if err != nil {
		return err
	}
	filename := fmt.Sprintf("operations-%s-%s.csv", exportType, id)
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, err = w.Write(data)
	return err
}
