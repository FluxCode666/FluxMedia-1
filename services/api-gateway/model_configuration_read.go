package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"
)

type nativeModelCatalog struct {
	Settings map[string]map[string]any
	Config   map[string]any
	Video    goVideoPricingContext
	Runtime  map[string]string
}

var modelConfigurationSettingKeys = []string{"MODEL_MARKETPLACE_CONFIG", "IMAGE_MODEL_CREDIT_PRICES", "VIDEO_MODEL_CREDITS_PER_SECOND", "VIDEO_MODEL_CREDITS_PER_ITEM", "VIDEO_MODEL_BILLING_MODES", "VIDEO_MODEL_CAPABILITY_OVERRIDES"}

func decodeModelSetting(value any) (map[string]any, error) {
	if encoded, ok := value.(string); ok {
		if err := json.Unmarshal([]byte(encoded), &value); err != nil {
			return nil, err
		}
	}
	result, ok := value.(map[string]any)
	if !ok {
		return nil, errors.New("Invalid model configuration object")
	}
	return result, nil
}

func (b *backend) loadNativeModelCatalog(r *http.Request) (nativeModelCatalog, error) {
	state := nativeModelCatalog{Settings: map[string]map[string]any{}, Runtime: map[string]string{}}
	settings := map[string]any{}
	for _, key := range modelConfigurationSettingKeys {
		fallback := systemSettingDefinitionByKey[key].DefaultValue
		if fallback == nil {
			fallback = map[string]any{}
		}
		value, err := b.setting(r.Context(), key, fallback)
		if err != nil {
			return state, err
		}
		object, err := decodeModelSetting(value)
		if err != nil {
			return state, err
		}
		state.Settings[key] = object
		settings[key] = object
	}
	state.Config = state.Settings["MODEL_MARKETPLACE_CONFIG"]
	bucket, _, err := b.storageBuckets(r.Context())
	if err != nil {
		return state, err
	}
	if err = validateModelConfigurationCovers(state.Config, bucket); err != nil {
		return state, err
	}
	for _, section := range []string{"imageByModel", "videoByFamily", "writeReceipts"} {
		if state.Config[section] == nil {
			state.Config[section] = map[string]any{}
		}
	}
	video, err := configureGoVideoModels(goVideoPricingContext{Settings: state.Settings, Models: map[string]goVideoModelConfig{}, Reachable: map[string]bool{}}, settings)
	if err != nil {
		return state, err
	}
	state.Video = video
	groupIDs, err := publicModelGroupIDs(r.Context(), b.db)
	if err != nil {
		return state, err
	}
	rows, err := b.db.Query(r.Context(), `SELECT m.supported_model_ids,COALESCE((v.configuration::jsonb->'operations' ? 'images.generate'),false),COALESCE((v.configuration::jsonb->'operations' ? 'videos.generate'),false) FROM image_backend_member m JOIN image_backend_member_group mg ON mg.member_id=m.id JOIN image_backend_group g ON g.id=mg.group_id JOIN image_backend_member_api_config c ON c.member_id=m.id JOIN image_backend_member_api_adapter_version v ON v.id=c.current_adapter_version_id AND v.member_id_snapshot=m.id AND v.credential_scope=c.credential_scope WHERE m.is_enabled AND m.status<>'error' AND m.type='api' AND g.id=ANY($1::text[])`, groupIDs)
	if err != nil {
		return state, err
	}
	defer rows.Close()
	for rows.Next() {
		var raw []byte
		var image, video bool
		if err = rows.Scan(&raw, &image, &video); err != nil {
			return state, err
		}
		var ids []string
		if json.Unmarshal(raw, &ids) != nil {
			return state, errors.New("Invalid member model catalog")
		}
		for _, id := range ids {
			id = strings.ToLower(normalizeModelID(id))
			if id == "" || id == "default" || isLegacyVideoModel(id) {
				continue
			}
			if _, isVideo := state.Video.Models[id]; isVideo {
				if video {
					state.Runtime[id] = "video"
					state.Video.Reachable[id] = true
				}
			} else if image {
				state.Runtime[id] = "image"
			}
		}
	}
	return state, rows.Err()
}

func modelConfigurationCover(entry map[string]any) any {
	cover := goMapObject(entry, "cover")
	bucket, key := stringValue(cover["bucket"]), stringValue(cover["key"])
	if bucket != "" && modelCoverKeyPattern.MatchString(key) && validStorageObjectPath(bucket, key) {
		return "/api/storage/" + urlPathEscape(bucket) + "/" + urlPathEscape(key)
	}
	return nil
}

func nativeModelManagementFields(key, category string, config map[string]any, custom bool) map[string]any {
	section := "imageByModel"
	if category == "video" {
		section = "videoByFamily"
	}
	entry := goMapObject(goMapObject(config, section), key)
	name := key
	if cap, ok := goVideoCapabilities[key]; ok {
		name = cap.Display
	}
	cover := modelConfigurationCover(entry)
	icon := marketplaceIconKey(key)
	if value := stringValue(entry["iconKey"]); value != "" {
		icon = value
	}
	return map[string]any{"configKey": key, "category": category, "displayName": name, "iconKey": icon, "marketplaceApplicable": true, "isCustom": custom, "enabled": boolOrDefault(entry["enabled"], true), "visible": boolOrDefault(entry["visible"], true), "homepageVisible": boolOrDefault(entry["homepageVisible"], category == "image"), "homepagePriority": intOrDefault(entry["homepagePriority"], 5), "description": stringValue(entry["description"]), "coverUrl": cover, "usesDefaultCover": cover == nil, "revision": goInt64(entry["revision"])}
}

