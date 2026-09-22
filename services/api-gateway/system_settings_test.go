package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSettingsSnapshotIncludesMissingDefinitionsAndMasksCredentials(t *testing.T) {
	stored := map[string]storedSystemSetting{"NEXT_PUBLIC_APP_NAME": {Value: "Custom Name"}, "BETTER_AUTH_SECRET": {Value: "db-secret"}, "UNKNOWN_SECRET": {Value: "must-not-leak"}, "SITE_LOGO_URL": {Value: nil}}
	env := func(key string) (string, bool) {
		v, ok := map[string]string{"NEXT_PUBLIC_APP_URL": "https://example.com", "SMTP_PASS": "env-secret", "SITE_LOGO_URL": "https://ignored.example/logo.svg"}[key]
		return v, ok
	}
	items := systemSettingsSnapshot(stored, env)
	if len(items) != len(systemSettingDefinitions) || len(items) < 100 {
		t.Fatalf("incomplete definitions: %d", len(items))
	}
	byKey := map[string]adminSettingSnapshot{}
	for _, item := range items {
		byKey[item.Key] = item
	}
	if byKey["BETTER_AUTH_SECRET"].Value != "" || !byKey["BETTER_AUTH_SECRET"].Configured || !byKey["BETTER_AUTH_SECRET"].Secret {
		t.Fatal("stored secret is not masked with configuration state")
	}
	if byKey["SMTP_PASS"].Value != "" || !byKey["SMTP_PASS"].FromEnv || !byKey["SMTP_PASS"].Configured {
		t.Fatal("environment secret is not masked")
	}
	if byKey["NEXT_PUBLIC_APP_NAME"].Value != "Custom Name" || !byKey["NEXT_PUBLIC_APP_NAME"].Stored {
		t.Fatal("stored override lost")
	}
	if !byKey["NEXT_PUBLIC_APP_URL"].FromEnv || byKey["NEXT_PUBLIC_APP_URL"].Value != "https://example.com" {
		t.Fatal("environment fallback lost")
	}
	logo := byKey["SITE_LOGO_URL"]
	if logo.Configured || logo.Value != "" || logo.DefaultValue != "/assets/icon.svg" {
		t.Fatal("dedicated setting uses environment or loses default metadata")
	}
	concurrency := byKey["IMAGE_GENERATION_DEFAULT_USER_CONCURRENCY"]
	if concurrency.Label == concurrency.Key || concurrency.DefaultValue == nil || concurrency.Min == nil {
		t.Fatal("label/default/range metadata missing")
	}
	encoded, _ := json.Marshal(items)
	for _, secret := range []string{"db-secret", "env-secret", "must-not-leak"} {
		if strings.Contains(string(encoded), secret) {
			t.Fatalf("snapshot leaks %s", secret)
		}
	}
}
func TestSettingsUpdateRejectsUnknownDedicatedAndInvalidRange(t *testing.T) {
	for _, input := range []string{`[{"key":"DATABASE_URL","value":"other"}]`, `[{"key":"SITE_LOGO_URL","value":"/assets/new.svg"}]`, `[{"key":"CONTENT_MODERATION_BLOCK_RISK_LEVEL","value":"low"}]`, `[{"key":"IMAGE_GENERATION_DEFAULT_USER_CONCURRENCY","value":-1}]`, `[{"key":"PAGINATION_PAGE_SIZE_OPTIONS","value":[10,50]}]`, `[{"key":"PAYMENT_PROVIDER","value":"unknown"}]`, `[{"key":"NEXT_PUBLIC_APP_NAME","value":"test","clear":true}]`} {
		var updates []systemSettingUpdate
		if err := json.Unmarshal([]byte(input), &updates); err != nil {
			t.Fatal(err)
		}
		if _, err := planSettingsUpdate(updates); err == nil {
			t.Fatalf("accepted invalid update %s", input)
		}
	}
	var input []systemSettingUpdate
	if err := json.Unmarshal([]byte(`[{"key":"SMTP_PASS","value":"  "},{"key":"SMTP_PORT","value":"2525"},{"key":"SELF_USE_MODE_ENABLED","value":"false"}]`), &input); err != nil {
		t.Fatal(err)
	}
	changes, err := planSettingsUpdate(input)
	if err != nil {
		t.Fatal(err)
	}
	if len(changes) != 2 || changes[0].Value != float64(2525) || changes[1].Value != false {
		t.Fatalf("secret preservation or coercion failed: %+v", changes)
	}
}
func TestSettingsEnvSyncWritesAndReplacesManagedBlockSafely(t *testing.T) {
	target := filepath.Join(t.TempDir(), ".env.local")
	current := "KEEP_ME=1\n" + settingsEnvBegin + "\nOLD=1\n" + settingsEnvEnd + "\nTAIL=2\n"
	if err := os.WriteFile(target, []byte(current), 0644); err != nil {
		t.Fatal(err)
	}
	values := map[string]storedSystemSetting{"NEXT_PUBLIC_APP_NAME": {Value: "Name $& $1 $`"}, "SMTP_PASS": {Value: "safe\\quote\"value"}, "RATE_LIMIT_AI_REQUESTS_PER_MINUTE": {Value: float64(20)}, "APP_TIME_ZONE": {Value: "must-not-export"}, "MODEL_MARKETPLACE_CONFIG": {Value: map[string]any{"version": 2}}, "NEXT_PUBLIC_APP_URL": {Value: "bad " + settingsEnvEnd + " suffix"}}
	files, err := syncSettingsEnvFiles(values, target)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 || files[0] != target {
		t.Fatalf("wrong target results: %v", files)
	}
	data, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	out := string(data)
	for _, want := range []string{"KEEP_ME=1", "TAIL=2", "Name $& $1 $`", `RATE_LIMIT_AI_REQUESTS_PER_MINUTE="20"`} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing preserved text %s", want)
		}
	}
	for _, bad := range []string{"OLD=1", "must-not-export", "MODEL_MARKETPLACE_CONFIG", "bad "} {
		if strings.Contains(out, bad) {
			t.Fatalf("unexpected managed setting %s", bad)
		}
	}
	if strings.Count(out, settingsEnvBegin) != 1 || strings.Count(out, settingsEnvEnd) != 1 {
		t.Fatal("corrupted managed boundary")
	}
	stat, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	if stat.Mode().Perm() != 0600 {
		t.Fatalf("settings file mode is %o", stat.Mode().Perm())
	}
	if _, err := syncSettingsEnvFiles(values, target); err != nil {
		t.Fatal(err)
	}
	again, _ := os.ReadFile(target)
	if string(again) != out {
		t.Fatal("repeated sync is not idempotent")
	}
}
func TestSettingsEnvSyncRejectsBrokenBlockInsteadOfReportingSuccess(t *testing.T) {
	target := filepath.Join(t.TempDir(), ".env.local")
	before := "KEEP=1\n" + settingsEnvBegin + "\nunterminated"
	if err := os.WriteFile(target, []byte(before), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := syncSettingsEnvFiles(map[string]storedSystemSetting{"NEXT_PUBLIC_APP_NAME": {Value: "test"}}, target); err == nil {
		t.Fatal("expected malformed target to fail")
	}
	after, _ := os.ReadFile(target)
	if string(after) != before {
		t.Fatal("failure corrupted target")
	}
}

func TestSettingsPricingDefaultsAndCustomModelCompletion(t *testing.T) {
	stored := map[string]storedSystemSetting{
		"IMAGE_BASE_CREDITS_2K":          {Value: float64(6)},
		"IMAGE_MODEL_CREDIT_PRICES":      {Value: map[string]any{"version": float64(1), "byModel": map[string]any{"vendor-image": map[string]any{"base2kCredits": float64(8)}}}},
		"VIDEO_MODEL_CREDITS_PER_SECOND": {Value: map[string]any{"vendor-video": float64(12)}},
		"MODEL_MARKETPLACE_CONFIG":       {Value: map[string]any{"customModels": []any{map[string]any{"modelId": "vendor-video", "category": "video", "supportedResolutions": []any{"720p", "1080p"}}}}},
	}
	image := normalizedSettingsImagePricing(stored)
	models := settingObject(image["byModel"])
	if settingObject(models["gpt-image-2"])["base2kCredits"] != float64(6) || settingObject(models["vendor-image"])["base2kCredits"] != float64(8) {
		t.Fatal("historical image fallback or explicit override lost")
	}
	modes, items, seconds, err := normalizedSettingsVideoPricing(stored)
	if err != nil {
		t.Fatal(err)
	}
	if modes["vendor-video"] != "per_second" || items["vendor-video@1080p"] != float64(3) || seconds["vendor-video@720p"] != float64(12) {
		t.Fatal("custom model pricing incomplete")
	}
	stored["VIDEO_MODEL_BILLING_MODES"] = storedSystemSetting{Value: map[string]any{"vendor-video": "hourly"}}
	if _, _, _, err := normalizedSettingsVideoPricing(stored); err == nil {
		t.Fatal("invalid billing mode silently accepted")
	}
}
func TestSettingsRejectsUnsafeSupportLinksAndInvalidReferralRewards(t *testing.T) {
	config := copySettingObject(systemSettingDefinitionByKey["DASHBOARD_SUPPORT_CONFIG"].DefaultValue)
	if _, err := coerceSystemSetting(systemSettingDefinitionByKey["DASHBOARD_SUPPORT_CONFIG"], config); err != nil {
		t.Fatal(err)
	}
	settingObject(config["officialSupport"])["actionUrl"] = "javascript:alert(1)"
	if _, err := coerceSystemSetting(systemSettingDefinitionByKey["DASHBOARD_SUPPORT_CONFIG"], config); err == nil {
		t.Fatal("unsafe dashboard link accepted")
	}
	referral := map[string]any{"enabled": true, "inviter": map[string]any{"mode": "percentage", "value": float64(101)}, "invitee": map[string]any{"mode": "fixed", "value": float64(1)}}
	if _, err := coerceSystemSetting(systemSettingDefinitionByKey["REFERRAL_REWARD_CONFIG"], referral); err == nil {
		t.Fatal("invalid financial reward accepted")
	}
}
