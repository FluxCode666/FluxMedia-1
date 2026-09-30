//go:build integration

package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func seedSeedanceMember(t *testing.T, b *backend, group, model string) {
	t.Helper()
	member := seedImagePricingMember(t, b, group, model, "http://127.0.0.1:1", true, 50)
	if _, err := b.db.Exec(context.Background(), `UPDATE image_backend_member_api_adapter_version SET configuration=$2 WHERE member_id_snapshot=$1`, member, mustJSON(map[string]any{"baseUrl": "http://127.0.0.1:1", "operations": map[string]any{"videos.generate": map[string]any{"path": "/video"}}})); err != nil {
		t.Fatal(err)
	}
}

func seedanceHTTP(t *testing.T, b *backend, method, path, key, body string, headers map[string]string) (int, map[string]any) {
	t.Helper()
	r := httptest.NewRequest(method, "http://localhost:3000"+path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	if key != "" {
		r.Header.Set("Authorization", "Bearer "+key)
	}
	for name, value := range headers {
		r.Header.Set(name, value)
	}
	w := httptest.NewRecorder()
	b.handler().ServeHTTP(w, r)
	var response map[string]any
	if w.Body.Len() > 0 {
		if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
			t.Fatalf("%s %s returned non-JSON body %q", method, path, w.Body.String())
		}
	}
	return w.Code, response
}

func TestSeedanceHTTPGateway(t *testing.T) {
	b := integrationBackend(t)
	uid, group := seedNativeVideoFixture(t, b)
	seedSeedanceMember(t, b, group, "seedance2-fast")
	key := seedNativeVideoKey(t, b, uid, group)
	const path = "/api/v3/contents/generations/tasks"
	body := `{"model":"doubao-seedance-2-0-fast-260128","content":[{"type":"text","text":"a paper boat on a lake"}],"ratio":"9:16","duration":4}`
	if code, response := seedanceHTTP(t, b, "POST", path, "", body, nil); code != http.StatusUnauthorized || response["error"].(map[string]any)["code"] != "AuthenticationError" {
		t.Fatalf("missing key: %d %v", code, response)
	}
	if code, _ := seedanceHTTP(t, b, "OPTIONS", path, "", "", nil); code != http.StatusNoContent {
		t.Fatalf("preflight returned %d", code)
	}
	if code, response := seedanceHTTP(t, b, "POST", path, key, `{"model":"doubao-seedance-2-0-fast-260128","content":[{"type":"text","text":"x"}],"watermark":true}`, nil); code != http.StatusBadRequest || response["error"].(map[string]any)["code"] != "InvalidParameter.UnsupportedParameter" {
		t.Fatalf("unsupported parameter: %d %v", code, response)
	}
	idempotency := map[string]string{"Idempotency-Key": newRequestID()}
	code, created := seedanceHTTP(t, b, "POST", path, key, body, idempotency)
	id, _ := created["id"].(string)
	if code != http.StatusOK || !strings.HasPrefix(id, "video_") || len(created) != 1 {
		t.Fatalf("create: %d %v", code, created)
	}
	if code, replay := seedanceHTTP(t, b, "POST", path, key, body, idempotency); code != http.StatusOK || replay["id"] != id {
		t.Fatalf("replay: %d %v", code, replay)
	}
	if code, conflict := seedanceHTTP(t, b, "POST", path, key, strings.Replace(body, "paper boat", "red kite", 1), idempotency); code != http.StatusConflict {
		t.Fatalf("changed replay: %d %v", code, conflict)
	}
	code, task := seedanceHTTP(t, b, "GET", path+"/"+id, key, "", nil)
	if code != http.StatusOK || task["id"] != id || task["model"] != "doubao-seedance-2-0-fast-260128" || task["status"] != "queued" || task["ratio"] != "9:16" || task["resolution"] != "720p" || task["duration"] != float64(4) {
		t.Fatalf("status: %d %v", code, task)
	}
	if code, response := seedanceHTTP(t, b, "GET", path+"/video_missing", key, "", nil); code != http.StatusNotFound || response["error"].(map[string]any)["code"] != "NotFound" {
		t.Fatalf("missing task: %d %v", code, response)
	}
}

