//go:build integration

package main

import (
	"bytes"
	"context"
	"image"
	"image/png"
	"net/url"
	"strconv"
	"strings"
	"testing"
)

func TestStorageGenerationThumbnailsWithSharedBuckets(t *testing.T) {
	for _, tc := range []struct{ name, generations, uploads string }{
		{"separate", "test-generations", "test-uploads"},
		{"shared-uploads", "test-media", "test-media"},
		{"documents-name", "documents", "test-uploads"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b := integrationBackend(t)
			b.config.storagePath = t.TempDir()
			setStorageTestSetting(t, b, "STORAGE_ENDPOINT", "")
			setStorageTestSetting(t, b, "SYSTEM_ASSETS_BUCKET_NAME", "test-system")
			setStorageTestSetting(t, b, "GENERATIONS_BUCKET_NAME", tc.generations)
			setStorageTestSetting(t, b, "STORAGE_BUCKET_NAME", tc.uploads)
			var data bytes.Buffer
			if err := png.Encode(&data, image.NewNRGBA(image.Rect(0, 0, 1024, 512))); err != nil {
				t.Fatal(err)
			}
			key := "user/images/output.png"
			if err := b.putStorageObject(context.Background(), tc.generations, key, data.Bytes(), "image/png"); err != nil {
				t.Fatal(err)
			}
			signed, err := b.storageSignedReadURL(context.Background(), tc.generations, key, 3600)
			if err != nil {
				t.Fatal(err)
			}
			for _, width := range []int{0, 128, 160, 320, 640} {
				u, err := url.Parse(signed)
				if err != nil {
					t.Fatal(err)
				}
				wantWidth, wantType := 1024, "image/png"
				if width != 0 {
					u.Path = "/api/storage/" + tc.generations + "/w" + strconv.Itoa(width) + "/" + key
					wantWidth, wantType = width, "image/webp"
				}
				w := storageTestRequest(b, "GET", u.RequestURI(), nil, nil, nil)
				if w.Code != 200 || w.Header().Get("Content-Type") != wantType {
					t.Fatalf("width %d: %d %s", width, w.Code, w.Body.String())
				}
				decoded, _, err := image.Decode(bytes.NewReader(w.Body.Bytes()))
				if err != nil {
					t.Fatal(err)
				}
				if decoded.Bounds().Dx() != wantWidth || decoded.Bounds().Dy() != wantWidth/2 {
					t.Fatalf("width %d: wrong dimensions %v", width, decoded.Bounds())
				}
				query := u.Query()
				query.Set("sig", strings.Repeat("0", 64))
				u.RawQuery = query.Encode()
				w = storageTestRequest(b, "GET", u.RequestURI(), nil, nil, nil)
				if w.Code != 403 {
					t.Fatalf("invalid signature accepted at width %d: %d", width, w.Code)
				}
			}
		})
	}
}

func TestStorageSharedSystemBucketPreservesPublicDomains(t *testing.T) {
	b := integrationBackend(t)
	b.config.storagePath = t.TempDir()
	setStorageTestSetting(t, b, "STORAGE_ENDPOINT", "")
	setStorageTestSetting(t, b, "SYSTEM_ASSETS_BUCKET_NAME", "test-system")
	setStorageTestSetting(t, b, "GENERATIONS_BUCKET_NAME", "test-generations")
	setStorageTestSetting(t, b, "STORAGE_BUCKET_NAME", "test-system")
	var data bytes.Buffer
	if err := png.Encode(&data, image.NewNRGBA(image.Rect(0, 0, 256, 128))); err != nil {
		t.Fatal(err)
	}
	avatar := "avatars/user-123456.png"
	logo := "logo/" + strings.Repeat("a", 64) + ".png"
	model := "image/" + strings.Repeat("a", 64) + "/" + strings.Repeat("b", 64) + ".webp"
	cover, err := storageThumbnail(data.Bytes(), 128)
	if err != nil {
		t.Fatal(err)
	}
	for key, content := range map[string][]byte{avatar: data.Bytes(), logo: data.Bytes(), model: cover} {
		if err := b.putStorageObject(context.Background(), "test-system", key, content, "image/png"); err != nil {
			t.Fatal(err)
		}
		w := storageTestRequest(b, "GET", "/api/storage/test-system/"+key, nil, nil, nil)
		if w.Code != 200 {
			t.Fatalf("public %s: %d %s", key, w.Code, w.Body.String())
		}
		for _, bucket := range []string{"test-system", "_avatars"} {
			w = storageTestRequest(b, "GET", "/api/storage/"+bucket+"/w128/"+key, nil, nil, nil)
			want := 400
			if key == avatar {
				want = 200
				if w.Header().Get("Content-Type") != "image/webp" {
					t.Errorf("avatar thumbnail MIME: %s", w.Header().Get("Content-Type"))
				}
			}
			if w.Code != want {
				t.Errorf("%s thumbnail %s: %d want %d", bucket, key, w.Code, want)
			}
		}
		if key != avatar {
			w = storageTestRequest(b, "GET", "/api/storage/_avatars/"+key, nil, nil, nil)
			if w.Code != 400 {
				t.Errorf("avatar alias exposed non-avatar %s: %d", key, w.Code)
			}
		}
	}
	key := "uploads/user/private.png"
	if err := b.putStorageObject(context.Background(), "test-system", key, data.Bytes(), "image/png"); err != nil {
		t.Fatal(err)
	}
	w := storageTestRequest(b, "GET", "/api/storage/test-system/"+key, nil, nil, nil)
	if w.Code != 403 {
		t.Fatalf("private upload exposed: %d", w.Code)
	}
	signed, err := b.storageSignedReadURL(context.Background(), "test-system", key, 3600)
	if err != nil {
		t.Fatal(err)
	}
	w = storageTestRequest(b, "GET", signed, nil, nil, nil)
	if w.Code != 200 {
		t.Fatalf("signed document: %d", w.Code)
	}
	w = storageTestRequest(b, "GET", strings.Replace(signed, "/test-system/", "/test-system/w128/", 1), nil, nil, nil)
	if w.Code != 400 {
		t.Fatalf("document thumbnail: %d", w.Code)
	}
}
