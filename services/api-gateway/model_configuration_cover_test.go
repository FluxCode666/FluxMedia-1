package main

import (
	"bytes"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"testing"
)

func TestModelCoverRejectsInvalidAnimatedAndForeignReferences(t *testing.T) {
	if _, _, err := prepareModelCover("image", "model", []byte("<svg></svg>")); err == nil {
		t.Fatal("SVG accepted")
	}
	src := image.NewNRGBA(image.Rect(0, 0, 2, 3))
	var encoded bytes.Buffer
	_ = png.Encode(&encoded, src)
	animation := make([]byte, 20)
	binary.BigEndian.PutUint32(animation[:4], 8)
	copy(animation[4:8], "acTL")
	binary.BigEndian.PutUint32(animation[8:12], 1)
	binary.BigEndian.PutUint32(animation[16:], crc32.ChecksumIEEE(animation[4:16]))
	pngData := encoded.Bytes()
	animated := append([]byte{}, pngData[:33]...)
	animated = append(animated, animation...)
	animated = append(animated, pngData[33:]...)
	if _, _, err := prepareModelCover("image", "model", animated); err == nil {
		t.Fatal("APNG accepted")
	}
	output, key, err := prepareModelCover("image", "model", pngData)
	if err != nil {
		t.Fatal(err)
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(output))
	if err != nil || format != "webp" || cfg.Width != 2 || cfg.Height != 3 {
		t.Fatal("small image was enlarged or invalid")
	}
	ref := map[string]any{"bucket": "system", "key": key}
	if err = validateModelCover("image", "system", ref); err != nil {
		t.Fatal(err)
	}
	if validateModelCover("video", "system", ref) == nil || validateModelCover("image", "other", ref) == nil {
		t.Fatal("cross domain cover accepted")
	}
}

func TestModelCoverAppliesExifOrientationAndStripsMetadata(t *testing.T) {
	src := image.NewNRGBA(image.Rect(0, 0, 20, 10))
	for y := 0; y < 10; y++ {
		for x := 0; x < 20; x++ {
			if x < 10 {
				src.Set(x, y, color.NRGBA{R: 255, A: 255})
			} else {
				src.Set(x, y, color.NRGBA{B: 255, A: 255})
			}
		}
	}
	var raw bytes.Buffer
	_ = jpeg.Encode(&raw, src, &jpeg.Options{Quality: 100})
	tiff := []byte{'I', 'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0}
	payload := append([]byte("Exif\x00\x00"), tiff...)
	segment := []byte{0xff, 0xe1, 0, 0}
	binary.BigEndian.PutUint16(segment[2:], uint16(len(payload)+2))
	segment = append(segment, payload...)
	data := append([]byte{}, raw.Bytes()[:2]...)
	data = append(data, segment...)
	data = append(data, raw.Bytes()[2:]...)
	result, _, err := prepareModelCover("image", "model", data)
	if err != nil {
		t.Fatal(err)
	}
	decoded, _, err := image.Decode(bytes.NewReader(result))
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Bounds().Dx() != 10 || decoded.Bounds().Dy() != 20 {
		t.Fatal("orientation did not swap dimensions")
	}
	r, _, b, _ := decoded.At(5, 5).RGBA()
	if r <= b {
		t.Fatal("clockwise orientation was incorrect")
	}
	if bytes.Contains(result, []byte("Exif")) {
		t.Fatal("Exif metadata retained")
	}
}
