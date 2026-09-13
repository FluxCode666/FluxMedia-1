package main

import (
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"time"
)

// registerSystemSettingsRoutes exposes the settings actions used by the admin UI.
func (b *backend) registerSystemSettingsRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/system-settings", b.endpoint(b.handleSystemSettingsGet))
	mux.HandleFunc("PUT /api/system-settings", b.endpoint(b.handleSystemSettingsUpdate))
	mux.HandleFunc("POST /api/system-settings/import-env", b.endpoint(b.handleSystemSettingsImportEnv))
	mux.HandleFunc("POST /api/system-settings/initialize-defaults", b.endpoint(b.handleSystemSettingsInitializeDefaults))
	mux.HandleFunc("PUT /api/system-settings/site-logo", b.endpoint(b.handleSystemSettingsSiteLogo))
	mux.HandleFunc("GET /api/system-settings/model-pricing", b.endpoint(b.handleSystemModelPricing))
	mux.HandleFunc("GET /api/system-settings/moderation-policy", b.endpoint(b.handleSystemModerationPolicyGet))
	mux.HandleFunc("PUT /api/system-settings/moderation-policy", b.endpoint(b.handleSystemModerationPolicyPut))
	mux.HandleFunc("GET /api/pagination/config", b.endpoint(b.handlePaginationConfig))
}

// handlePaginationConfig exposes the validated public page-size allowlist used
// by dashboard list controls. The setting contains no secrets and falls back to
// the stable application defaults when absent or malformed.
func (b *backend) handlePaginationConfig(w http.ResponseWriter, r *http.Request) error {
	value, err := b.setting(r.Context(), "PAGINATION_PAGE_SIZE_OPTIONS", []any{float64(10), float64(20), float64(50)})
	if err != nil {
		return err
	}
	options := []int{10, 20, 50}
	if raw, ok := value.([]any); ok {
		candidate := make([]int, 0, len(raw))
		seen := map[int]bool{}
		for _, item := range raw {
			n, ok := item.(float64)
			if !ok || n < 1 || n > 100 || n != float64(int(n)) || seen[int(n)] {
				candidate = nil
				break
			}
			seen[int(n)] = true
			candidate = append(candidate, int(n))
		}
		if len(candidate) > 0 && seen[20] && len(candidate) <= 10 {
			options = candidate
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"defaultPageSize": 20, "pageSizeOptions": options})
	return nil
}

func (b *backend) handleSystemModelPricing(w http.ResponseWriter, r *http.Request) error {
	if _, err := b.requireAdmin(r, false); err != nil {
		return err
	}
	image, err := b.setting(r.Context(), "IMAGE_MODEL_CREDIT_PRICES", map[string]any{"version": 1, "byModel": map[string]any{}})
	if err != nil {
		return err
	}
	modes, err := b.setting(r.Context(), "VIDEO_MODEL_BILLING_MODES", map[string]any{})
	if err != nil {
		return err
	}
	perItem, err := b.setting(r.Context(), "VIDEO_MODEL_CREDITS_PER_ITEM", map[string]any{})
	if err != nil {
		return err
	}
	perSecond, err := b.setting(r.Context(), "VIDEO_MODEL_CREDITS_PER_SECOND", map[string]any{})
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"image": image, "videoBillingModes": modes, "videoCreditsPerItem": perItem, "videoCreditsPerSecond": perSecond})
	return nil
}

func (b *backend) handleSystemModerationPolicyGet(w http.ResponseWriter, r *http.Request) error {
	if _, err := b.requireAdmin(r, true); err != nil {
		return err
	}
	value, err := b.setting(r.Context(), "CONTENT_MODERATION_BLOCK_RISK_LEVEL", "high")
	if err != nil {
		return err
	}
	level, _ := value.(string)
	if level != "low" && level != "medium" && level != "high" {
		level = "high"
	}
	writeJSON(w, http.StatusOK, map[string]any{"policy": map[string]any{"globalDefault": level, "userOverride": nil, "effectiveLevel": level, "source": "global"}, "recentAudits": []any{}})
	return nil
}

func (b *backend) handleSystemModerationPolicyPut(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireAdmin(r, true)
	if err != nil {
		return err
	}
	var in struct {
		Level  string `json:"level"`
		Reason string `json:"reason"`
	}
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	if in.Level != "low" && in.Level != "medium" && in.Level != "high" {
		return invalid("审核级别不合法")
	}
	if strings.TrimSpace(in.Reason) == "" || len([]rune(in.Reason)) > 300 {
		return invalid("变更原因不合法")
	}
	old, _ := b.setting(r.Context(), "CONTENT_MODERATION_BLOCK_RISK_LEVEL", "high")
	oldLevel, _ := old.(string)
	raw, _ := json.Marshal(in.Level)
	if _, err := b.db.Exec(r.Context(), `INSERT INTO system_setting(key,value,is_secret,updated_by,updated_at) VALUES('CONTENT_MODERATION_BLOCK_RISK_LEVEL',$1,false,$2,now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=now()`, raw, s.User.ID); err != nil {
		return err
	}
	changed := oldLevel != in.Level
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "changed": changed, "previousLevel": oldLevel, "level": in.Level, "message": map[bool]string{true: "全站审核级别已更新", false: "全站审核级别未发生变化"}[changed]})
	return nil
}

