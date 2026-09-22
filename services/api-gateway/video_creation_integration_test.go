//go:build integration

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"testing"
)

func seedNativeVideoFixture(t *testing.T, b *backend) (string, string) {
	t.Helper()
	uid, _ := seedAuthUser(t, b)
	group := seedImagePricingGroup(t, b, true, nil, nil)
	model := "veo31"
	member := seedImagePricingMember(t, b, group, model, "http://127.0.0.1:1", true, 50)
	if _, err := b.db.Exec(context.Background(), `UPDATE image_backend_member_api_adapter_version SET configuration=$2 WHERE member_id_snapshot=$1`, member, mustJSON(map[string]any{"baseUrl": "http://127.0.0.1:1", "operations": map[string]any{"videos.generate": map[string]any{"path": "/video"}}})); err != nil {
		t.Fatal(err)
	}
	seconds, items := map[string]any{}, map[string]any{}
	for id, cap := range goVideoCapabilities {
		for _, res := range cap.Resolutions {
			seconds[id+"@"+res] = 1.125
			items[id+"@"+res] = 9.25
		}
	}
	setStorageTestSetting(t, b, "VIDEO_MODEL_CREDITS_PER_SECOND", seconds)
	setStorageTestSetting(t, b, "VIDEO_MODEL_CREDITS_PER_ITEM", items)
	setStorageTestSetting(t, b, "VIDEO_MODEL_BILLING_MODES", map[string]any{})
	setStorageTestSetting(t, b, "VIDEO_MODEL_CAPABILITY_OVERRIDES", map[string]any{"version": 1, "byModel": map[string]any{}})
	setStorageTestSetting(t, b, "MODEL_MARKETPLACE_CONFIG", map[string]any{"videoByFamily": map[string]any{}})
	setStorageTestSetting(t, b, "STORAGE_ENDPOINT", "")
	setStorageTestSetting(t, b, "STORAGE_GENERATIONS_BUCKET", "generations")
	return uid, group
}

