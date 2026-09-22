//go:build integration

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/png"
	"mime/multipart"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func modelConfigTestCommand(category, key string) modelConfigurationCommand {
	id := newRequestID()
	uuid := id[:8] + "-" + id[8:12] + "-4" + id[13:16] + "-a" + id[17:20] + "-" + id[20:]
	var command modelConfigurationCommand
	_ = json.Unmarshal([]byte(mustJSON(map[string]any{"clientRequestId": uuid, "category": category, "configKey": key, "expectedRevision": 0, "isCustom": true, "enabled": true, "visible": true, "homepageVisible": true, "homepagePriority": 5, "description": "test model", "coverChange": map[string]any{"action": "keep"}, "supportedResolutions": []string{"1k"}, "pricing": map[string]float64{"base1kCredits": 2.25}})), &command)
	if category == "video" {
		command.Pricing = nil
		command.BillingMode = "per_item"
		command.SupportedResolutions = []string{"720p"}
		command.CreditsPerSecond = map[string]float64{"720p": 1.125}
		command.CreditsPerItem = map[string]float64{"720p": 9.25}
	}
	return command
}

func seedModelConfigurationSettings(t *testing.T, b *backend) {
	t.Helper()
	for _, key := range modelConfigurationSettingKeys {
		setStorageTestSetting(t, b, key, systemSettingDefinitionByKey[key].DefaultValue)
	}
	setStorageTestSetting(t, b, "STORAGE_ENDPOINT", "")
	b.config.storagePath = t.TempDir()
	setStorageTestSetting(t, b, "SYSTEM_ASSETS_BUCKET_NAME", "model-test-assets")
	setStorageTestSetting(t, b, "GENERATIONS_BUCKET_NAME", "generations")
}
func assertModelConfigStatus(t *testing.T, err error, status int) {
	t.Helper()
	var apiErr *apiError
	if !errors.As(err, &apiErr) || apiErr.status != status {
		t.Fatalf("expected %d, got %v", status, err)
	}
}

func TestModelConfigurationAtomicConcurrencyAndReplay(t *testing.T) {
	b := integrationBackend(t)
	ctx := context.Background()
	actor, _ := seedAuthUser(t, b)
	seedModelConfigurationSettings(t, b)
	commands := []modelConfigurationCommand{modelConfigTestCommand("image", "model-a-"+newRequestID()), modelConfigTestCommand("image", "model-b-"+newRequestID())}
	var wg sync.WaitGroup
	results := make([]map[string]any, 2)
	errs := make([]error, 2)
	for i := range commands {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = b.applyModelConfiguration(ctx, actor, commands[i], false)
		}(i)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil || results[i]["revision"] != int64(1) {
			t.Fatalf("concurrent mutation %v %v", results[i], err)
		}
	}
	value, err := b.setting(ctx, "MODEL_MARKETPLACE_CONFIG", nil)
	if err != nil {
		t.Fatal(err)
	}
	config := value.(map[string]any)
	if len(goMapObject(config, "imageByModel")) != 2 {
		t.Fatalf("lost concurrent update: %v", config)
	}
	prices, _ := b.setting(ctx, "IMAGE_MODEL_CREDIT_PRICES", nil)
	for _, command := range commands {
		entry := goMapObject(goMapObject(prices, "byModel"), command.Key)
		if entry["base1kCredits"] != 2.25 || positiveNumber(entry["base4kCredits"], 0) <= 0 {
			t.Fatalf("image prices were not persisted separately: %v", entry)
		}
	}
	replay, err := b.applyModelConfiguration(ctx, actor, commands[0], false)
	if err != nil || goInt64(replay["revision"]) != 1 {
		t.Fatalf("replay failed %v %v", replay, err)
	}
	changed := commands[0]
	changed.Pricing = map[string]float64{"base1kCredits": 3}
	_, err = b.applyModelConfiguration(ctx, actor, changed, false)
	assertModelConfigStatus(t, err, 409)
	stale := commands[0]
	stale.ClientRequestID = modelConfigTestCommand("image", "unused").ClientRequestID
	_, err = b.applyModelConfiguration(ctx, actor, stale, false)
	assertModelConfigStatus(t, err, 409)
	// A late failure rolls back both configuration and the independent price maps.
	if _, err = b.db.Exec(ctx, `CREATE FUNCTION fail_model_config_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='modelConfiguration.update' THEN RAISE EXCEPTION 'forced audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_model_config_audit BEFORE INSERT ON admin_audit_log FOR EACH ROW EXECUTE FUNCTION fail_model_config_audit()`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = b.db.Exec(ctx, `DROP TRIGGER IF EXISTS fail_model_config_audit ON admin_audit_log; DROP FUNCTION IF EXISTS fail_model_config_audit()`)
	})
	failed := modelConfigTestCommand("image", "model-fail-"+newRequestID())
	if _, err = b.applyModelConfiguration(ctx, actor, failed, false); err == nil {
		t.Fatal("forced audit failure accepted")
	}
	after, _ := b.setting(ctx, "MODEL_MARKETPLACE_CONFIG", nil)
	afterPrices, _ := b.setting(ctx, "IMAGE_MODEL_CREDIT_PRICES", nil)
	if goMapObject(after, "imageByModel")[failed.Key] != nil || goMapObject(afterPrices, "byModel")[failed.Key] != nil {
		t.Fatal("failed transaction leaked configuration/prices")
	}
}

