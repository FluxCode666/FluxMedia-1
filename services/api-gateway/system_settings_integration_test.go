//go:build integration

package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func isolatedSettingsBackend(t *testing.T) *backend {
	t.Helper()
	b := integrationBackend(t)
	for _, d := range systemSettingDefinitions {
		t.Setenv(d.Key, "")
	}
	if _, err := b.db.Exec(context.Background(), `DELETE FROM system_setting`); err != nil {
		t.Fatal(err)
	}
	return b
}
func settingsMaintenanceRequest(t *testing.T, b *backend, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer settings-test-secret")
	r.Header.Set("Content-Type", "application/json")
	b.config.cronSecret = "settings-test-secret"
	w := httptest.NewRecorder()
	b.handler().ServeHTTP(w, r)
	return w
}
func TestSettingsInitializeAndBootstrapPersistRealValues(t *testing.T) {
	b := isolatedSettingsBackend(t)
	ctx := context.Background()
	if _, err := b.db.Exec(ctx, `INSERT INTO system_setting(key,value) VALUES('NEXT_PUBLIC_APP_NAME','"Existing Name"'),('CONTENT_MODERATION_BLOCK_RISK_LEVEL','"medium"')`); err != nil {
		t.Fatal(err)
	}
	w := settingsMaintenanceRequest(t, b, "POST", "/api/system-settings/initialize-defaults", "{}")
	if w.Code != 200 {
		_, detail := b.initializeSettingsDefaults(ctx, "")
		t.Fatalf("initialize failed: %d %s (%v)", w.Code, w.Body.String(), detail)
	}
	var initialized struct {
		Count int      `json:"initializedCount"`
		Keys  []string `json:"initializedKeys"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &initialized); err != nil {
		t.Fatal(err)
	}
	if initialized.Count != len(initialized.Keys) || initialized.Count < 50 {
		t.Fatalf("not initialized: %+v", initialized)
	}
	stored, err := readSystemSettings(ctx, b.db)
	if err != nil {
		t.Fatal(err)
	}
	if stored["NEXT_PUBLIC_APP_NAME"].Value != "Existing Name" || stored["CONTENT_MODERATION_BLOCK_RISK_LEVEL"].Value != "medium" {
		t.Fatal("existing overrides overwritten")
	}
	if stored["IMAGE_GENERATION_DEFAULT_USER_CONCURRENCY"].Value != float64(20) || stored["BETTER_AUTH_SECRET"].Value != nil {
		t.Fatal("defaults or secret exclusion mismatch")
	}
	w = settingsMaintenanceRequest(t, b, "POST", "/api/system-settings/initialize-defaults", "{}")
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if err := json.Unmarshal(w.Body.Bytes(), &initialized); err != nil {
		t.Fatal(err)
	}
	if initialized.Count != 0 {
		t.Fatal("repeat default initialization was not idempotent")
	}
	t.Setenv("SMTP_PORT", "2525")
	t.Setenv("SMTP_PASS", "test-only-smtp-secret")
	w = settingsMaintenanceRequest(t, b, "GET", "/api/system-settings/bootstrap", "")
	if w.Code != 200 {
		t.Fatalf("bootstrap failed: %d %s", w.Code, w.Body.String())
	}
	var boot struct {
		Loaded   int `json:"loadedCount"`
		Imported int `json:"importedCount"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &boot); err != nil {
		t.Fatal(err)
	}
	if boot.Loaded < 50 || boot.Imported != 1 {
		t.Fatalf("bootstrap did not preserve existing/default port and import secret: %+v", boot)
	}
	stored, err = readSystemSettings(ctx, b.db)
	if err != nil {
		t.Fatal(err)
	}
	if stored["SMTP_PASS"].Value != "test-only-smtp-secret" || !stored["SMTP_PASS"].Secret {
		t.Fatal("bootstrap did not persist environment credential with secret metadata")
	}
	if strings.Contains(w.Body.String(), "test-only-smtp-secret") {
		t.Fatal("bootstrap leaks credential")
	}
}
func TestSettingsEnvironmentImportAndUpdateAreTypedAtomicAndProtected(t *testing.T) {
	b := isolatedSettingsBackend(t)
	ctx := context.Background()
	id, email := seedAuthUser(t, b)
	cookie := signInTestUser(t, b, email)
	for _, path := range []string{"/api/system-settings", "/api/system-settings/value?key=SMTP_PASS"} {
		w := authRequest(t, b, "GET", path, "", cookie)
		if w.Code != 403 {
			t.Fatalf("ordinary user read %s: %d", path, w.Code)
		}
	}
	if _, err := b.db.Exec(ctx, `UPDATE "user" SET role='super_admin' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SMTP_PORT", "2525")
	t.Setenv("SMTP_PASS", "first-secret")
	t.Setenv("SITE_LOGO_URL", "https://dedicated.invalid/logo.svg")
	w := authRequest(t, b, "POST", "/api/system-settings/import-env", `{"overwrite":false}`, cookie)
	if w.Code != 200 {
		_, _, detail := b.importSettingsEnv(ctx, id, false)
		t.Fatalf("env import failed %d %s (%v)", w.Code, w.Body.String(), detail)
	}
	var imported struct {
		Count   int `json:"importedCount"`
		Skipped int `json:"skippedCount"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &imported); err != nil {
		t.Fatal(err)
	}
	if imported.Count != 2 {
		t.Fatalf("new environment keys not imported: %+v", imported)
	}
	stored, err := readSystemSettings(ctx, b.db)
	if err != nil {
		t.Fatal(err)
	}
	if stored["SMTP_PORT"].Value != float64(2525) || !stored["SMTP_PASS"].Secret || stored["SITE_LOGO_URL"].Value != nil {
		t.Fatal("type/secret/dedicated key import failed")
	}
	t.Setenv("SMTP_PASS", "replacement-secret")
	w = authRequest(t, b, "POST", "/api/system-settings/import-env", `{"overwrite":false}`, cookie)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	json.Unmarshal(w.Body.Bytes(), &imported)
	if imported.Count != 0 || imported.Skipped != 2 {
		t.Fatal("non-overwrite import overwrote settings")
	}
	w = authRequest(t, b, "PUT", "/api/system-settings", `{"settings":[{"key":"SMTP_PASS","value":""},{"key":"SMTP_PORT","value":"2526"}]}`, cookie)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	stored, _ = readSystemSettings(ctx, b.db)
	if stored["SMTP_PASS"].Value != "first-secret" || stored["SMTP_PORT"].Value != float64(2526) {
		t.Fatal("blank secret preservation failed")
	}
	w = authRequest(t, b, "PUT", "/api/system-settings", `{"settings":[{"key":"SMTP_PORT","value":"2527"},{"key":"UNKNOWN_SETTING","value":"x"}]}`, cookie)
	if w.Code != 400 {
		t.Fatalf("invalid batch accepted %d", w.Code)
	}
	stored, _ = readSystemSettings(ctx, b.db)
	if stored["SMTP_PORT"].Value != float64(2526) {
		t.Fatal("invalid batch partially committed")
	}
	w = authRequest(t, b, "GET", "/api/system-settings", "", cookie)
	if w.Code != 200 || strings.Contains(w.Body.String(), "first-secret") || strings.Contains(w.Body.String(), "replacement-secret") {
		t.Fatal("snapshot status or secret masking failed")
	}
	w = authRequest(t, b, "PUT", "/api/system-settings", `{"settings":[{"key":"SMTP_PASS","clear":true}]}`, cookie)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	stored, _ = readSystemSettings(ctx, b.db)
	if _, exists := stored["SMTP_PASS"]; exists {
		t.Fatal("explicit secret clear failed")
	}
}
func TestSettingsSyncEnvironmentEndpointWritesRequestedFile(t *testing.T) {
	b := isolatedSettingsBackend(t)
	if _, err := b.db.Exec(context.Background(), `INSERT INTO system_setting(key,value) VALUES('NEXT_PUBLIC_APP_NAME','"Synced Name"')`); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), ".env.local")
	body, _ := json.Marshal(map[string]string{"targetPath": target})
	w := settingsMaintenanceRequest(t, b, "POST", "/api/system-settings/sync-env", string(body))
	if w.Code != http.StatusOK {
		t.Fatalf("sync failed %d %s", w.Code, w.Body.String())
	}
	var out struct {
		Count int    `json:"syncedCount"`
		Path  string `json:"filePath"`
	}
	json.Unmarshal(w.Body.Bytes(), &out)
	if out.Count != 1 || out.Path != target {
		t.Fatalf("sync does not report real file: %+v", out)
	}
	contents, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(contents), `NEXT_PUBLIC_APP_NAME="Synced Name"`) {
		t.Fatal("requested file was not written")
	}
}

