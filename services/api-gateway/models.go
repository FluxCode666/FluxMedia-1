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
	var userID, keyID string
	if principal, ok := b.signedInternalPrincipal(r); ok && principal.Type == "apiKey" && principal.CredentialKind == "external" {
		userID, keyID = principal.UserID, principal.APIKeyID
	} else {
		p, err := b.authenticateAPI(r)
		if err != nil {
			return err
		}
		userID, keyID = p.UserID, p.KeyID
	}
	var group *string
	err := b.db.QueryRow(r.Context(), `SELECT COALESCE(generation_group_id,(SELECT CASE WHEN count(*)=1 THEN min(id) END FROM image_backend_group WHERE is_enabled AND is_default)) FROM external_api_key WHERE id=$1 AND user_id=$2`, keyID, userID).Scan(&group)
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
		rows, err := b.db.Query(r.Context(), `SELECT m.supported_model_ids FROM image_backend_member m JOIN image_backend_member_group g ON g.member_id=m.id WHERE g.group_id=$1 AND m.is_enabled AND m.status<>'error' ORDER BY m.priority ASC,m.id ASC`, *group)
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
	value, err := b.setting(r.Context(), "MODEL_MARKETPLACE_CONFIG", nil)
	if err != nil {
		return err
	}
	config, err := parseMarketplaceModels(value)
	if err != nil {
		return err
	}
	rows, err := b.db.Query(r.Context(), `SELECT m.supported_model_ids FROM image_backend_member m JOIN image_backend_member_group mg ON mg.member_id=m.id JOIN image_backend_group g ON g.id=mg.group_id WHERE m.is_enabled AND m.status<>'error' AND g.is_enabled AND (g.is_default OR g.is_user_selectable) ORDER BY m.priority ASC,m.id ASC`)
	if err != nil {
		return err
	}
	defer rows.Close()
	groups := make([][]string, 0)
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			return err
		}
		var ids []string
		if err := json.Unmarshal(raw, &ids); err != nil {
			continue
		}
		groups = append(groups, ids)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	images, videos := []string{}, []string{}
	for _, id := range visibleModelIDs(groups, config) {
		if isVideoModel(strings.ToLower(strings.TrimSpace(id))) {
			videos = append(videos, id)
		} else {
			images = append(images, id)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"image": images, "video": videos})
	return nil
}

// handlePublicModelMarketplace exposes the read-only catalog consumed by the
// marketing models page.  The page is intentionally anonymous, while the
// source of truth remains the same backend member and marketplace settings
// used by the authenticated model configuration endpoint.
func (b *backend) handlePublicModelMarketplace(w http.ResponseWriter, r *http.Request) error {
	snapshot, err := b.modelConfigurationRead(r, false)
	if err != nil {
		return err
	}
	entries, _ := snapshot["entries"].([]map[string]any)
	items := make([]map[string]any, 0, len(entries))
	for _, entry := range entries {
		if entry["enabled"] == false || entry["visible"] == false {
			continue
		}
		key := strings.TrimSpace(fmt.Sprint(entry["configKey"]))
		if key == "" {
			continue
		}
		category := strings.TrimSpace(fmt.Sprint(entry["category"]))
		if category != "image" && category != "video" {
			continue
		}
		description := strings.TrimSpace(fmt.Sprint(entry["description"]))
		if description == "<nil>" {
			description = ""
		}
		item := map[string]any{
			"configKey":        key,
			"modelId":          key,
			"displayName":      fmt.Sprint(entry["displayName"]),
			"iconKey":          marketplaceIconKey(key),
			"description":      description,
			"coverUrl":         fmt.Sprintf("/model-marketplace/default-%s.webp", category),
			"minimumCredits":   positiveNumber(entry["minimumCredits"], 1),
			"homepageVisible":  boolOrDefault(entry["homepageVisible"], false),
			"homepagePriority": intOrDefault(entry["homepagePriority"], 0),
		}
		if category == "image" {
			pricing, ok := entry["pricing"].(map[string]any)
			if !ok || pricing == nil {
				// Unpriced models are intentionally hidden from the public catalog.
				continue
			}
			item["category"] = "image"
			item["priceUnit"] = "per_image"
			normalizedPricing := normalizedImagePricing(pricing)
			item["pricing"] = normalizedPricing
			item["minimumCredits"] = minImagePricing(normalizedPricing)
			for _, field := range []string{"supportedResolutions", "supportsQuality", "maxReferenceImages"} {
				if value, exists := entry[field]; exists {
					item[field] = value
				}
			}
		} else {
			item["category"] = "video"
			item["supportedDurations"] = []int{5, 10}
			item["supportedAspectRatios"] = []string{"1:1", "16:9", "9:16"}
			resolutions := []string{"720p"}
			if values, ok := entry["supportedResolutions"].([]string); ok && len(values) > 0 {
				resolutions = values
			}
			item["supportedResolutions"] = resolutions
			item["input"] = map[string]any{"frames": "none", "referenceImages": map[string]any{"maxCount": 0, "configurable": false}, "framesAndReferencesMutuallyExclusive": true}
			item["audio"] = map[string]any{"supported": false, "defaultEnabled": false}
			item["configuredReachable"] = true
			item["infrastructureLimits"] = map[string]any{"maxMediaInputCount": 256, "maxMediaInputBytes": 512 * 1024 * 1024}
			mode := strings.TrimSpace(fmt.Sprint(entry["billingMode"]))
			if mode == "per_item" {
				item["billingMode"], item["priceUnit"] = "per_item", "per_item"
				item["creditsPerItem"] = positiveNumber(entry["minimumCredits"], 1)
				item["creditsPerItemByResolution"] = map[string]any{"720p": positiveNumber(entry["minimumCredits"], 1)}
			} else {
				item["billingMode"], item["priceUnit"] = "per_second", "per_second"
				item["creditsPerSecond"] = positiveNumber(entry["creditsPerSecond"], 1)
				item["creditsPerSecondByResolution"] = map[string]any{"720p": positiveNumber(entry["creditsPerSecond"], 1)}
			}
		}
		items = append(items, item)
	}
	sort.SliceStable(items, func(i, j int) bool {
		return fmt.Sprint(items[i]["configKey"]) < fmt.Sprint(items[j]["configKey"])
	})
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
