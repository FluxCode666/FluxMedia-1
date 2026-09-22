package main

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
	"unicode"
)

// registerSystemSettingsRoutes exposes the settings actions used by the admin UI.
func (b *backend) registerSystemSettingsRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/system-settings", b.endpoint(b.handleSystemSettingsGet))
	mux.HandleFunc("PUT /api/system-settings", b.endpoint(b.handleSystemSettingsUpdate))
	mux.HandleFunc("POST /api/system-settings/import-env", b.endpoint(b.handleSystemSettingsImportEnv))
	mux.HandleFunc("POST /api/system-settings/initialize-defaults", b.endpoint(b.handleSystemSettingsInitializeDefaults))
	mux.HandleFunc("PUT /api/system-settings/site-logo", b.endpoint(b.handleSystemSettingsSiteLogo))
	mux.HandleFunc("GET /api/system-settings/model-pricing", b.endpoint(b.handleSystemModelPricing))
	mux.HandleFunc("GET /api/system-settings/site-branding", b.endpoint(b.handleSystemSiteBranding))
	mux.HandleFunc("GET /api/system-settings/value", b.endpoint(b.handleSystemSettingValue))
	mux.HandleFunc("GET /api/system-settings/bootstrap", b.endpoint(b.handleSystemSettingsBootstrap))
	mux.HandleFunc("POST /api/system-settings/sync-env", b.endpoint(b.handleSystemSettingsSyncEnv))
	mux.HandleFunc("GET /api/system-settings/moderation-policy", b.endpoint(b.handleSystemModerationPolicyGet))
	mux.HandleFunc("PUT /api/system-settings/moderation-policy", b.endpoint(b.handleSystemModerationPolicyPut))
	mux.HandleFunc("GET /api/pagination/config", b.endpoint(b.handlePaginationConfig))
}

// handleSystemSiteBranding is the public, narrow branding projection used by
// settings.getSiteBranding. It deliberately does not expose the full setting
// snapshot or any secret values.
func (b *backend) handleSystemSiteBranding(w http.ResponseWriter, r *http.Request) error {
	logo, err := b.settingString(r.Context(), "SITE_LOGO_URL", "/assets/icon.svg")
	if err != nil {
		return err
	}
	if logo == "" || (!strings.HasPrefix(logo, "/") && !strings.HasPrefix(logo, "https://")) {
		logo = "/assets/icon.svg"
	}
	noStore(w)
	writeJSON(w, http.StatusOK, map[string]any{"logoUrl": logo})
	return nil
}

// handleSystemSettingValue is an internal read projection. Callers must use
// the cron credential or an authenticated administrator; arbitrary keys are
// still returned as JSON values and never as raw secret metadata.
func (b *backend) handleSystemSettingValue(w http.ResponseWriter, r *http.Request) error {
	if !b.cronAuthorized(r) {
		if _, err := b.requireAdmin(r, true); err != nil {
			return err
		}
	}
	key := strings.TrimSpace(r.URL.Query().Get("key"))
	canonical := key
	if alias := map[string]string{"MODEL_MARKETPLACE_ASSETS_BUCKET_NAME": "SYSTEM_ASSETS_BUCKET_NAME", "SITE_ASSETS_BUCKET_NAME": "SYSTEM_ASSETS_BUCKET_NAME", "NEXT_PUBLIC_AVATARS_BUCKET_NAME": "SYSTEM_ASSETS_BUCKET_NAME", "NEXT_PUBLIC_GENERATIONS_BUCKET_NAME": "GENERATIONS_BUCKET_NAME"}[key]; alias != "" {
		canonical = alias
	}
	if _, ok := systemSettingDefinitionByKey[canonical]; !ok {
		return invalid("未知系统设置")
	}
	stored, err := readSystemSettings(r.Context(), b.db)
	if err != nil {
		return err
	}
	var value any
	source := "default"
	if row, ok := stored[canonical]; ok && configuredSetting(row.Value) {
		value = row.Value
		source = "cache"
	} else if env := strings.TrimSpace(os.Getenv(canonical)); env != "" {
		value = env
		source = "database"
	}
	noStore(w)
	writeJSON(w, http.StatusOK, map[string]any{"key": key, "value": value, "source": source})
	return nil
}

func (b *backend) handleSystemSettingsBootstrap(w http.ResponseWriter, r *http.Request) error {
	if !b.cronAuthorized(r) {
		if _, err := b.requireAdmin(r, true); err != nil {
			return err
		}
	}
	result, err := b.bootstrapSettings(r.Context())
	if err != nil {
		return err
	}
	noStore(w)
	writeJSON(w, http.StatusOK, result)
	return nil
}

