package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"image"
	"image/draw"
	"math"
	"regexp"

	nativewebp "github.com/HugoSmits86/nativewebp"
	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

var modelCoverKeyPattern = regexp.MustCompile(`^(image|video)/[a-f0-9]{64}/[a-f0-9]{64}\.webp$`)

func validateModelCover(category, bucket string, cover any) error {
	if cover == nil {
		return nil
	}
	ref, ok := cover.(map[string]any)
	if !ok || len(ref) != 2 || ref["bucket"] != bucket || !modelCoverKeyPattern.MatchString(stringValue(ref["key"])) || stringValue(ref["key"])[:len(category)+1] != category+"/" {
		return invalid("模型封面引用不属于当前资产桶或媒体类别")
	}
	return nil
}

// Decode and re-encode pixels so uploaded metadata and executable trailing bytes
// never become public assets. PNG/APNG and animated WebP are rejected explicitly.
func prepareModelCover(category, key string, data []byte) ([]byte, string, error) {
	if len(data) == 0 || len(data) > 100<<20 {
		return nil, "", invalid("封面文件为空或超过请求大小上限")
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || (format != "jpeg" && format != "png" && format != "webp") || config.Width < 1 || config.Height < 1 || int64(config.Width)*int64(config.Height) > 40_000_000 {
		return nil, "", invalid("封面必须是静态 JPEG、PNG 或 WebP，且总像素不得超过 40,000,000")
	}
	if format == "png" {
		for offset := 8; offset+12 <= len(data); {
			n := int(binary.BigEndian.Uint32(data[offset : offset+4]))
			if n > len(data)-offset-12 {
				return nil, "", invalid("封面图片已损坏")
			}
			if string(data[offset+4:offset+8]) == "acTL" {
				return nil, "", invalid("封面不支持动画图片")
			}
			offset += n + 12
		}
	}
	if format == "webp" {
		for offset := 12; offset+8 <= len(data); {
			n := int(binary.LittleEndian.Uint32(data[offset+4 : offset+8]))
			if n > len(data)-offset-8 {
				return nil, "", invalid("封面图片已损坏")
			}
			chunk := string(data[offset : offset+4])
			if chunk == "ANIM" || chunk == "ANMF" {
				return nil, "", invalid("封面不支持动画图片")
			}
			offset += 8 + n + (n % 2)
		}
	}
	src, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, "", invalid("封面图片无法安全解码")
	}
	orientation := modelCoverOrientation(data, format)
	w, h := src.Bounds().Dx(), src.Bounds().Dy()
	if orientation >= 5 && orientation <= 8 {
		w, h = h, w
	}
	scale := math.Min(1, math.Min(1200/float64(w), 800/float64(h)))
	outW, outH := int(float64(w)*scale), int(float64(h)*scale)
	if outW < 1 {
		outW = 1
	}
	if outH < 1 {
		outH = 1
	}
	oriented := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			sx, sy := x, y
			switch orientation {
			case 2:
				sx = w - 1 - x
			case 3:
				sx, sy = w-1-x, h-1-y
			case 4:
				sy = h - 1 - y
			case 5:
				sx, sy = y, x
			case 6:
				sx, sy = y, w-1-x
			case 7:
				sx, sy = h-1-y, w-1-x
			case 8:
				sx, sy = h-1-y, x
			}
			oriented.Set(x, y, src.At(sx+src.Bounds().Min.X, sy+src.Bounds().Min.Y))
		}
	}
	dst := image.NewNRGBA(image.Rect(0, 0, outW, outH))
	xdraw.CatmullRom.Scale(dst, dst.Bounds(), oriented, oriented.Bounds(), draw.Src, nil)
	var output bytes.Buffer
	if err := nativewebp.Encode(&output, dst, nil); err != nil {
		return nil, "", invalid("封面图片无法编码")
	}
	digest := sha256.Sum256(output.Bytes())
	keyDigest := sha256.Sum256([]byte(key))
	return output.Bytes(), category + "/" + hex.EncodeToString(keyDigest[:]) + "/" + hex.EncodeToString(digest[:]) + ".webp", nil
}

func modelCoverOrientation(data []byte, format string) int {
	var tiff []byte
	if format == "jpeg" {
		for offset := 2; offset+4 <= len(data); {
			if data[offset] != 0xff {
				break
			}
			marker := data[offset+1]
			if marker == 0xda || marker == 0xd9 {
				break
			}
			n := int(binary.BigEndian.Uint16(data[offset+2 : offset+4]))
			if n < 2 || offset+2+n > len(data) {
				break
			}
			segment := data[offset+4 : offset+2+n]
			if marker == 0xe1 && bytes.HasPrefix(segment, []byte("Exif\x00\x00")) {
				tiff = segment[6:]
				break
			}
			offset += 2 + n
		}
	} else if format == "png" {
		for offset := 8; offset+12 <= len(data); {
			n := int(binary.BigEndian.Uint32(data[offset : offset+4]))
			if n > len(data)-offset-12 {
				break
			}
			if string(data[offset+4:offset+8]) == "eXIf" {
				tiff = data[offset+8 : offset+8+n]
				break
			}
			offset += n + 12
		}
	} else if format == "webp" {
		for offset := 12; offset+8 <= len(data); {
			n := int(binary.LittleEndian.Uint32(data[offset+4 : offset+8]))
			if n > len(data)-offset-8 {
				break
			}
			if string(data[offset:offset+4]) == "EXIF" {
				tiff = bytes.TrimPrefix(data[offset+8:offset+8+n], []byte("Exif\x00\x00"))
				break
			}
			offset += 8 + n + n%2
		}
	}
	if len(tiff) < 8 {
		return 1
	}
	var order binary.ByteOrder = binary.LittleEndian
	if string(tiff[:2]) == "MM" {
		order = binary.BigEndian
	} else if string(tiff[:2]) != "II" {
		return 1
	}
	if order.Uint16(tiff[2:4]) != 42 {
		return 1
	}
	offset := int(order.Uint32(tiff[4:8]))
	if offset < 8 || offset > len(tiff)-2 {
		return 1
	}
	count := int(order.Uint16(tiff[offset : offset+2]))
	offset += 2
	for i := 0; i < count && offset+12 <= len(tiff); i++ {
		entry := tiff[offset : offset+12]
		if order.Uint16(entry[:2]) == 0x112 && order.Uint16(entry[2:4]) == 3 && order.Uint32(entry[4:8]) == 1 {
			value := int(order.Uint16(entry[8:10]))
			if value >= 1 && value <= 8 {
				return value
			}
		}
		offset += 12
	}
	return 1
}
