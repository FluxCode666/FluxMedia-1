package main

// The generate page data endpoint is the single first-party read boundary for
// the image/video creation workspace. It intentionally combines the small
// user-scoped reads that were previously performed by a Next.js server page.

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
)

func (b *backend) handleImageGenerationPageData(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireSession(r)
	if err != nil {
		return err
	}

	var balance float64
	if _, err = b.db.Exec(r.Context(), `INSERT INTO credits_balance(id,user_id) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING`, newRequestID(), s.User.ID); err != nil {
		return err
	}
	if err = b.db.QueryRow(r.Context(), `SELECT balance FROM credits_balance WHERE user_id=$1`, s.User.ID).Scan(&balance); err != nil {
		return err
	}

	recentRows, err := b.db.Query(r.Context(), `SELECT id,user_id,prompt,revised_prompt,model,size,status,storage_key,storage_bucket,credits_consumed,error,metadata,created_at,completed_at FROM generation WHERE user_id=$1 AND ((status='completed' AND storage_key IS NOT NULL) OR status='pending') ORDER BY created_at DESC LIMIT 12`, s.User.ID)
	if err != nil {
		return err
	}
	recent := make([]any, 0, 12)
	for recentRows.Next() {
		v := generationDTO{}
		if err := recentRows.Scan(&v.ID, &v.UserID, &v.Prompt, &v.RevisedPrompt, &v.Model, &v.Size, &v.Status, &v.StorageKey, &v.StorageBucket, &v.CreditsConsumed, &v.Error, &v.Metadata, &v.CreatedAt, &v.CompletedAt); err != nil {
			recentRows.Close()
			return err
		}
		recent = append(recent, publicGeneration(v))
	}
	if err := recentRows.Err(); err != nil {
		recentRows.Close()
		return err
	}
	recentRows.Close()

	media, err := b.imageGenerationMediaLimits(r)
	if err != nil {
		return err
	}
	catalog, selectedGroupID, err := b.imageGenerationCatalog(r)
	if err != nil {
		return err
	}
	moderationEnabled, err := b.settingBool(r.Context(), "CONTENT_MODERATION_ENABLED", true)
	if err != nil {
		return err
	}
	modelPricing, err := b.imageGenerationModelPricing(r)
	if err != nil {
		return err
	}
	textModeration, err := b.settingNumber(r, "IMAGE_TEXT_MODERATION_CREDITS", 0.04)
	if err != nil {
		return err
	}
	imageModeration, err := b.settingNumber(r, "IMAGE_INPUT_MODERATION_CREDITS", 0.06)
	if err != nil {
		return err
	}

	writeJSON(w, 200, map[string]any{
		"balance":                     balance,
		"recentGenerations":           recent,
		"uploadLimits":                media,
		"selectedBackendGroupId":      selectedGroupID,
		"imageGenerationModelCatalog": catalog,
		"moderationEnabled":           moderationEnabled,
		"imageModelPricing":           modelPricing,
		"imageModerationPricing":      map[string]any{"textModerationCredits": textModeration, "imageModerationCredits": imageModeration},
	})
	return nil
}

func (b *backend) imageGenerationMediaLimits(r *http.Request) (map[string]any, error) {
	fileMB, err := b.settingInt(r, "MEDIA_MAX_FILE_SIZE_MB", 5, 1, 200)
	if err != nil {
		return nil, err
	}
	uploadMB, err := b.settingInt(r, "MEDIA_MAX_UPLOAD_SIZE_MB", 75, 1, 512)
	if err != nil {
		return nil, err
	}
	refs, err := b.settingInt(r, "IMAGE_EDIT_MAX_REFERENCE_IMAGES", 16, 1, 256)
	if err != nil {
		return nil, err
	}
	return map[string]any{"maxFileSizeBytes": fileMB * 1024 * 1024, "maxUploadBytes": uploadMB * 1024 * 1024, "maxEditImages": refs}, nil
}

func (b *backend) settingNumber(r *http.Request, key string, fallback float64) (float64, error) {
	v, err := b.setting(r.Context(), key, fallback)
	if err != nil {
		return 0, err
	}
	switch n := v.(type) {
	case float64:
		return n, nil
	case int:
		return float64(n), nil
	case string:
		if parsed, parseErr := strconv.ParseFloat(strings.TrimSpace(n), 64); parseErr == nil {
			return parsed, nil
		}
	}
	return fallback, nil
}

func (b *backend) settingInt(r *http.Request, key string, fallback, min, max int) (int, error) {
	n, err := b.settingNumber(r, key, float64(fallback))
	if err != nil {
		return 0, err
	}
	value := int(n)
	if n != float64(value) || value < min || value > max {
		return fallback, nil
	}
	return value, nil
}

func (b *backend) imageGenerationModelPricing(r *http.Request) (map[string]any, error) {
	v, err := b.setting(r.Context(), "IMAGE_MODEL_CREDIT_PRICES", nil)
	if err != nil {
		return nil, err
	}
	if s, ok := v.(string); ok {
		var parsed any
		if json.Unmarshal([]byte(s), &parsed) == nil {
			v = parsed
		}
	}
	if value, ok := v.(map[string]any); ok {
		if byModel, ok := value["byModel"].(map[string]any); ok && len(byModel) > 0 {
			if version, ok := value["version"].(float64); !ok || version == 1 {
				return value, nil
			}
		}
	}
	return map[string]any{"version": 1, "byModel": map[string]any{}}, nil
}

