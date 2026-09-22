package main

// Native implementations for the remaining administrative HTTP adapters.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
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

// modelConfigurationRead projects current Go settings and executable model catalog.
func (b *backend) modelConfigurationRead(r *http.Request, canEdit bool) (map[string]any, error) {
	catalog, err := b.loadNativeModelCatalog(r)
	if err != nil {
		return nil, err
	}
	return nativeModelConfigurationSnapshot(catalog, canEdit)
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

func (b *backend) handleExportDownload(w http.ResponseWriter, r *http.Request) error {
	return b.downloadOperationsExport(w, r)
}
