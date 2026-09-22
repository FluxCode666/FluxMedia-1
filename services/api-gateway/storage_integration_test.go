//go:build integration

package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func setStorageTestSetting(t *testing.T, b *backend, key string, value any) {
	t.Helper()
	var previous []byte
	err := b.db.QueryRow(context.Background(), `SELECT value FROM system_setting WHERE key=$1`, key).Scan(&previous)
	if err != nil && err != pgx.ErrNoRows {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(value)
	if _, err := b.db.Exec(context.Background(), `INSERT INTO system_setting(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2`, key, raw); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if previous == nil {
			_, _ = b.db.Exec(context.Background(), `DELETE FROM system_setting WHERE key=$1`, key)
		} else {
			_, _ = b.db.Exec(context.Background(), `UPDATE system_setting SET value=$2 WHERE key=$1`, key, previous)
		}
	})
}

func storageTestRequest(b *backend, method, path string, body []byte, cookie *http.Cookie, headers map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://localhost:3000"+path, bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	if cookie != nil {
		r.AddCookie(cookie)
	}
	for key, value := range headers {
		r.Header.Set(key, value)
	}
	w := httptest.NewRecorder()
	b.handler().ServeHTTP(w, r)
	return w
}

func TestStorageInternalOperationsEnforceSystemAccessAndRoundTrip(t *testing.T) {
	b := integrationBackend(t)
	b.config.storagePath = t.TempDir()
	b.config.cronSecret = "test-storage-system-credential"
	setStorageTestSetting(t, b, "STORAGE_ENDPOINT", "")
	_, email := seedAuthUser(t, b)
	cookie := signInTestUser(t, b, email)
	body := []byte(`{"bucket":"generations","key":"internal/roundtrip.txt","data":"aGVsbG8="}`)
	for _, method := range []string{"PUT", "DELETE"} {
		w := storageTestRequest(b, method, "/api/storage/object", body, cookie, nil)
		if w.Code != http.StatusForbidden {
			t.Fatalf("ordinary user %s internal object: %d %s", method, w.Code, w.Body.String())
		}
	}
	credential := map[string]string{"Authorization": "Bearer " + b.config.cronSecret}
	w := storageTestRequest(b, "PUT", "/api/storage/object", body, nil, credential)
	if w.Code != 200 {
		t.Fatalf("system put: %d %s", w.Code, w.Body.String())
	}
	readBody := []byte(`{"bucket":"generations","key":"internal/roundtrip.txt"}`)
	w = storageTestRequest(b, "POST", "/api/storage/object", readBody, nil, credential)
	var result struct {
		Data string `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || w.Code != 200 || result.Data != base64.StdEncoding.EncodeToString([]byte("hello")) {
		t.Fatalf("system read: %d %s", w.Code, w.Body.String())
	}
	w = storageTestRequest(b, "POST", "/api/storage/signed-read-url", readBody, cookie, nil)
	if w.Code != http.StatusForbidden {
		t.Fatalf("ordinary user minted internal URL: %d", w.Code)
	}
	for _, input := range []string{`{"bucket":"../escape","key":"test","data":"AA=="}`, `{"bucket":"generations","key":"../escape","data":"AA=="}`} {
		w = storageTestRequest(b, "PUT", "/api/storage/object", []byte(input), nil, credential)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("system traversal accepted: %d", w.Code)
		}
	}
	for i := 0; i < 2; i++ {
		w = storageTestRequest(b, "DELETE", "/api/storage/object", readBody, nil, credential)
		if w.Code != 200 {
			t.Fatalf("delete retry %d: %d %s", i, w.Code, w.Body.String())
		}
	}
}

func TestStorageAvatarDocumentsThumbnailsAndRange(t *testing.T) {
	b := integrationBackend(t)
	b.config.storagePath = t.TempDir()
	setStorageTestSetting(t, b, "STORAGE_ENDPOINT", "")
	setStorageTestSetting(t, b, "STORAGE_BUCKET_NAME", "test-uploads")
	setStorageTestSetting(t, b, "SYSTEM_ASSETS_BUCKET_NAME", "test-system")
	userID, email := seedAuthUser(t, b)
	_, otherEmail := seedAuthUser(t, b)
	cookie, otherCookie := signInTestUser(t, b, email), signInTestUser(t, b, otherEmail)
	avatarKey := "avatars/" + userID + "-123456789.png"
	avatarBody, _ := json.Marshal(map[string]any{"key": avatarKey, "contentType": "image/png"})
	w := storageTestRequest(b, "POST", "/api/upload/presigned", avatarBody, cookie, nil)
	var avatar struct {
		UploadURL string `json:"uploadUrl"`
		Key       string `json:"key"`
		Max       int    `json:"maxFileSizeBytes"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &avatar); err != nil || w.Code != 200 || avatar.Key != avatarKey || avatar.Max <= 0 {
		t.Fatalf("avatar presign: %d %s", w.Code, w.Body.String())
	}
	var pngData bytes.Buffer
	if err := png.Encode(&pngData, image.NewNRGBA(image.Rect(0, 0, 64, 64))); err != nil {
		t.Fatal(err)
	}
	w = storageTestRequest(b, "PUT", avatar.UploadURL, pngData.Bytes(), otherCookie, map[string]string{"Content-Type": "image/png"})
	if w.Code != http.StatusForbidden {
		t.Fatalf("another user uploaded avatar: %d", w.Code)
	}
	w = storageTestRequest(b, "PUT", avatar.UploadURL, pngData.Bytes(), cookie, map[string]string{"Content-Type": "image/png"})
	if w.Code != http.StatusNoContent {
		t.Fatalf("avatar upload: %d %s", w.Code, w.Body.String())
	}
	w = storageTestRequest(b, "GET", "/api/storage/test-system/w32/"+avatarKey, nil, nil, nil)
	if w.Code != 200 || w.Header().Get("Content-Type") != "image/webp" || !bytes.Contains(w.Body.Bytes()[:16], []byte("WEBP")) {
		t.Fatalf("thumbnail: %d %v", w.Code, w.Header())
	}
	w = storageTestRequest(b, "GET", "/api/storage/test-system/w128/"+avatarKey, nil, nil, nil)
	if w.Code != 200 || w.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("unchanged thumbnail MIME: %d %v", w.Code, w.Header())
	}
	w = storageTestRequest(b, "POST", "/api/upload/presigned", []byte(`{"filename":"readme.txt","fileSize":6,"contentType":"text/html"}`), cookie, nil)
	var document struct {
		URL         string `json:"uploadUrl"`
		ContentType string `json:"contentType"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &document); err != nil || w.Code != 200 || document.ContentType != "text/plain" || !strings.HasPrefix(document.URL, "/api/storage/test-uploads/") {
		t.Fatalf("document presign: %d %s", w.Code, w.Body.String())
	}
	w = storageTestRequest(b, "PUT", document.URL, []byte("abcdef"), cookie, map[string]string{"Content-Type": "text/html"})
	if w.Code != http.StatusNoContent {
		t.Fatalf("document upload: %d %s", w.Code, w.Body.String())
	}
	w = storageTestRequest(b, "GET", document.URL, nil, cookie, map[string]string{"Range": "bytes=1-3"})
	if w.Code != http.StatusPartialContent || w.Body.String() != "bcd" {
		t.Fatalf("range: %d %s", w.Code, w.Body.String())
	}
	w = storageTestRequest(b, "GET", document.URL, nil, otherCookie, nil)
	if w.Code != http.StatusForbidden {
		t.Fatalf("other user read upload: %d", w.Code)
	}
	for _, body := range []string{`{"filename":"readme.txt"}`, `{"filename":"readme.pdf","fileSize":10485761}`, `{"filename":"active.html","fileSize":5}`} {
		w = storageTestRequest(b, "POST", "/api/upload/presigned", []byte(body), cookie, nil)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("invalid document accepted: %d %s", w.Code, w.Body.String())
		}
	}
}

func TestStorageSignedReadURLHonorsNumericExpiry(t *testing.T) {
	b := integrationBackend(t)
	b.config.cronSecret = "test-storage-expiry"
	setStorageTestSetting(t, b, "STORAGE_ENDPOINT", "")
	headers := map[string]string{"Authorization": "Bearer " + b.config.cronSecret}
	for _, ttl := range []int{1, 120, 86400, 0} {
		body := map[string]any{"bucket": "generations", "key": "test/output.png"}
		want := ttl
		if ttl != 0 {
			body["expiresIn"] = ttl
		} else {
			want = 3600
		}
		start := time.Now().Unix()
		w := storageTestRequest(b, "POST", "/api/storage/signed-read-url", []byte(mustJSON(body)), nil, headers)
		out := requireCreditResponse(t, w, 200)
		parsed, err := url.Parse(out["url"].(string))
		if err != nil {
			t.Fatal(err)
		}
		exp, err := strconv.ParseInt(parsed.Query().Get("exp"), 10, 64)
		if err != nil || exp < start+int64(want) || exp > time.Now().Unix()+int64(want) || parsed.Query().Get("sig") == "" {
			t.Fatalf("requested=%d expiry=%d url=%s err=%v", ttl, exp, parsed, err)
		}
	}
	for _, invalid := range []any{0, -1, 86401, 1.5, "120", true, nil} {
		body := map[string]any{"bucket": "generations", "key": "test/output.png", "expiresIn": invalid}
		requireCreditResponse(t, storageTestRequest(b, "POST", "/api/storage/signed-read-url", []byte(mustJSON(body)), nil, headers), 400)
	}
}