func (b *backend) imageGenerationCatalog(r *http.Request) (map[string]any, *string, error) {
	groups, err := b.backendPoolGroups(r)
	if err != nil {
		return nil, nil, err
	}
	members, err := b.backendPoolMembers(r)
	if err != nil {
		return nil, nil, err
	}
	value, err := b.setting(r.Context(), "MODEL_MARKETPLACE_CONFIG", nil)
	if err != nil {
		return nil, nil, err
	}
	config := map[string]any{}
	if encoded, ok := value.(string); ok {
		_ = json.Unmarshal([]byte(encoded), &config)
	} else if object, ok := value.(map[string]any); ok {
		config = object
	}
	imageConfig, _ := config["imageByModel"].(map[string]any)
	if imageConfig != nil {
		normalizedConfig := make(map[string]any, len(imageConfig))
		for key, item := range imageConfig {
			normalizedConfig[strings.ToLower(strings.TrimSpace(key))] = item
		}
		imageConfig = normalizedConfig
	}
	customVideo := map[string]bool{}
	customModels, _ := config["customModels"].([]any)
	for _, raw := range customModels {
		if model, ok := raw.(map[string]any); ok && strings.EqualFold(stringValue(model["category"]), "video") {
			customVideo[strings.ToLower(strings.TrimSpace(stringValue(model["modelId"])))] = true
		}
	}

	effective := map[string]any{}
	defaultCount := 0
	for _, group := range groups {
		if boolValue(group["isEnabled"]) && boolValue(group["isDefault"]) {
			defaultCount++
			effective = group
		}
	}
	if defaultCount != 1 {
		effective = nil
	}
	var selected *string
	if effective != nil {
		id := stringValue(effective["id"])
		selected = &id
	}
	visible := make([]map[string]any, 0)
	for _, group := range groups {
		if !boolValue(group["isEnabled"]) || effective == nil {
			continue
		}
		if group["id"] != effective["id"] && !boolValue(group["isUserSelectable"]) {
			continue
		}
		visible = append(visible, group)
	}

	globalMaxRefs := 16
	if n, e := b.settingInt(r, "IMAGE_EDIT_MAX_REFERENCE_IMAGES", 16, 1, 256); e == nil {
		globalMaxRefs = n
	}
	groupsOut := make([]map[string]any, 0, len(visible))
	for _, group := range visible {
		groupID := stringValue(group["id"])
		groupIDs, err := reachableMediaGroupIDs(r.Context(), b.db, groupID)
		if err != nil {
			return nil, nil, err
		}
		modelMap := map[string]map[string]any{}
		for _, raw := range members {
			member, ok := raw.(map[string]any)
			if !ok || !boolValue(member["isEnabled"]) || stringValue(member["status"]) == "error" {
				continue
			}
			belongs := false
			for _, gid := range stringSlice(member["groupIds"]) {
				if containsString(groupIDs, gid) {
					belongs = true
				}
			}
			if !belongs {
				continue
			}
			memberConfig, _ := member["config"].(map[string]any)
			memberMax := numberValue(memberConfig["imageMaxReferenceImages"])
			memberByModel, _ := memberConfig["imageMaxReferenceImagesByModel"].(map[string]any)
			for _, rawID := range stringSlice(member["supportedModelIds"]) {
				id := normalizeModelID(rawID)
				key := strings.ToLower(id)
				if id == "" || key == "default" || isVideoModel(key) || isLegacyVideoModel(id) || customVideo[key] {
					continue
				}
				if override, ok := imageConfig[key].(map[string]any); ok && override["enabled"] == false {
					continue
				}
				entry := modelMap[key]
				if entry == nil {
					entry = map[string]any{"id": id, "capabilities": map[string]any{"generate": true, "edit": true, "mask": true}}
					if override, ok := imageConfig[key].(map[string]any); ok {
						if override["supportsQuality"] == true {
							entry["supportsQuality"] = true
						}
						if n := numberValue(override["maxReferenceImages"]); n > 0 {
							entry["maxReferenceImages"] = n
						}
						if resolutions, ok := override["supportedResolutions"].([]any); ok {
							entry["supportedResolutions"] = resolutions
						}
					}
				}
				if memberByModel != nil {
					if n := numberValue(memberByModel[key]); n > numberValue(entry["maxReferenceImages"]) {
						entry["maxReferenceImages"] = n
					}
				}
				if memberMax > numberValue(entry["maxReferenceImages"]) {
					entry["maxReferenceImages"] = memberMax
				} else if _, exists := entry["maxReferenceImages"]; !exists {
					entry["maxReferenceImages"] = globalMaxRefs
				}
				modelMap[key] = entry
			}
		}
		models := make([]map[string]any, 0, len(modelMap))
		for _, model := range modelMap {
			models = append(models, model)
		}
		sort.Slice(models, func(i, j int) bool { return stringValue(models[i]["id"]) < stringValue(models[j]["id"]) })
		groupsOut = append(groupsOut, map[string]any{"id": groupID, "name": group["name"], "isDefault": groupID == stringValue(func() any {
			if effective == nil {
				return nil
			}
			return effective["id"]
		}()), "imageCreditOverrides": group["imageCreditOverrides"], "models": models})
	}
	return map[string]any{"groups": groupsOut}, selected, nil
}

func boolValue(v any) bool     { b, _ := v.(bool); return b }
func stringValue(v any) string { s, _ := v.(string); return s }
func numberValue(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case int64:
		return int(n)
	}
	return 0
}
func stringSlice(v any) []string {
	result := []string{}
	if values, ok := v.([]any); ok {
		for _, value := range values {
			if s, ok := value.(string); ok {
				result = append(result, s)
			}
		}
	}
	return result
}