func TestModelConfigurationVideoOwnershipCoverAndPublicCatalog(t *testing.T) {
	b := integrationBackend(t)
	ctx := context.Background()
	actor, _ := seedAuthUser(t, b)
	seedModelConfigurationSettings(t, b)
	command := modelConfigTestCommand("video", "custom-video-"+newRequestID())
	source := image.NewNRGBA(image.Rect(0, 0, 1600, 900))
	source.Set(0, 0, color.NRGBA{R: 200, A: 255})
	var pngBytes bytes.Buffer
	if err := png.Encode(&pngBytes, source); err != nil {
		t.Fatal(err)
	}
	command.CoverChange.Action = "replace"
	command.CoverChange.Bytes = pngBytes.Bytes()
	result, err := b.applyModelConfiguration(ctx, actor, command, false)
	if err != nil {
		t.Fatal(err)
	}
	configRaw, _ := b.setting(ctx, "MODEL_MARKETPLACE_CONFIG", nil)
	config := configRaw.(map[string]any)
	entry := goMapObject(goMapObject(config, "videoByFamily"), command.Key)
	cover := goMapObject(entry, "cover")
	stored, err := b.readStorageObject(ctx, stringValue(cover["bucket"]), stringValue(cover["key"]))
	if err != nil {
		t.Fatal(err)
	}
	dimensions, format, err := image.DecodeConfig(bytes.NewReader(stored))
	if err != nil || format != "webp" || dimensions.Width != 1200 || dimensions.Height != 675 {
		t.Fatalf("cover not normalized %s %+v %v", format, dimensions, err)
	}
	seconds, _ := b.setting(ctx, "VIDEO_MODEL_CREDITS_PER_SECOND", nil)
	items, _ := b.setting(ctx, "VIDEO_MODEL_CREDITS_PER_ITEM", nil)
	modes, _ := b.setting(ctx, "VIDEO_MODEL_BILLING_MODES", nil)
	if seconds.(map[string]any)[command.Key+"@720p"] != 1.125 || items.(map[string]any)[command.Key+"@720p"] != 9.25 || modes.(map[string]any)[command.Key] != "per_item" {
		t.Fatal("video price/mode settings missing")
	}
	rootGroup := seedImagePricingGroup(t, b, true, nil, nil)
	group := seedImagePricingGroup(t, b, false, nil, nil)
	if _, err = b.db.Exec(ctx, `UPDATE image_backend_group SET metadata=$2 WHERE id=$1`, rootGroup, mustJSON(map[string]any{"childGroupIds": []string{group}})); err != nil {
		t.Fatal(err)
	}
	member := seedImagePricingMember(t, b, group, command.Key, "http://localhost:1", false, 50)
	if _, err = b.db.Exec(ctx, `UPDATE image_backend_member_api_adapter_version SET configuration=$2 WHERE member_id_snapshot=$1`, member, mustJSON(map[string]any{"baseUrl": "http://localhost:1", "operations": map[string]any{"videos.generate": map[string]any{"path": "/video"}}})); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("GET", "http://localhost/api/model-marketplace", nil)
	catalog, err := b.loadNativeModelCatalog(r)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := nativeModelConfigurationSnapshot(catalog, true)
	if err != nil {
		t.Fatal(err)
	}
	seenCustom, seenUnconfigured := false, false
	for _, entry := range snapshot["entries"].([]map[string]any) {
		if entry["configKey"] == command.Key {
			seenCustom = entry["isCustom"] == true && entry["minimumCredits"] == 9.25
		}
		if entry["category"] == "video" && entry["pricingSource"] == "unconfigured" {
			seenUnconfigured = entry["supportedResolutions"] != nil && entry["creditsPerSecondByResolution"] != nil
		}
	}
	// The catalog must tolerate independently missing prices and show the model to admins.
	delete(catalog.Settings["VIDEO_MODEL_CREDITS_PER_ITEM"], "veo31@720p")
	missing, _ := nativeModelConfigurationSnapshot(catalog, true)
	for _, entry := range missing["entries"].([]map[string]any) {
		if entry["configKey"] == "veo31" {
			seenUnconfigured = entry["pricingSource"] == "unconfigured" && entry["supportedResolutions"] != nil
		}
	}
	if !seenCustom || !seenUnconfigured {
		t.Fatalf("management catalog missing custom/unpriced %v", snapshot)
	}
	w := httptest.NewRecorder()
	if err = b.handlePublicModelMarketplace(w, r); err != nil {
		t.Fatal(err)
	}
	var public struct {
		Items []map[string]any `json:"items"`
	}
	if err = json.Unmarshal(w.Body.Bytes(), &public); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, item := range public.Items {
		if item["modelId"] == command.Key {
			found = true
			if item["creditsPerItem"] != 9.25 || item["coverUrl"] != modelConfigurationCover(entry) || item["input"].(map[string]any)["frames"] != "none" {
				t.Fatalf("public catalog fabricated data: %v", item)
			}
		}
	}
	if !found {
		t.Fatalf("custom video absent: %s", w.Body.String())
	}
	// A built-in cannot be turned into or deleted as a custom model.
	bad := modelConfigTestCommand("video", "veo31")
	if _, err = b.applyModelConfiguration(ctx, actor, bad, false); err == nil {
		t.Fatal("builtin identity takeover accepted")
	}
	if _, err = b.applyModelConfiguration(ctx, actor, bad, true); err == nil {
		t.Fatal("builtin deletion accepted")
	}
	deletion := modelConfigTestCommand("video", command.Key)
	revision := goInt64(result["revision"])
	deletion.ExpectedRevision = &revision
	if _, err = b.applyModelConfiguration(ctx, actor, deletion, true); err != nil {
		t.Fatal(err)
	}
	if err = b.cleanupModelConfigurationCovers(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = b.readStorageObject(ctx, stringValue(cover["bucket"]), stringValue(cover["key"])); err == nil {
		t.Fatal("deleted model cover was not reclaimed")
	}
	finalPrices, _ := b.setting(ctx, "VIDEO_MODEL_CREDITS_PER_SECOND", nil)
	for key := range finalPrices.(map[string]any) {
		if strings.HasPrefix(key, command.Key) {
			t.Fatal("deleted video prices retained")
		}
	}
}

func TestModelConfigurationHTTPPermissionsAndCapabilities(t *testing.T) {
	b := integrationBackend(t)
	ctx := context.Background()
	admin, email := seedAuthUser(t, b)
	_, userEmail := seedAuthUser(t, b)
	seedModelConfigurationSettings(t, b)
	if _, err := b.db.Exec(ctx, `UPDATE "user" SET role='super_admin' WHERE id=$1`, admin); err != nil {
		t.Fatal(err)
	}
	adminCookie := signInTestUser(t, b, email)
	userCookie := signInTestUser(t, b, userEmail)
	command := modelConfigTestCommand("video", "seedance2")
	command.IsCustom = false
	command.SupportedResolutions = []string{"720p", "2k"}
	command.CreditsPerSecond = map[string]float64{"720p": 1.25, "2k": 2.5}
	command.CreditsPerItem = map[string]float64{"720p": 5, "2k": 10}
	maxRefs := int64(12)
	command.MaxReferenceImages = &maxRefs
	path := "/api/admin/model-configuration"
	if w := authRequest(t, b, "POST", path, mustJSON(command), userCookie); w.Code != 403 {
		t.Fatalf("nonadmin mutation status %d %s", w.Code, w.Body.String())
	}
	w := authRequest(t, b, "POST", path, mustJSON(command), adminCookie)
	if w.Code != 200 {
		t.Fatalf("admin mutation failed %d %s", w.Code, w.Body.String())
	}
	overrides, _ := b.setting(ctx, "VIDEO_MODEL_CAPABILITY_OVERRIDES", nil)
	if goMapObject(goMapObject(overrides, "byModel"), "seedance2")["maxReferenceImages"] != float64(12) {
		t.Fatal("capability override was lost")
	}
	get := authRequest(t, b, "GET", path, "", adminCookie)
	if get.Code != 200 {
		t.Fatalf("admin read failed %d %s", get.Code, get.Body.String())
	}
	// Exercise the real multipart adapter used by the settings dialog.
	imageCommand := modelConfigTestCommand("image", "multipart-image-"+newRequestID())
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	var fields map[string]any
	_ = json.Unmarshal([]byte(mustJSON(imageCommand)), &fields)
	for key, value := range fields {
		if key == "coverChange" {
			_ = form.WriteField(key, "replace")
			continue
		}
		if text, ok := value.(string); ok {
			_ = form.WriteField(key, text)
		} else {
			_ = form.WriteField(key, mustJSON(value))
		}
	}
	file, err := form.CreateFormFile("cover", "cover.png")
	if err != nil {
		t.Fatal(err)
	}
	if err = png.Encode(file, image.NewNRGBA(image.Rect(0, 0, 4, 3))); err != nil {
		t.Fatal(err)
	}
	_ = form.Close()
	request := httptest.NewRequest("POST", "http://localhost:3000"+path, &body)
	request.Header.Set("Content-Type", form.FormDataContentType())
	request.AddCookie(adminCookie)
	out := httptest.NewRecorder()
	b.handler().ServeHTTP(out, request)
	if out.Code != 200 {
		t.Fatalf("multipart mutation failed %d %s", out.Code, out.Body.String())
	}
}
