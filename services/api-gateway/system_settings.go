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
