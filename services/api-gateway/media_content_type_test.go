package main

import (
	"bytes"
	"image"
	"image/jpeg"
	"image/png"
	"testing"

	nativewebp "github.com/HugoSmits86/nativewebp"
)

func TestStorageContentTypeDetectsOpaqueRasterPayloads(t *testing.T) {
	base := image.NewNRGBA(image.Rect(0, 0, 8, 4))
	var pngData bytes.Buffer
	if err := png.Encode(&pngData, base); err != nil {
		t.Fatal(err)
	}
	var jpegData bytes.Buffer
	if err := jpeg.Encode(&jpegData, base, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatal(err)
	}
	var webpData bytes.Buffer
	if err := nativewebp.Encode(&webpData, base, nil); err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		name, key, want string
		data            []byte
	}{
		{name: "png", key: "opaque", want: "image/png", data: pngData.Bytes()},
		{name: "jpeg", key: "opaque", want: "image/jpeg", data: jpegData.Bytes()},
		{name: "webp", key: "opaque", want: "image/webp", data: webpData.Bytes()},
		{name: "extension mismatch", key: "opaque.png", want: "image/jpeg", data: jpegData.Bytes()},
		{name: "unknown", key: "opaque", want: "application/octet-stream", data: []byte("not an image")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := storageContentType(tc.key, tc.data, false); got != tc.want {
				t.Fatalf("MIME = %q, want %q", got, tc.want)
			}
		})
	}

	if got := storageContentType("opaque.png", pngData.Bytes(), true); got != "image/webp" {
		t.Fatalf("encoded thumbnail MIME = %q, want image/webp", got)
	}
}