func nativeModelConfigurationSnapshot(state nativeModelCatalog, canEdit bool) (map[string]any, error) {
	custom := map[string]map[string]any{}
	if items, ok := state.Config["customModels"].([]any); ok {
		for _, value := range items {
			entry, ok := value.(map[string]any)
			if ok {
				custom[stringValue(entry["modelId"])] = entry
			}
		}
	}
	imagePrices := goMapObject(state.Settings["IMAGE_MODEL_CREDIT_PRICES"], "byModel")
	imageIDs := map[string]bool{}
	for key, category := range state.Runtime {
		if category == "image" {
			imageIDs[key] = true
		}
	}
	for key := range imagePrices {
		if key != "default" {
			imageIDs[key] = true
		}
	}
	for key := range goMapObject(state.Config, "imageByModel") {
		imageIDs[key] = true
	}
	for key, model := range custom {
		if model["category"] == "image" {
			imageIDs[key] = true
		}
	}
	entries := []map[string]any{}
	for key := range imageIDs {
		entry := nativeModelManagementFields(key, "image", state.Config, custom[key] != nil)
		config := goMapObject(goMapObject(state.Config, "imageByModel"), key)
		for _, field := range []string{"supportedResolutions", "supportsQuality", "maxReferenceImages"} {
			if value, ok := config[field]; ok {
				entry[field] = value
			} else if value, ok := custom[key][field]; ok {
				entry[field] = value
			}
		}
		pricing, ok := imagePrices[key].(map[string]any)
		complete := ok
		for _, field := range []string{"base1024Credits", "base1kCredits", "base2kCredits", "base4kCredits"} {
			if positiveNumber(pricing[field], 0) <= 0 {
				complete = false
			}
		}
		if complete {
			entry["pricingSource"] = "explicit"
			entry["pricing"] = pricing
			entry["minimumCredits"] = minImagePricing(pricing)
		} else {
			entry["pricingSource"] = "unconfigured"
		}
		entries = append(entries, entry)
	}
	seconds, items := goNumberMap(state.Settings["VIDEO_MODEL_CREDITS_PER_SECOND"]), goNumberMap(state.Settings["VIDEO_MODEL_CREDITS_PER_ITEM"])
	for key, cfg := range state.Video.Models {
		entry := nativeModelManagementFields(key, "video", state.Config, cfg.Custom)
		sec, item := map[string]any{}, map[string]any{}
		minSec, minItem := 0.0, 0.0
		complete := true
		for _, res := range cfg.SupportedResolutions {
			price, unitPrice := seconds[key+"@"+strings.ToLower(res)], items[key+"@"+strings.ToLower(res)]
			if price <= 0 || unitPrice <= 0 {
				complete = false
			}
			sec[res], item[res] = price, unitPrice
			if minSec == 0 || price < minSec {
				minSec = price
			}
			if minItem == 0 || unitPrice < minItem {
				minItem = unitPrice
			}
		}
		entry["pricingSource"] = "explicit"
		if !complete {
			entry["pricingSource"] = "unconfigured"
		}
		mode := stringValue(state.Settings["VIDEO_MODEL_BILLING_MODES"][key])
		if mode == "" {
			mode = cfg.BillingMode
		}
		entry["billingMode"], entry["creditsPerSecond"], entry["creditsPerSecondByResolution"], entry["creditsPerItemByResolution"], entry["supportedResolutions"] = mode, minSec, sec, item, cfg.SupportedResolutions
		entry["minimumCredits"] = minSec
		if mode == "per_item" {
			entry["minimumCredits"] = minItem
		}
		if cfg.Capability.RefConfig {
			entry["maxReferenceImages"] = cfg.Capability.RefMax
		}
		entries = append(entries, entry)
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i]["category"] != entries[j]["category"] {
			return stringValue(entries[i]["category"]) < stringValue(entries[j]["category"])
		}
		return stringValue(entries[i]["configKey"]) < stringValue(entries[j]["configKey"])
	})
	return map[string]any{"entries": entries, "canEdit": canEdit, "runtimeCatalogStatus": "ready"}, nil
}

// Public discovery follows enabled child groups of every default/selectable
// root, using the same traversal rules as authenticated generation routing.
func publicModelGroupIDs(ctx context.Context, db videoPricingStore) ([]string, error) {
	var ids []string
	err := db.QueryRow(ctx, `WITH RECURSIVE visible(id,metadata) AS (
 SELECT id,metadata::jsonb FROM image_backend_group WHERE is_enabled AND (is_default OR is_user_selectable)
 UNION
 SELECT child.id,child.metadata::jsonb FROM visible parent
 CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(parent.metadata->'childGroupIds')='array' THEN parent.metadata->'childGroupIds' ELSE '[]'::jsonb END) edge(id)
 JOIN image_backend_group child ON child.id=edge.id AND child.is_enabled
 ) SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::text[]) FROM visible`).Scan(&ids)
	return ids, err
}