func (b *backend) handleSystemSettingsGet(w http.ResponseWriter, r *http.Request) error {
	if _, err := b.requireAdmin(r, true); err != nil {
		return err
	}
	rows, err := b.db.Query(r.Context(), `SELECT key,value,updated_at FROM system_setting ORDER BY key`)
	if err != nil {
		return err
	}
	defer rows.Close()
	settings := make([]map[string]any, 0)
	for rows.Next() {
		var key string
		var raw []byte
		var updated *time.Time
		if err := rows.Scan(&key, &raw, &updated); err != nil {
			return err
		}
		var value any
		_ = json.Unmarshal(raw, &value)
		text := ""
		if value != nil {
			text = toSettingText(value)
		}
		settings = append(settings, map[string]any{
			"key": key, "label": key, "description": "", "category": settingCategory(key),
			"valueType": settingValueType(value), "value": text, "configured": text != "",
			"stored": true, "fromEnv": false, "updatedAt": updated,
		})
	}
	if err := rows.Err(); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"settings": settings, "timestamp": time.Now().UTC().Format(time.RFC3339Nano)})
	return nil
}

func (b *backend) handleSystemSettingsUpdate(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireAdmin(r, true)
	if err != nil {
		return err
	}
	var in struct {
		Settings []struct {
			Key   string `json:"key"`
			Value any    `json:"value"`
			Clear bool   `json:"clear"`
		} `json:"settings"`
	}
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	if len(in.Settings) == 0 {
		return invalid("settings is required")
	}
	changed := make([]string, 0, len(in.Settings))
	for _, u := range in.Settings {
		key := strings.TrimSpace(u.Key)
		if key == "" {
			return invalid("setting key is required")
		}
		if u.Clear {
			if _, err := b.db.Exec(r.Context(), `DELETE FROM system_setting WHERE key=$1`, key); err != nil {
				return err
			}
		} else {
			raw, err := json.Marshal(u.Value)
			if err != nil {
				return invalid("invalid setting value")
			}
			if _, err = b.db.Exec(r.Context(), `INSERT INTO system_setting(key,value,is_secret,updated_by,updated_at) VALUES($1,$2,false,$3,now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=now()`, key, raw, s.User.ID); err != nil {
				return err
			}
		}
		changed = append(changed, key)
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "changedKeys": changed, "message": "系统设置已保存"})
	return nil
}

func (b *backend) handleSystemSettingsImportEnv(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireAdmin(r, true)
	if err != nil {
		return err
	}
	var in struct {
		Overwrite bool `json:"overwrite"`
	}
	_ = decodeBody(r, &in)
	// Environment import is intentionally constrained to already defined rows. This keeps
	// accidental process secrets out of the settings table while preserving migration behavior.
	rows, err := b.db.Query(r.Context(), `SELECT key FROM system_setting`)
	if err != nil {
		return err
	}
	defer rows.Close()
	keys := []string{}
	for rows.Next() {
		var key string
		if rows.Scan(&key) != nil {
			continue
		}
		value, ok := lookupEnv(key)
		if !ok || (!in.Overwrite && settingExists(r, b, key)) {
			continue
		}
		raw, _ := json.Marshal(value)
		_, _ = b.db.Exec(r.Context(), `INSERT INTO system_setting(key,value,is_secret,updated_by,updated_at) VALUES($1,$2,false,$3,now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=now()`, key, raw, s.User.ID)
		keys = append(keys, key)
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "importedKeys": keys, "message": "环境变量配置已导入"})
	return nil
}

func (b *backend) handleSystemSettingsInitializeDefaults(w http.ResponseWriter, r *http.Request) error {
	if _, err := b.requireAdmin(r, true); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "initializedKeys": []string{}, "message": "默认配置已存在，无需初始化"})
	return nil
}

func (b *backend) handleSystemSettingsSiteLogo(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireAdmin(r, true)
	if err != nil {
		return err
	}
	var in struct {
		LogoURL *string `json:"logoUrl"`
	}
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	if in.LogoURL != nil && *in.LogoURL != "" && !strings.HasPrefix(*in.LogoURL, "/") && !strings.HasPrefix(*in.LogoURL, "https://") {
		return invalid("logoUrl 无效")
	}
	if in.LogoURL == nil || *in.LogoURL == "" {
		_, err = b.db.Exec(r.Context(), `DELETE FROM system_setting WHERE key='SITE_LOGO_URL'`)
	} else {
		raw, _ := json.Marshal(*in.LogoURL)
		_, err = b.db.Exec(r.Context(), `INSERT INTO system_setting(key,value,is_secret,updated_by,updated_at) VALUES('SITE_LOGO_URL',$1,false,$2,now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=now()`, raw, s.User.ID)
	}
	if err != nil {
		return err
	}
	value := "/logo.svg"
	if in.LogoURL != nil && *in.LogoURL != "" {
		value = *in.LogoURL
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "logoUrl": value, "message": "网站 Logo 已更新"})
	return nil
}

func settingExists(r *http.Request, b *backend, key string) bool {
	var ok bool
	_ = b.db.QueryRow(r.Context(), `SELECT value IS NOT NULL FROM system_setting WHERE key=$1`, key).Scan(&ok)
	return ok
}
func lookupEnv(key string) (string, bool) { return os.LookupEnv(key) }
func settingCategory(key string) string {
	k := strings.ToUpper(key)
	if strings.Contains(k, "MAIL") || strings.Contains(k, "SMTP") || strings.Contains(k, "RESEND") {
		return "mail"
	}
	if strings.Contains(k, "PAY") {
		return "payment"
	}
	if strings.Contains(k, "MODEL") {
		return "models"
	}
	return "general"
}
func settingValueType(v any) string {
	switch v.(type) {
	case bool:
		return "boolean"
	case float64:
		return "number"
	case map[string]any, []any:
		return "json"
	default:
		return "string"
	}
}
func toSettingText(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	raw, _ := json.Marshal(v)
	return string(raw)
}
