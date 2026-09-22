package main

import (
	"context"
	"encoding/json"
	"math"
	"reflect"
	"strings"

	"github.com/jackc/pgx/v5"
)

func settingObject(value any) map[string]any {
	if text, ok := value.(string); ok {
		if json.Unmarshal([]byte(text), &value) != nil {
			return nil
		}
	}
	object, _ := value.(map[string]any)
	return object
}
func copySettingObject(value any) map[string]any {
	raw, _ := json.Marshal(value)
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	if out == nil {
		return map[string]any{}
	}
	return out
}
func positiveSettingPrice(value any, fallback float64) float64 {
	n, ok := value.(float64)
	if ok && n > 0 && !math.IsNaN(n) && !math.IsInf(n, 0) {
		return n
	}
	return fallback
}
func normalizedSettingsImagePricing(stored map[string]storedSystemSetting) map[string]any {
	defaults := copySettingObject(systemSettingDefinitionByKey["IMAGE_MODEL_CREDIT_PRICES"].DefaultValue)
	byModel := settingObject(defaults["byModel"])
	rawModels := settingObject(settingObject(stored["IMAGE_MODEL_CREDIT_PRICES"].Value)["byModel"])
	base := map[string]any{}
	for field, v := range settingObject(byModel["gpt-image-2"]) {
		base[field] = v
	}
	legacyBaseKeys := map[string]string{"base1024Credits": "IMAGE_BASE_CREDITS_1024", "base1kCredits": "IMAGE_BASE_CREDITS_1K", "base2kCredits": "IMAGE_BASE_CREDITS_2K", "base4kCredits": "IMAGE_BASE_CREDITS_4K"}
	for field, key := range legacyBaseKeys {
		base[field] = positiveSettingPrice(stored[key].Value, base[field].(float64))
	}
	for id, raw := range rawModels {
		if strings.EqualFold(strings.TrimSpace(id), "default") {
			for field, value := range settingObject(raw) {
				if fallback, ok := base[field].(float64); ok {
					base[field] = positiveSettingPrice(value, fallback)
				}
			}
		}
	}
	for id := range byModel {
		byModel[id] = copySettingObject(base)
	}
	for id, raw := range rawModels {
		if strings.TrimSpace(id) == "" || strings.EqualFold(strings.TrimSpace(id), "default") {
			continue
		}
		prices := copySettingObject(base)
		for field, value := range settingObject(raw) {
			if fallback, ok := prices[field].(float64); ok {
				prices[field] = positiveSettingPrice(value, fallback)
			}
		}
		byModel[id] = prices
	}
	return defaults
}
func normalizedSettingsVideoPricing(stored map[string]storedSystemSetting) (map[string]any, map[string]any, map[string]any, error) {
	modes := copySettingObject(systemSettingDefinitionByKey["VIDEO_MODEL_BILLING_MODES"].DefaultValue)
	items := copySettingObject(systemSettingDefinitionByKey["VIDEO_MODEL_CREDITS_PER_ITEM"].DefaultValue)
	seconds := copySettingObject(systemSettingDefinitionByKey["VIDEO_MODEL_CREDITS_PER_SECOND"].DefaultValue)
	rawSeconds := settingObject(stored["VIDEO_MODEL_CREDITS_PER_SECOND"].Value)
	// Legacy global pricing was sparse. Its fallback was the configured common
	// per-second rate; fill built-in resolution keys from their family price.
	if len(rawSeconds) > 0 {
		complete := true
		for key := range seconds {
			family := strings.SplitN(key, "@", 2)[0]
			if rawSeconds[key] == nil && rawSeconds[family] == nil {
				complete = false
				break
			}
		}
		if !complete {
			base := positiveSettingPrice(stored["VIDEO_BASE_CREDITS_PER_SECOND"].Value, 30)
			for key := range seconds {
				seconds[key] = base
			}
		}
	}
	for _, entry := range []struct {
		key    string
		values map[string]any
	}{{"VIDEO_MODEL_BILLING_MODES", modes}, {"VIDEO_MODEL_CREDITS_PER_ITEM", items}, {"VIDEO_MODEL_CREDITS_PER_SECOND", seconds}} {
		value := stored[entry.key].Value
		raw := settingObject(value)
		if configuredSetting(value) && raw == nil {
			return nil, nil, nil, invalid("视频计费设置必须是 JSON 对象")
		}
		for key, v := range raw {
			if entry.key == "VIDEO_MODEL_BILLING_MODES" {
				if v != "per_second" && v != "per_item" {
					return nil, nil, nil, invalid("视频计费模式无效")
				}
			} else if positiveSettingPrice(v, -1) < 0 {
				return nil, nil, nil, invalid("视频价格必须为正数")
			}
			entry.values[key] = v
		}
	}
	for key := range seconds {
		if strings.Contains(key, "@") && rawSeconds[key] == nil {
			family := strings.SplitN(key, "@", 2)[0]
			if price := rawSeconds[family]; price != nil {
				seconds[key] = price
			}
		}
	}
	marketplace := settingObject(stored["MODEL_MARKETPLACE_CONFIG"].Value)
	custom, _ := marketplace["customModels"].([]any)
	for _, raw := range custom {
		model := settingObject(raw)
		if model["category"] != "video" {
			continue
		}
		id, _ := model["modelId"].(string)
		resolutions, _ := model["supportedResolutions"].([]any)
		if id == "" || len(resolutions) == 0 {
			return nil, nil, nil, invalid("自定义视频模型计费描述无效")
		}
		if modes[id] == nil {
			modes[id] = "per_second"
		}
		price := positiveSettingPrice(rawSeconds[id], 30)
		for _, v := range resolutions {
			resolution, ok := v.(string)
			if !ok || resolution == "" {
				return nil, nil, nil, invalid("视频分辨率无效")
			}
			key := id + "@" + resolution
			if seconds[key] == nil {
				seconds[key] = price
			}
			if items[key] == nil {
				items[key] = float64(3)
			}
		}
	}
	return modes, items, seconds, nil
}
func migrateCompatibleSettings(ctx context.Context, tx pgx.Tx, stored map[string]storedSystemSetting, actor string) ([]string, error) {
	changed := []string{}
	save := func(key string, value any) error {
		if reflect.DeepEqual(stored[key].Value, value) {
			return nil
		}
		d := systemSettingDefinitionByKey[key]
		if _, err := writeSystemSetting(ctx, tx, d, value, actor, true); err != nil {
			return err
		}
		stored[key] = storedSystemSetting{Value: value}
		changed = append(changed, key)
		return nil
	}
	if !configuredSetting(stored["SYSTEM_ASSETS_BUCKET_NAME"].Value) {
		seen := map[string]bool{}
		legacyExists := false
		bucket := "system"
		for _, key := range []string{"MODEL_MARKETPLACE_ASSETS_BUCKET_NAME", "SITE_ASSETS_BUCKET_NAME", "NEXT_PUBLIC_AVATARS_BUCKET_NAME"} {
			if value, ok := stored[key].Value.(string); ok && strings.TrimSpace(value) != "" {
				legacyExists = true
				value = strings.TrimSpace(value)
				if seen[value] {
					bucket = value
					break
				}
				seen[value] = true
			}
		}
		if legacyExists {
			if err := save("SYSTEM_ASSETS_BUCKET_NAME", bucket); err != nil {
				return nil, err
			}
		}
	}
	if !configuredSetting(stored["GENERATIONS_BUCKET_NAME"].Value) && configuredSetting(stored["NEXT_PUBLIC_GENERATIONS_BUCKET_NAME"].Value) {
		if err := save("GENERATIONS_BUCKET_NAME", stored["NEXT_PUBLIC_GENERATIONS_BUCKET_NAME"].Value); err != nil {
			return nil, err
		}
	}
	if !configuredSetting(stored["CONTENT_MODERATION_PUBLIC_BASE_URL"].Value) && configuredSetting(stored["ALIYUN_MODERATION_PUBLIC_BASE_URL"].Value) {
		if err := save("CONTENT_MODERATION_PUBLIC_BASE_URL", stored["ALIYUN_MODERATION_PUBLIC_BASE_URL"].Value); err != nil {
			return nil, err
		}
	}
	if !configuredSetting(stored["VIDEO_MODEL_CREDITS_PER_SECOND"].Value) {
		if old := settingObject(stored["VIDEO_MODEL_MULTIPLIERS"].Value); len(old) > 0 {
			prices := map[string]any{}
			base := positiveSettingPrice(stored["VIDEO_BASE_CREDITS_PER_SECOND"].Value, 30)
			for key, value := range old {
				if multiplier := positiveSettingPrice(value, -1); multiplier > 0 {
					prices[key] = base * multiplier
				}
			}
			if err := save("VIDEO_MODEL_CREDITS_PER_SECOND", prices); err != nil {
				return nil, err
			}
		}
	}
	if configuredSetting(stored["IMAGE_MODEL_CREDIT_PRICES"].Value) {
		if err := save("IMAGE_MODEL_CREDIT_PRICES", normalizedSettingsImagePricing(stored)); err != nil {
			return nil, err
		}
	}
	modes, items, seconds, err := normalizedSettingsVideoPricing(stored)
	if err != nil {
		return nil, err
	}
	for _, entry := range []struct {
		key   string
		value any
	}{{"VIDEO_MODEL_BILLING_MODES", modes}, {"VIDEO_MODEL_CREDITS_PER_ITEM", items}, {"VIDEO_MODEL_CREDITS_PER_SECOND", seconds}} {
		if err := save(entry.key, entry.value); err != nil {
			return nil, err
		}
	}
	for _, key := range []string{"ALIYUN_MODERATION_PUBLIC_BASE_URL", "ALIYUN_MODERATION_BLOCK_RISK_LEVEL", "VIDEO_MODEL_MULTIPLIERS"} {
		if _, exists := stored[key]; exists {
			if _, err := tx.Exec(ctx, `DELETE FROM system_setting WHERE key=$1`, key); err != nil {
				return nil, err
			}
			delete(stored, key)
		}
	}
	return changed, nil
}
