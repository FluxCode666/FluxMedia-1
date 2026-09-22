package main

import (
	"encoding/json"
	"net/http"
	"sort"
	"strings"
)

func (b *backend) handleImageEffectiveConfig(w http.ResponseWriter, r *http.Request) error {
	p, err := b.imageUOLPrincipal(r)
	if err != nil {
		return err
	}
	var input struct {
		UserID         string `json:"userId"`
		Model          string `json:"model"`
		BackendGroupID string `json:"backendGroupId"`
	}
	if err = decodeBody(r, &input); err != nil {
		return err
	}
	if input.UserID != "" && input.UserID != p.UserID {
		return forbidden()
	}
	group, err := b.resolveImageGroup(r.Context(), p, input.BackendGroupID)
	if err != nil {
		return err
	}
	value, err := b.setting(r.Context(), "MODEL_MARKETPLACE_CONFIG", map[string]any{})
	if err != nil {
		return err
	}
	var marketplace map[string]any
	if encoded, ok := value.(string); ok {
		if json.Unmarshal([]byte(encoded), &marketplace) != nil {
			return invalid("Invalid model configuration")
		}
	} else {
		marketplace, _ = value.(map[string]any)
	}
	imageConfig := goMapObject(marketplace, "imageByModel")
	groupIDs, err := reachableMediaGroupIDs(r.Context(), b.db, group.ID)
	if err != nil {
		return err
	}
	rows, err := b.db.Query(r.Context(), `SELECT DISTINCT lower(trim(models.id)) FROM image_backend_member m JOIN image_backend_member_group mg ON mg.member_id=m.id AND mg.group_id=ANY($1::text[]) JOIN image_backend_member_api_config c ON c.member_id=m.id JOIN image_backend_member_api_adapter_version v ON v.id=c.current_adapter_version_id AND v.member_id_snapshot=m.id AND v.credential_scope=c.credential_scope CROSS JOIN LATERAL jsonb_array_elements_text(m.supported_model_ids::jsonb) models(id) WHERE m.is_enabled AND m.type='api' AND m.status<>'error' AND v.configuration::jsonb->'operations' ? 'images.generate'`, groupIDs)
	if err != nil {
		return err
	}
	defer rows.Close()
	available := []string{}
	for rows.Next() {
		var model string
		if err := rows.Scan(&model); err != nil {
			return err
		}
		entry := goMapObject(imageConfig, model)
		if model != "" && model != "default" && !isVideoModel(model) && !isLegacyVideoModel(model) && entry["enabled"] != false {
			available = append(available, model)
		}
	}
	if err = rows.Err(); err != nil {
		return err
	}
	sort.Strings(available)
	model := strings.ToLower(strings.TrimSpace(input.Model))
	if model == "" && len(available) > 0 {
		model = available[0]
	}
	if !containsString(available, model) {
		return &apiError{503, "NO_ELIGIBLE_MEDIA_PROVIDER", "The selected group has no configured provider for this image model"}
	}
	entry := goMapObject(imageConfig, model)
	resolution := "1k"
	if resolutions := goStringSlice(entry["supportedResolutions"]); len(resolutions) > 0 && !containsString(resolutions, resolution) {
		resolution = resolutions[0]
	}
	noStore(w)
	writeJSON(w, 200, map[string]any{"model": model, "aspectRatio": "1:1", "resolution": resolution, "quality": "standard", "backendGroupId": group.ID, "backendGroupName": group.Name, "maxCount": 1, "availableModels": available})
	return nil
}
