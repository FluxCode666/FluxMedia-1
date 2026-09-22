package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"unicode/utf16"
)

var videoModelIDs = []string{"sora2", "sora2-pro", "veo31", "veo31-fast", "veo31-ref", "kling-o3", "kling3", "kling3-omni", "runway-gen45", "ray314", "ray314-hdr", "seedance2", "seedance2-fast"}

func isVideoModel(id string) bool {
	for _, candidate := range videoModelIDs {
		if id == candidate {
			return true
		}
	}
	return false
}
func isLegacyVideoModel(id string) bool {
	id = strings.ToLower(strings.TrimSpace(id))
	if isVideoModel(id) {
		return false
	}
	candidate := strings.TrimPrefix(id, "firefly-")
	if candidate != id && isVideoModel(candidate) {
		return true
	}
	for _, model := range videoModelIDs {
		if strings.HasPrefix(candidate, model+"-") {
			return true
		}
	}
	return false
}
func normalizeModelID(id string) string {
	id = strings.TrimSpace(id)
	if id == "" || len(utf16.Encode([]rune(id))) > 120 {
		return ""
	}
	lower := strings.ToLower(id)
	if isVideoModel(lower) {
		return lower
	}
	if isLegacyVideoModel(id) {
		return id
	}
	if strings.HasPrefix(lower, "firefly-") {
		return id[len("firefly-"):]
	}
	return id
}

type modelAvailability struct {
	Enabled *bool `json:"enabled"`
}
type marketplaceModels struct {
	Version int                          `json:"version"`
	Image   map[string]modelAvailability `json:"imageByModel"`
	Video   map[string]modelAvailability `json:"videoByFamily"`
	Custom  []struct {
		ModelID  string `json:"modelId"`
		Category string `json:"category"`
	} `json:"customModels"`
}