func TestSettingsDefaultInitializationMigratesLegacyOverrides(t *testing.T) {
	b := isolatedSettingsBackend(t)
	ctx := context.Background()
	fixtures := map[string]any{
		"MODEL_MARKETPLACE_ASSETS_BUCKET_NAME": "public-assets", "SITE_ASSETS_BUCKET_NAME": "public-assets", "NEXT_PUBLIC_AVATARS_BUCKET_NAME": "avatars", "NEXT_PUBLIC_GENERATIONS_BUCKET_NAME": "old-outputs",
		"VIDEO_BASE_CREDITS_PER_SECOND": float64(30), "VIDEO_MODEL_MULTIPLIERS": map[string]any{"sora2-pro": float64(2), "veo31-fast": float64(0.5)},
		"IMAGE_MODEL_CREDIT_PRICES": map[string]any{"version": float64(1), "byModel": map[string]any{"default": map[string]any{"base1024Credits": float64(2), "base1kCredits": float64(3), "base2kCredits": float64(6), "base4kCredits": float64(11)}, "custom-image": map[string]any{"base2kCredits": float64(8)}}},
	}
	for key, value := range fixtures {
		raw, _ := json.Marshal(value)
		if _, err := b.db.Exec(ctx, `INSERT INTO system_setting(key,value) VALUES($1,$2)`, key, raw); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := b.initializeSettingsDefaults(ctx, ""); err != nil {
		t.Fatal(err)
	}
	stored, err := readSystemSettings(ctx, b.db)
	if err != nil {
		t.Fatal(err)
	}
	if stored["SYSTEM_ASSETS_BUCKET_NAME"].Value != "public-assets" || stored["GENERATIONS_BUCKET_NAME"].Value != "old-outputs" {
		t.Fatal("legacy storage settings not preserved")
	}
	if _, exists := stored["NEXT_PUBLIC_GENERATIONS_BUCKET_NAME"]; !exists {
		t.Fatal("legacy storage rollback value removed")
	}
	if _, exists := stored["VIDEO_MODEL_MULTIPLIERS"]; exists {
		t.Fatal("legacy multiplier was not retired")
	}
	seconds := settingObject(stored["VIDEO_MODEL_CREDITS_PER_SECOND"].Value)
	if seconds["sora2-pro"] != float64(60) || seconds["veo31-fast@720p"] != float64(15) {
		t.Fatal("legacy video prices not migrated")
	}
	models := settingObject(settingObject(stored["IMAGE_MODEL_CREDIT_PRICES"].Value)["byModel"])
	if models["default"] != nil || settingObject(models["custom-image"])["base2kCredits"] != float64(8) || settingObject(models["gpt-image-2"])["base4kCredits"] != float64(11) {
		t.Fatal("legacy image matrix migration lost prices")
	}
	repeated, err := b.initializeSettingsDefaults(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(repeated) != 0 {
		t.Fatalf("compatibility migration repeats: %v", repeated)
	}
}