func seedNativeVideoKey(t *testing.T, b *backend, userID, group string) string {
	t.Helper()
	id := newRequestID()
	digest := sha256.Sum256([]byte(id))
	if _, err := b.db.Exec(context.Background(), `INSERT INTO external_api_key(id,user_id,key_prefix,key_hash,last_four,generation_group_id) VALUES($1,$2,'video-test',$3,'test',NULLIF($4,''))`, id, userID, hex.EncodeToString(digest[:]), group); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestNativeVideoCreateStoresSnapshotAndImmutableReplay(t *testing.T) {
	b := integrationBackend(t)
	uid, group := seedNativeVideoFixture(t, b)
	r := httptest.NewRequest("POST", "http://localhost:3000/api/videos/generate", nil)
	input := videoTestInput()
	input["clientRequestId"] = newRequestID()
	input["backendGroupId"] = group
	body := videoTestBody(input)
	first, err := b.createNativeVideoTask(r, uid, "", "user:"+uid, body)
	if err != nil {
		t.Fatal(err)
	}
	id := first["taskId"].(string)
	billing, ok := first["billing"].(map[string]any)
	if !ok || billing["kind"] != "snapshot" || billing["quotedCredits"] != 9.0 {
		t.Fatalf("billing snapshot omitted: %v", billing)
	}
	var raw []byte
	var width, height int
	if err := b.db.QueryRow(r.Context(), `SELECT metadata,output_width,output_height FROM video_generation WHERE id=$1`, id).Scan(&raw, &width, &height); err != nil {
		t.Fatal(err)
	}
	var meta map[string]any
	_ = json.Unmarshal(raw, &meta)
	if width != 1280 || height != 720 || meta["requestFingerprintVersion"] != float64(2) || meta["videoCapabilitySnapshot"] == nil {
		t.Fatalf("snapshot incomplete: %s %dx%d", raw, width, height)
	}
	replay, err := b.createNativeVideoTask(r, uid, "", "user:"+uid, body)
	if err != nil || replay["taskId"] != id {
		t.Fatalf("same request replay failed %v %v", replay, err)
	}
	for key, value := range map[string]any{"prompt": "changed", "callbackUrl": "https://example.com/callback", "geminiOperationId": "differentoperation123"} {
		changed := videoTestBody(input)
		changed[key] = json.RawMessage(mustJSON(value))
		_, err := b.createNativeVideoTask(r, uid, "", "user:"+uid, changed)
		var apiErr *apiError
		if !errors.As(err, &apiErr) || apiErr.status != 409 {
			t.Fatalf("changed %s accepted: %v", key, err)
		}
	}
	if _, err := b.db.Exec(r.Context(), `UPDATE video_generation SET credits_consumed=1.25 WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	status, err := b.readNativeVideoStatus(r, id, uid, "", "user:"+uid)
	if err != nil {
		t.Fatal(err)
	}
	if status["billing"].(map[string]any)["actualCredits"] != 1.25 {
		t.Fatalf("fractional credits lost: %v", status)
	}
}

func TestNativeVideoUnboundAPIKeyUsesDefaultGroup(t *testing.T) {
	b := integrationBackend(t)
	uid, group := seedNativeVideoFixture(t, b)
	ctx := context.Background()
	var existing []string
	rows, err := b.db.Query(ctx, `SELECT id FROM image_backend_group WHERE is_default`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		existing = append(existing, id)
	}
	rows.Close()
	if _, err := b.db.Exec(ctx, `UPDATE image_backend_group SET is_default=(id=$1)`, group); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = b.db.Exec(ctx, `UPDATE image_backend_group SET is_default=(id=ANY($1))`, existing) })
	key := seedNativeVideoKey(t, b, uid, "")
	pricing, err := b.loadGoVideoPricingContext(ctx, uid, key, "")
	if err != nil || pricing.GroupID != group || !pricing.Reachable["veo31"] {
		t.Fatalf("default API group: %+v %v", pricing, err)
	}
	input := videoTestInput()
	input["clientRequestId"] = newRequestID()
	r := httptest.NewRequest("POST", "http://localhost/api/v1/videos", nil)
	task, err := b.createNativeVideoTask(r, uid, key, "external:"+uid+":"+key, videoTestBody(input))
	if err != nil || task["taskId"] == "" {
		t.Fatalf("unbound key create failed %v %v", task, err)
	}
	if _, err := b.loadGoVideoPricingContext(ctx, uid, "missing-key", ""); err == nil {
		t.Fatal("missing API key used default group")
	}
}

func TestNativeGeminiOperationScopeAndCompletion(t *testing.T) {
	b := integrationBackend(t)
	uid, group := seedNativeVideoFixture(t, b)
	key := seedNativeVideoKey(t, b, uid, group)
	other := seedNativeVideoKey(t, b, uid, group)
	scope := "external:" + uid + ":" + key
	r := httptest.NewRequest("POST", "http://localhost:3000/api/v1beta/models/veo31:predictLongRunning", nil)
	r.SetPathValue("model", "veo-3.1-generate-preview:predictLongRunning")
	r.Header.Set("Idempotency-Key", newRequestID())
	body, err := parseGeminiNativeVideoRequest(r, scope, videoTestBody(map[string]any{"instances": []any{map[string]any{"prompt": "Gemini fixture"}}}))
	if err != nil {
		t.Fatal(err)
	}
	task, err := b.createNativeVideoTask(r, uid, key, scope, body)
	if err != nil {
		t.Fatal(err)
	}
	model, op := rawString(body, "geminiModel"), rawString(body, "geminiOperationId")
	operation, err := b.readNativeGeminiOperation(r, uid, key, scope, model, op)
	if err != nil || operation["done"] != false {
		t.Fatalf("pending operation: %v %v", operation, err)
	}
	for _, wrong := range []struct{ key, scope, model string }{{other, "external:" + uid + ":" + other, model}, {key, scope, "another-model"}, {"", "user:" + uid, model}} {
		if _, err := b.readNativeGeminiOperation(r, uid, wrong.key, wrong.scope, wrong.model, op); err == nil {
			t.Fatal("foreign operation scope accepted")
		}
	}
	if _, err := b.db.Exec(r.Context(), `UPDATE video_generation SET status='completed',stage='completed',storage_key='video.mp4',storage_bucket='generations',completed_at=now() WHERE id=$1`, task["taskId"]); err != nil {
		t.Fatal(err)
	}
	operation, err = b.readNativeGeminiOperation(r, uid, key, scope, model, op)
	if err != nil || operation["done"] != true || operation["response"] == nil || operation["error"] != nil {
		t.Fatalf("completed operation: %v %v", operation, err)
	}
	if _, err := b.db.Exec(r.Context(), `UPDATE video_generation SET status='failed',stage='failed',error='failed upstream' WHERE id=$1`, task["taskId"]); err != nil {
		t.Fatal(err)
	}
	operation, err = b.readNativeGeminiOperation(r, uid, key, scope, model, op)
	if err != nil || operation["done"] != true || operation["response"] != nil || operation["error"] == nil {
		t.Fatalf("failed operation: %v %v", operation, err)
	}
}

func TestNativeVideoCapabilitiesIncludeCustomModelAndReachability(t *testing.T) {
	b := integrationBackend(t)
	uid, group := seedNativeVideoFixture(t, b)
	model := "custom-video"
	setStorageTestSetting(t, b, "MODEL_MARKETPLACE_CONFIG", map[string]any{"customModels": []any{map[string]any{"modelId": model, "category": "video", "supportedResolutions": []string{"720p"}}}})
	var seconds, items map[string]any
	pricing, err := b.loadGoVideoPricingContext(context.Background(), uid, "", group)
	if err != nil {
		t.Fatal(err)
	}
	seconds = map[string]any{}
	items = map[string]any{}
	for key, value := range pricing.Settings["VIDEO_MODEL_CREDITS_PER_SECOND"] {
		seconds[key] = value
	}
	for key, value := range pricing.Settings["VIDEO_MODEL_CREDITS_PER_ITEM"] {
		items[key] = value
	}
	seconds[model+"@720p"] = 1.25
	items[model+"@720p"] = 10
	setStorageTestSetting(t, b, "VIDEO_MODEL_CREDITS_PER_SECOND", seconds)
	setStorageTestSetting(t, b, "VIDEO_MODEL_CREDITS_PER_ITEM", items)
	t.Setenv("BETTER_AUTH_SECRET", "video-test-secret")
	r := httptest.NewRequest("GET", "http://localhost/api/videos/capabilities?backendGroupId="+group, nil)
	w := httptest.NewRecorder()
	if err := b.writeGoVideoCapabilities(w, r, uid, "", "user:"+uid); err != nil {
		t.Fatal(err)
	}
	var response struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, item := range response.Items {
		if item["model"] == model {
			found = true
			if item["configuredReachable"] != false || len(item["billing"].([]any)) != 1 {
				t.Fatal(item)
			}
		}
		if item["model"] == "veo31" && item["configuredReachable"] != true {
			t.Fatal(item)
		}
	}
	if !found {
		t.Fatal("custom video model missing")
	}
}

func TestNativeVideoCapabilitiesOmitUnpricedModelWithoutHidingOthers(t *testing.T) {
	b := integrationBackend(t)
	uid, group := seedNativeVideoFixture(t, b)
	ctx := context.Background()
	if _, err := b.db.Exec(ctx, `UPDATE system_setting SET value=(value::jsonb-'veo31@720p')::json WHERE key='VIDEO_MODEL_CREDITS_PER_ITEM'`); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest("GET", "http://localhost/api/videos/capabilities?backendGroupId="+group, nil)
	out := httptest.NewRecorder()
	if err := b.writeGoVideoCapabilities(out, request, uid, "", "user:"+uid); err != nil {
		t.Fatal(err)
	}
	var payload struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(out.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Items) == 0 {
		t.Fatal("one missing price hid the whole video catalog")
	}
	for _, item := range payload.Items {
		if item["model"] == "veo31" {
			t.Fatal("unpriced model was advertised as billable")
		}
	}
}