func parseMarketplaceModels(value any) (marketplaceModels, error) {
	if value == nil {
		return marketplaceModels{}, nil
	}
	if s, ok := value.(string); ok {
		if s == "" {
			return marketplaceModels{}, nil
		}
		var parsed any
		if err := json.Unmarshal([]byte(s), &parsed); err != nil {
			return marketplaceModels{}, fmt.Errorf("invalid model configuration")
		}
		value = parsed
	}
	data, err := json.Marshal(value)
	if err != nil {
		return marketplaceModels{}, err
	}
	var config marketplaceModels
	if err := json.Unmarshal(data, &config); err != nil {
		return config, fmt.Errorf("invalid model configuration")
	}
	if config.Version != 1 && config.Version != 2 {
		return config, fmt.Errorf("unsupported model configuration version")
	}
	return config, nil
}
func visibleModelIDs(groups [][]string, config marketplaceModels) []string {
	customVideos := map[string]bool{}
	for _, model := range config.Custom {
		if model.Category == "video" {
			customVideos[strings.ToLower(strings.TrimSpace(model.ModelID))] = true
		}
	}
	ids := []string{}
	seen := map[string]bool{}
	for _, models := range groups {
		for _, model := range models {
			if isLegacyVideoModel(model) {
				continue
			}
			normalized := normalizeModelID(model)
			if normalized == "" {
				continue
			}
			key := strings.ToLower(normalized)
			if key == "default" {
				continue
			}
			entry := config.Image[key]
			if isVideoModel(strings.ToLower(strings.TrimSpace(model))) || customVideos[strings.ToLower(strings.TrimSpace(model))] {
				entry = config.Video[strings.ToLower(strings.TrimSpace(model))]
			}
			if entry.Enabled != nil && !*entry.Enabled {
				continue
			}
			if !seen[key] {
				seen[key] = true
				ids = append(ids, normalized)
			}
		}
	}
	return ids
}
func (b *backend) handleExternalModels(w http.ResponseWriter, r *http.Request) error {
	noStore(w)
	p, err := b.authenticateAPI(r)
	if err != nil {
		return err
	}
	userID, keyID := p.UserID, p.KeyID
	var group *string
	err = b.db.QueryRow(r.Context(), `SELECT COALESCE(generation_group_id,(SELECT CASE WHEN count(*)=1 THEN min(id) END FROM image_backend_group WHERE is_enabled AND is_default)) FROM external_api_key WHERE id=$1 AND user_id=$2`, keyID, userID).Scan(&group)
	if err != nil {
		return err
	}
	type model struct {
		ID      string `json:"id"`
		Object  string `json:"object"`
		Created int    `json:"created"`
		OwnedBy string `json:"owned_by"`
	}
	data := []model{}
	if group != nil {
		value, err := b.setting(r.Context(), "MODEL_MARKETPLACE_CONFIG", nil)
		if err != nil {
			return err
		}
		config, err := parseMarketplaceModels(value)
		if err != nil {
			return err
		}
		groupIDs, err := reachableMediaGroupIDs(r.Context(), b.db, *group)
		if err != nil {
			return err
		}
		rows, err := b.db.Query(r.Context(), `SELECT m.supported_model_ids FROM image_backend_member m JOIN image_backend_member_group g ON g.member_id=m.id WHERE g.group_id=ANY($1::text[]) AND m.is_enabled AND m.status<>'error' ORDER BY m.priority ASC,m.id ASC`, groupIDs)
		if err != nil {
			return err
		}
		defer rows.Close()
		groups := [][]string{}
		for rows.Next() {
			var raw []byte
			if err := rows.Scan(&raw); err != nil {
				return err
			}
			var models []string
			if err := json.Unmarshal(raw, &models); err != nil {
				return err
			}
			groups = append(groups, models)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		for _, id := range visibleModelIDs(groups, config) {
			data = append(data, model{ID: id, Object: "model", Created: 0, OwnedBy: "gpt2image"})
		}
	}
	writeJSON(w, 200, map[string]any{"object": "list", "data": data})
	return nil
}

// handleRuntimeModelCatalog returns the executable image/video IDs used by
// model configuration. It shares the Go member/group and marketplace source of truth.
func (b *backend) handleRuntimeModelCatalog(w http.ResponseWriter, r *http.Request) error {
	if _, err := b.requireAdminViewer(r); err != nil {
		return err
	}
	catalog, err := b.loadNativeModelCatalog(r)
	if err != nil {
		return err
	}
	images, videos := []string{}, []string{}
	for id, category := range catalog.Runtime {
		if category == "video" {
			if catalog.Video.Models[id].Enabled {
				videos = append(videos, id)
			}
		} else if boolOrDefault(goMapObject(goMapObject(catalog.Config, "imageByModel"), id)["enabled"], true) {
			images = append(images, id)
		}
	}
	sort.Strings(images)
	sort.Strings(videos)
	noStore(w)
	writeJSON(w, http.StatusOK, map[string]any{"image": images, "video": videos})
	return nil
}

func (b *backend) handlePublicModelMarketplace(w http.ResponseWriter, r *http.Request) error {
	catalog, err := b.loadNativeModelCatalog(r)
	if err != nil {
		return err
	}
	snapshot, err := nativeModelConfigurationSnapshot(catalog, false)
	if err != nil {
		return err
	}
	entries, _ := snapshot["entries"].([]map[string]any)
	items := []map[string]any{}
	for _, entry := range entries {
		key, category := stringValue(entry["configKey"]), stringValue(entry["category"])
		if entry["enabled"] == false || entry["visible"] == false || entry["pricingSource"] == "unconfigured" || catalog.Runtime[key] != category {
			continue
		}
		cover := entry["coverUrl"]
		if cover == nil {
			cover = "/model-marketplace/default-" + category + ".webp"
		}
		item := map[string]any{"configKey": key, "modelId": key, "category": category, "displayName": entry["displayName"], "iconKey": entry["iconKey"], "description": entry["description"], "coverUrl": cover, "minimumCredits": entry["minimumCredits"], "homepageVisible": entry["homepageVisible"], "homepagePriority": entry["homepagePriority"]}
		if category == "image" {
			item["priceUnit"], item["pricing"] = "per_image", entry["pricing"]
			for _, field := range []string{"supportedResolutions", "supportsQuality", "maxReferenceImages"} {
				if value, ok := entry[field]; ok {
					item[field] = value
				}
			}
		} else {
			cfg := catalog.Video.Models[key]
			cap := cfg.Capability
			item["supportedDurations"], item["supportedAspectRatios"], item["supportedResolutions"] = cap.Durations, cap.Ratios, cfg.SupportedResolutions
			item["input"] = map[string]any{"frames": cap.Frames, "referenceImages": map[string]any{"maxCount": cap.RefMax, "configurable": cap.RefConfig}, "framesAndReferencesMutuallyExclusive": true}
			item["audio"] = map[string]any{"supported": cap.Audio, "defaultEnabled": cap.AudioDefault}
			item["configuredReachable"] = true
			item["infrastructureLimits"] = map[string]any{"maxMediaInputCount": 256, "maxMediaInputBytes": 512 * 1024 * 1024}
			mode := entry["billingMode"]
			item["billingMode"], item["priceUnit"] = mode, mode
			if mode == "per_item" {
				item["creditsPerItem"], item["creditsPerItemByResolution"] = entry["minimumCredits"], entry["creditsPerItemByResolution"]
			} else {
				item["creditsPerSecond"], item["creditsPerSecondByResolution"] = entry["creditsPerSecond"], entry["creditsPerSecondByResolution"]
			}
		}
		items = append(items, item)
	}
	sort.Slice(items, func(i, j int) bool { return stringValue(items[i]["configKey"]) < stringValue(items[j]["configKey"]) })
	noStore(w)
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
	return nil
}

func marketplaceIconKey(key string) string {
	lower := strings.ToLower(key)
	switch {
	case strings.Contains(lower, "gpt-image"):
		return "openai"
	case strings.HasPrefix(lower, "veo"):
		return "google"
	case strings.HasPrefix(lower, "seedance"):
		return "bytedance"
	case strings.HasPrefix(lower, "kling"):
		return "kling"
	case strings.HasPrefix(lower, "runway"):
		return "runway"
	case strings.HasPrefix(lower, "grok"), strings.HasPrefix(lower, "xai"):
		return "xai"
	default:
		return "generic"
	}
}

func positiveNumber(value any, fallback float64) float64 {
	switch n := value.(type) {
	case float64:
		if n > 0 {
			return n
		}
	case int:
		if n > 0 {
			return float64(n)
		}
	case int64:
		if n > 0 {
			return float64(n)
		}
	}
	return fallback
}

func boolOrDefault(value any, fallback bool) bool {
	if v, ok := value.(bool); ok {
		return v
	}
	return fallback
}

func intOrDefault(value any, fallback int) int {
	switch n := value.(type) {
	case int:
		return n
	case int64:
		return int(n)
	case float64:
		return int(n)
	}
	return fallback
}

func normalizedImagePricing(pricing map[string]any) map[string]any {
	result := map[string]any{}
	for _, key := range []string{"base1024Credits", "base1kCredits", "base2kCredits", "base4kCredits"} {
		result[key] = positiveNumber(pricing[key], 1)
	}
	if value, ok := pricing["base8kCredits"]; ok {
		result["base8kCredits"] = positiveNumber(value, 1)
	}
	return result
}

func minImagePricing(pricing map[string]any) float64 {
	minimum := 0.0
	for _, value := range pricing {
		price := positiveNumber(value, 0)
		if price > 0 && (minimum == 0 || price < minimum) {
			minimum = price
		}
	}
	if minimum == 0 {
		return 1
	}
	return minimum
}
