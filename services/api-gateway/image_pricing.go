package main

import (
	"encoding/json"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

var imagePriceFields = []string{"base1024Credits", "base1kCredits", "base2kCredits", "base4kCredits", "base8kCredits"}
var imageSizePattern = regexp.MustCompile(`^(\d{2,5})x(\d{2,5})$`)

func normalizeImagePricingModel(model string) string {
	return strings.TrimPrefix(strings.ToLower(strings.TrimSpace(model)), "firefly-")
}

// Versioned, sparse group prices inherit from a complete explicit global
// model entry. A default/model-independent price may never authorize billing.
func imagePricingEntry(value any, model string) map[string]float64 {
	if encoded, ok := value.(string); ok {
		if json.Unmarshal([]byte(encoded), &value) != nil {
			return nil
		}
	}
	root, ok := value.(map[string]any)
	if !ok || imageCreditValue(root["version"], 0) != 1 {
		return nil
	}
	entries, ok := root["byModel"].(map[string]any)
	if !ok {
		return nil
	}
	keys := make([]string, 0, len(entries))
	for key := range entries {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		return len(normalizeImagePricingModel(keys[i])) > len(normalizeImagePricingModel(keys[j]))
	})
	model = normalizeImagePricingModel(model)
	for _, key := range keys {
		normalized := normalizeImagePricingModel(key)
		if normalized == "" || normalized == "default" || (model != normalized && !strings.HasPrefix(model, normalized+"-")) {
			continue
		}
		entry, ok := entries[key].(map[string]any)
		if !ok {
			return nil
		}
		out := map[string]float64{}
		for _, field := range imagePriceFields {
			raw, present := entry[field]
			if !present {
				continue
			}
			price, ok := raw.(float64)
			if !ok || math.IsNaN(price) || math.IsInf(price, 0) || price <= 0 || price > 100000 {
				return nil
			}
			out[field] = price
		}
		return out
	}
	return nil
}

func resolveImagePrices(model string, global, group any) (map[string]float64, error) {
	prices := imagePricingEntry(global, model)
	for _, field := range imagePriceFields[:4] {
		if prices[field] <= 0 {
			return nil, &apiError{503, "MISSING_GLOBAL_IMAGE_PRICING", "该模型缺少完整的全局图片价格配置"}
		}
	}
	for field, value := range imagePricingEntry(group, model) {
		prices[field] = value
	}
	return prices, nil
}

// Resolution tiers use the longest edge, as in the original shared pricing
// contract. Recognized labels represent their tier; explicit dimensions also
// cover 3840x2160 and portrait images. Invalid dimensions fail closed at 4K.
func imageBillingPriceKey(resolution, size string, prices map[string]float64) string {
	resolution = strings.ToLower(strings.TrimSpace(resolution))
	edge := 1024
	switch resolution {
	case "1k":
		edge = 1248
	case "2k":
		edge = 2048
	case "4k":
		edge = 3840
	case "8k":
		edge = 7680
	default:
		candidate := strings.ToLower(strings.TrimSpace(size))
		if candidate == "" {
			candidate = resolution
		}
		if candidate != "" && candidate != "auto" {
			matches := imageSizePattern.FindStringSubmatch(candidate)
			edge = 3840
			if len(matches) == 3 {
				width, _ := strconv.Atoi(matches[1])
				height, _ := strconv.Atoi(matches[2])
				if width > 0 && height > 0 {
					edge = max(width, height)
				}
			}
		}
	}
	if edge >= 7680 && prices["base8kCredits"] > 0 {
		return "base8kCredits"
	}
	if edge >= 3840 {
		return "base4kCredits"
	}
	if edge >= 2048 {
		return "base2kCredits"
	}
	if edge >= 1248 {
		return "base1kCredits"
	}
	return "base1024Credits"
}

func roundUpImageCredits(value float64) float64 { return math.Ceil((value-1e-9)*100) / 100 }
func imageModerationPrice(value any, fallback float64) float64 {
	price := imageCreditValue(value, fallback)
	if math.IsNaN(price) || math.IsInf(price, 0) || price < 0 {
		return fallback
	}
	return price
}