func (b *backend) handleSystemSettingsSyncEnv(w http.ResponseWriter, r *http.Request) error {
	if !b.cronAuthorized(r) {
		if _, err := b.requireAdmin(r, true); err != nil {
			return err
		}
	}
	var in struct {
		TargetPath string `json:"targetPath"`
	}
	if r.Body != http.NoBody && r.ContentLength != 0 {
		if err := decodeBody(r, &in); err != nil {
			return err
		}
	}
	values, err := readSystemSettings(r.Context(), b.db)
	if err != nil {
		return err
	}
	files, err := syncSettingsEnvFiles(values, in.TargetPath)
	if err != nil {
		return err
	}
	first := ""
	if len(files) > 0 {
		first = files[0]
	}
	noStore(w)
	writeJSON(w, http.StatusOK, map[string]any{"syncedCount": len(files), "filePath": first, "files": files})
	return nil
}

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
	stored, err := readSystemSettings(r.Context(), b.db)
	if err != nil {
		return err
	}
	for _, key := range []string{"IMAGE_MODEL_CREDIT_PRICES", "VIDEO_MODEL_BILLING_MODES", "VIDEO_MODEL_CREDITS_PER_ITEM", "VIDEO_MODEL_CREDITS_PER_SECOND"} {
		if !configuredSetting(stored[key].Value) {
			if text := strings.TrimSpace(os.Getenv(key)); text != "" {
				var value any
				if json.Unmarshal([]byte(text), &value) == nil {
					stored[key] = storedSystemSetting{Value: value}
				}
			}
		}
	}
	modes, items, seconds, err := normalizedSettingsVideoPricing(stored)
	if err != nil {
		return err
	}
	noStore(w)
	writeJSON(w, http.StatusOK, map[string]any{"image": normalizedSettingsImagePricing(stored), "videoBillingModes": modes, "videoCreditsPerItem": items, "videoCreditsPerSecond": seconds})
	return nil
}

func (b *backend) handleSystemSettingsGet(w http.ResponseWriter, r *http.Request) error {
	if _, err := b.requireAdmin(r, true); err != nil {
		return err
	}
	stored, err := readSystemSettings(r.Context(), b.db)
	if err != nil {
		return err
	}
	noStore(w)
	writeJSON(w, http.StatusOK, map[string]any{"settings": systemSettingsSnapshot(stored, os.LookupEnv), "timestamp": time.Now().UTC().Format(time.RFC3339Nano)})
	return nil
}

func (b *backend) handleSystemSettingsUpdate(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireAdmin(r, true)
	if err != nil {
		return err
	}
	var in struct {
		Settings []systemSettingUpdate `json:"settings"`
	}
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	changed, err := b.updateSystemSettings(r.Context(), in.Settings, s.User.ID)
	if err != nil {
		return err
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
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	keys, skipped, err := b.importSettingsEnv(r.Context(), s.User.ID, in.Overwrite)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "importedKeys": keys, "importedCount": len(keys), "skippedCount": skipped, "message": "环境变量配置已导入"})
	return nil
}

func (b *backend) handleSystemSettingsInitializeDefaults(w http.ResponseWriter, r *http.Request) error {
	actor := ""
	if !b.cronAuthorized(r) {
		s, err := b.requireAdmin(r, true)
		if err != nil {
			return err
		}
		actor = s.User.ID
	}
	keys, err := b.initializeSettingsDefaults(r.Context(), actor)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "initializedKeys": keys, "initializedCount": len(keys), "message": "默认配置已补齐"})
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
	if in.LogoURL != nil && *in.LogoURL != "" {
		logo := strings.TrimSpace(*in.LogoURL)
		valid := len(logo) <= 2048 && strings.IndexFunc(logo, unicode.IsSpace) < 0 && !strings.Contains(logo, `\`)
		if strings.HasPrefix(logo, "/") {
			valid = valid && !strings.HasPrefix(logo, "//")
		} else {
			parsed, parseErr := url.Parse(logo)
			valid = valid && parseErr == nil && parsed.Scheme == "https" && parsed.Host != "" && parsed.User == nil
		}
		if !valid {
			return invalid("logoUrl 无效")
		}
		in.LogoURL = &logo
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
	value := "/assets/icon.svg"
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
