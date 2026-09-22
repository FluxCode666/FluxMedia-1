//go:build integration

package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"image"
	"image/png"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestGalleryRefreshesStoredInputImageURLs(t *testing.T) {
	b := integrationBackend(t)
	t.Setenv("BETTER_AUTH_SECRET", b.config.authSecret)
	b.config.storagePath = t.TempDir()
	const bucket = "gallery-test-media"
	setStorageTestSetting(t, b, "STORAGE_ENDPOINT", "")
	setStorageTestSetting(t, b, "SYSTEM_ASSETS_BUCKET_NAME", "gallery-test-system")
	setStorageTestSetting(t, b, "GENERATIONS_BUCKET_NAME", bucket)
	setStorageTestSetting(t, b, "STORAGE_BUCKET_NAME", bucket)
	uid, email := seedAuthUser(t, b)
	otherID, _ := seedAuthUser(t, b)
	cookie := signInTestUser(t, b, email)
	id := newRequestID()
	// Reserved URL characters must remain part of the object key rather than
	// becoming a query, fragment, or percent-decoded path during rendering.
	key := uid + "/image-inputs/" + id + "/reference #?%+中文.png"
	outputKey := uid + "/images/" + id + "/output %23#?+中文.png"
	var data bytes.Buffer
	if err := png.Encode(&data, image.NewNRGBA(image.Rect(0, 0, 256, 128))); err != nil {
		t.Fatal(err)
	}
	for _, objectKey := range []string{key, outputKey} {
		if err := b.putStorageObject(context.Background(), bucket, objectKey, data.Bytes(), "image/png"); err != nil {
			t.Fatal(err)
		}
	}
	expiredAt := strconv.FormatInt(time.Now().Add(-time.Hour).Unix(), 10)
	mac := hmac.New(sha256.New, []byte(b.config.authSecret))
	_, _ = mac.Write([]byte(bucket + "/" + key + ":" + expiredAt))
	expiredSignature := hex.EncodeToString(mac.Sum(nil))
	expiredURL := "/api/storage/" + urlPathEscape(bucket) + "/" + urlPathEscape(key) + "?sig=" + expiredSignature + "&exp=" + expiredAt
	w := storageTestRequest(b, http.MethodGet, expiredURL, nil, nil, nil)
	if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "SIGNATURE_EXPIRED") {
		t.Fatalf("expired fixture was readable: %d %s", w.Code, w.Body.String())
	}
	const externalURL = "https://images.example.test/reference.png?X-Amz-Signature=a%2Bb%2Fc&X-Amz-Expires=900&part=1&part=2#preview"
	storedReference := map[string]any{"id": "stored-input", "imageUrl": expiredURL, "storageKey": key, "storageBucket": bucket, "source": "upload", "role": "reference", "index": 0, "name": "reference.png", "type": "image/png", "sizeBytes": data.Len()}
	externalReference := map[string]any{"id": "external-input", "imageUrl": externalURL, "source": "remote", "role": "reference", "index": 1}
	metadata := map[string]any{"inputImages": map[string]any{"images": []any{storedReference, externalReference}}}
	at := time.Now().UTC().Add(-time.Minute)
	historyFixtureImage(t, b, uid, id, "gallery-test-model", "completed", at, metadata)
	if _, err := b.db.Exec(context.Background(), `UPDATE generation SET storage_key=$2,storage_bucket=$3 WHERE id=$1`, id, outputKey, bucket); err != nil {
		t.Fatal(err)
	}
	historyFixtureImage(t, b, otherID, newRequestID(), "private-gallery-model", "completed", at, metadata)

	assertReadable := func(t *testing.T, rawURL, objectKey string) {
		t.Helper()
		u, err := url.Parse(rawURL)
		if err != nil || u.Path != "/api/storage/"+bucket+"/"+objectKey || u.Fragment != "" || len(u.Query()) != 2 {
			t.Fatalf("wrong storage URL: %s (%v)", rawURL, err)
		}
		exp, err := strconv.ParseInt(u.Query().Get("exp"), 10, 64)
		if err != nil || exp <= time.Now().Unix() || u.Query().Get("sig") == "" || u.Query().Get("sig") == expiredSignature {
			t.Fatalf("storage URL was not refreshed: %s", rawURL)
		}
		mac := hmac.New(sha256.New, []byte(b.config.authSecret))
		_, _ = mac.Write([]byte(bucket + "/" + objectKey + ":" + u.Query().Get("exp")))
		if u.Query().Get("sig") != hex.EncodeToString(mac.Sum(nil)) {
			t.Fatal("storage signature does not cover the original object key")
		}
		for _, width := range []int{0, 128} {
			wantWidth, wantType := 256, "image/png"
			if width != 0 {
				u.Path = "/api/storage/" + bucket + "/w128/" + objectKey
				wantWidth, wantType = 128, "image/webp"
			}
			response := storageTestRequest(b, http.MethodGet, u.RequestURI(), nil, nil, nil)
			if response.Code != http.StatusOK || response.Header().Get("Content-Type") != wantType {
				t.Fatalf("image width %d: %d %s", width, response.Code, response.Body.String())
			}
			decoded, _, err := image.Decode(bytes.NewReader(response.Body.Bytes()))
			if err != nil || decoded.Bounds().Dx() != wantWidth || decoded.Bounds().Dy() != wantWidth/2 {
				t.Fatalf("image width %d did not decode at expected size: %v", width, err)
			}
		}
		query := u.Query()
		query.Set("sig", strings.Repeat("0", 64))
		u.RawQuery = query.Encode()
		if response := storageTestRequest(b, http.MethodGet, u.RequestURI(), nil, nil, nil); response.Code != http.StatusForbidden {
			t.Fatalf("invalid thumbnail signature accepted: %d", response.Code)
		}
	}

	for _, tab := range []string{"uploads", "final"} {
		t.Run(tab, func(t *testing.T) {
			response := authRequest(t, b, http.MethodPost, "/api/image-generation/gallery", mustJSON(map[string]any{"tab": tab, "limit": 20}), cookie)
			out := requireCreditResponse(t, response, http.StatusOK)
			for _, privateField := range []string{`"storageKey"`, `"storageBucket"`} {
				if strings.Contains(response.Body.String(), privateField) {
					t.Fatalf("gallery exposed %s", privateField)
				}
			}
			items := out["items"].([]any)
			wantItems := 1
			if tab == "uploads" {
				wantItems = 2
			}
			if len(items) != wantItems {
				t.Fatalf("unexpected gallery count, including foreign rows: %d", len(items))
			}
			for i, raw := range items {
				item := raw.(map[string]any)
				if item["parentId"] != id {
					t.Fatal("gallery returned another user's generation")
				}
				if tab == "final" {
					assertReadable(t, item["imageUrl"].(string), outputKey)
				} else if i == 0 {
					assertReadable(t, item["imageUrl"].(string), key)
				} else if item["imageUrl"] != externalURL {
					t.Fatal("external signed upload URL was changed")
				}
				refs := item["referenceImages"].([]any)
				if len(refs) != 2 {
					t.Fatalf("reference count changed: %d", len(refs))
				}
				stored := refs[0].(map[string]any)
				if len(stored) != len(storedReference)-2 || stored["id"] != "stored-input" || stored["name"] != "reference.png" || stored["index"] != float64(0) || stored["sizeBytes"] != float64(data.Len()) {
					t.Fatalf("stored reference shape changed: %v", stored)
				}
				assertReadable(t, stored["imageUrl"].(string), key)
				external := refs[1].(map[string]any)
				if len(external) != len(externalReference) || external["imageUrl"] != externalURL || external["id"] != "external-input" {
					t.Fatalf("external reference changed: %v", external)
				}
			}
		})
	}
}
