//go:build integration

package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestImageAsyncCreateScopesFullInputAndDeliveryAtomically(t *testing.T) {
	b := integrationBackend(t)
	uid, email := seedAuthUser(t, b)
	cookie := signInTestUser(t, b, email)
	model := "task-replay-" + newRequestID()
	group := seedImagePricingGroup(t, b, true, nil, nil)
	seedImagePricingMember(t, b, group, model, "https://provider.example.com", true, 1)
	seedImagePricingSettings(t, b, model)
	setStorageTestSetting(t, b, "CONTENT_MODERATION_ENABLED", false)
	setStorageTestSetting(t, b, "STORAGE_ENDPOINT", "")
	setStorageTestSetting(t, b, "STORAGE_GENERATIONS_BUCKET", "generations")
	b.config.storagePath = t.TempDir()
	creditTestWallet(t, b, uid, 100)
	creditTestBatch(t, b, uid, "purchase", 100, nil)
	id := newRequestID()
	body := map[string]any{"generationId": id, "prompt": "original prompt", "model": model, "resolution": "2k", "operation": "generate", "backendGroupId": group, "quality": "high"}
	input := imageAsyncUOLInput{TaskID: "task_" + id, GenerationInput: imagePricingInput(body), ResponseFormat: "b64_json", CallbackURL: "https://callback.example.com/images"}
	call := func(value imageAsyncUOLInput) *httptest.ResponseRecorder {
		raw, _ := json.Marshal(value)
		r := httptest.NewRequest(http.MethodPost, "http://localhost:3000/api/images/async-tasks", strings.NewReader(string(raw)))
		r.Header.Set("Content-Type", "application/json")
		r.AddCookie(cookie)
		w := httptest.NewRecorder()
		b.endpoint(b.handleImageAsyncCreate)(w, r)
		return w
	}
	var wg sync.WaitGroup
	responses := make(chan *httptest.ResponseRecorder, 6)
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			copy := input
			copy.GenerationInput = imagePricingInput(body)
			responses <- call(copy)
		}()
	}
	wg.Wait()
	close(responses)
	for w := range responses {
		out := requireCreditResponse(t, w, http.StatusAccepted)
		if out["taskId"] != input.TaskID {
			t.Fatalf("wrong replay task: %v", out)
		}
	}
	var format, callback string
	var n int
	if err := b.db.QueryRow(context.Background(), `SELECT response_format,callback_url,(SELECT count(*) FROM image_async_task WHERE generation_id=$1) FROM image_async_task WHERE generation_id=$1`, id).Scan(&format, &callback, &n); err != nil {
		t.Fatal(err)
	}
	if format != "b64_json" || callback != input.CallbackURL || n != 1 {
		t.Fatalf("delivery options/task count: %s %s %d", format, callback, n)
	}
	balance, batches, count := creditState(t, b, uid)
	if balance != 96.97 || batches != 96.97 || count != 1 {
		t.Fatalf("retry double charged: %v %v %d", balance, batches, count)
	}
	for _, change := range []struct {
		key   string
		value any
	}{{"prompt", "changed"}, {"model", "other"}, {"resolution", "4k"}, {"quality", "low"}, {"images", []any{}}, {"generationId", newRequestID()}} {
		altered := input
		altered.GenerationInput = imagePricingInput(body)
		altered.GenerationInput[change.key], _ = json.Marshal(change.value)
		requireCreditResponse(t, call(altered), http.StatusConflict)
	}
	for _, change := range []string{"task", "format", "callback"} {
		altered := input
		altered.GenerationInput = imagePricingInput(body)
		switch change {
		case "task":
			altered.TaskID = "task_" + newRequestID()
		case "format":
			altered.ResponseFormat = "url"
		case "callback":
			altered.CallbackURL = "https://different.example.com/callback"
		}
		requireCreditResponse(t, call(altered), http.StatusConflict)
	}
	// A retry retains its accepted route/price even if configuration changes.
	setStorageTestSetting(t, b, "IMAGE_MODEL_CREDIT_PRICES", map[string]any{"version": 1, "byModel": map[string]any{}})
	if _, err := b.db.Exec(context.Background(), `UPDATE image_backend_group SET is_enabled=false WHERE id=$1`, group); err != nil {
		t.Fatal(err)
	}
	copy := input
	copy.GenerationInput = imagePricingInput(body)
	requireCreditResponse(t, call(copy), http.StatusAccepted)
	// Ownership is part of the natural key, including another key of this user.
	original := imagePricingInput(body)
	original["taskId"], _ = json.Marshal(input.TaskID)
	original["responseFormat"], _ = json.Marshal(input.ResponseFormat)
	original["callbackUrl"], _ = json.Marshal(input.CallbackURL)
	r := httptest.NewRequest(http.MethodPost, "http://localhost:3000/api/images/generate", nil)
	for _, principal := range []*apiPrincipal{{UserID: uid, KeyID: "different-key"}, {UserID: "another-user"}} {
		_, err := b.createImageTask(r, principal, original, "generate")
		var apiErr *apiError
		if !errors.As(err, &apiErr) || apiErr.code != "IDEMPOTENCY_CONFLICT" {
			t.Fatalf("unscoped replay: %v", err)
		}
	}
}

func TestImageTaskInputNormalizesAliasesAndRejectsDeliveryConflicts(t *testing.T) {
	first := imagePricingInput(map[string]any{"generationId": "g", "taskId": "task_g", "model": "m", "prompt": "p", "responseFormat": "b64_json", "callbackUrl": "https://callback.example.com"})
	second := imagePricingInput(map[string]any{"generation_id": "g", "task_id": "task_g", "model": "m", "prompt": "p", "response_format": "b64_json", "callback_url": "https://callback.example.com"})
	_, a, err := normalizeImageTaskInput(first, "generate")
	if err != nil {
		t.Fatal(err)
	}
	_, b, err := normalizeImageTaskInput(second, "generate")
	if err != nil || a != b {
		t.Fatalf("alias replay mismatch %s %s %v", a, b, err)
	}
	for _, fields := range []map[string]any{{"generationId": "a", "generation_id": "b"}, {"callbackUrl": "http://callback.example.com"}, {"callbackUrl": "https://user:secret@callback.example.com"}, {"response_format": "unsupported"}, {"operation": "edit"}} {
		if _, _, err = normalizeImageTaskInput(imagePricingInput(fields), "generate"); err == nil {
			t.Fatalf("invalid input accepted: %v", fields)
		}
	}
}
