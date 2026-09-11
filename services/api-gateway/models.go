package main

import (
	"encoding/json"
	"fmt"
	"net/http"
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
	var group *string
	err = b.db.QueryRow(r.Context(), `SELECT COALESCE(generation_group_id,(SELECT CASE WHEN count(*)=1 THEN min(id) END FROM image_backend_group WHERE is_enabled AND is_default)) FROM external_api_key WHERE id=$1 AND user_id=$2`, p.KeyID, p.UserID).Scan(&group)
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