func TestSeedanceTaskScopeStatusAndCallback(t *testing.T) {
	b := integrationBackend(t)
	uid, group := seedNativeVideoFixture(t, b)
	seedSeedanceMember(t, b, group, "seedance2")
	setStorageTestSetting(t, b, "NEXT_PUBLIC_APP_URL", "https://media.example.com")
	key := seedNativeVideoKey(t, b, uid, group)
	other := seedNativeVideoKey(t, b, uid, group)
	scope := "external:" + uid + ":" + key
	r := httptest.NewRequest("POST", "http://localhost:3000/api/v3/contents/generations/tasks", nil)
	r.Header.Set("Idempotency-Key", newRequestID())
	body, err := parseSeedanceNativeVideoRequest(r, videoTestBody(map[string]any{"model": "doubao-seedance-2-0-260128", "content": []any{map[string]any{"type": "text", "text": "Seedance fixture --dur 6"}}, "generate_audio": false}))
	if err != nil {
		t.Fatal(err)
	}
	task, err := b.createNativeVideoTask(r, uid, key, scope, body)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := task["taskId"].(string)
	replay, err := b.createNativeVideoTask(r, uid, key, scope, body)
	if err != nil || replay["taskId"] != id {
		t.Fatalf("Seedance retry created another task: %v %v", replay, err)
	}
	status, err := b.readNativeSeedanceTask(r, uid, key, scope, id)
	if err != nil || status["status"] != "queued" || status["model"] != "doubao-seedance-2-0-260128" || status["duration"] != 6 || status["generate_audio"] != false || status["error"] != nil {
		t.Fatalf("queued task: %v %v", status, err)
	}
	for _, wrong := range []struct{ key, scope string }{{other, "external:" + uid + ":" + other}, {"", "user:" + uid}} {
		if _, err := b.readNativeSeedanceTask(r, uid, wrong.key, wrong.scope, id); err == nil {
			t.Fatal("foreign task scope accepted")
		}
	}
	native, err := b.createNativeVideoTask(r, uid, key, scope, videoTestBody(map[string]any{"clientRequestId": newRequestID(), "model": "veo31", "prompt": "native fixture", "duration": 8, "aspectRatio": "16:9", "resolution": "720p"}))
	if err != nil {
		t.Fatal(err)
	}
	nativeID, _ := native["taskId"].(string)
	if _, err := b.readNativeSeedanceTask(r, uid, key, scope, nativeID); err == nil {
		t.Fatal("task created outside the Seedance gateway is visible")
	}
	payload, err := b.videoCallbackPayload(r.Context(), nativeID)
	if err != nil || payload["object"] != "video.task" {
		t.Fatalf("native callback changed: %v %v", payload, err)
	}
	if _, err := b.db.Exec(r.Context(), `UPDATE video_generation SET status='completed',stage='completed',storage_key='video.mp4',storage_bucket='generations',completed_at=now() WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	status, err = b.readNativeSeedanceTask(r, uid, key, scope, id)
	content, _ := status["content"].(map[string]any)
	if err != nil || status["status"] != "succeeded" || content["video_url"] == nil || status["error"] != nil {
		t.Fatalf("succeeded task: %v %v", status, err)
	}
	payload, err = b.videoCallbackPayload(r.Context(), id)
	content, _ = payload["content"].(map[string]any)
	if err != nil || payload["status"] != "succeeded" || payload["model"] != "doubao-seedance-2-0-260128" || content["video_url"] != "https://media.example.com/api/storage/generations/video.mp4" || payload["generate_audio"] != false {
		t.Fatalf("succeeded callback: %v %v", payload, err)
	}
	if _, err := b.db.Exec(r.Context(), `UPDATE video_generation SET status='failed',stage='failed',error='failed upstream' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	status, err = b.readNativeSeedanceTask(r, uid, key, scope, id)
	failure, _ := status["error"].(map[string]any)
	if err != nil || status["status"] != "failed" || status["content"] != nil || failure["message"] != "failed upstream" {
		t.Fatalf("failed task: %v %v", status, err)
	}
}
