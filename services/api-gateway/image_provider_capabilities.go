package main

import (
	"context"
	"encoding/json"
	"strings"
)

// Select only suppliers that can execute the request before reserving credits.
// Account/model overrides take precedence over the marketplace reference limit.
func (b *backend) imageProviderForInput(ctx context.Context, model string, group imageGroupSnapshot, safety bool, input map[string]json.RawMessage) (providerConfig, error) {
	groupIDs, err := reachableMediaGroupIDs(ctx, b.db, group.ID)
	if err != nil {
		return providerConfig{}, err
	}
	strategy, err := b.mediaSchedulingStrategy(ctx)
	if err != nil {
		return providerConfig{}, err
	}
	// This order is authoritative for new image admission: later capability
	// checks and the billing snapshot pin a single member, so ordering only
	// inside pickImageProvider cannot apply the administrator's chosen policy.
	rows, err := b.db.Query(ctx, `SELECT m.id,m.priority,m.supported_resolutions_by_model::jsonb FROM image_backend_member m WHERE EXISTS(SELECT 1 FROM image_backend_member_group mg WHERE mg.member_id=m.id AND mg.group_id=ANY($1::text[])) AND m.is_enabled AND m.type='api' ORDER BY CASE WHEN m.concurrency>(SELECT count(*) FROM image_backend_member_lease l WHERE l.member_id=m.id AND l.expires_at>now()) THEN 0 ELSE 1 END,`+mediaSchedulingOrder(strategy), groupIDs)
	if err != nil {
		return providerConfig{}, err
	}
	type candidate struct {
		id          string
		resolutions map[string][]string
	}
	candidates := []candidate{}
	for rows.Next() {
		var item candidate
		var priority int
		var raw []byte
		if err = rows.Scan(&item.id, &priority, &raw); err != nil {
			rows.Close()
			return providerConfig{}, err
		}
		_ = json.Unmarshal(raw, &item.resolutions)
		candidates = append(candidates, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return providerConfig{}, err
	}
	var body map[string]any
	_ = json.Unmarshal([]byte(mustJSON(input)), &body)
	refs, _ := body["images"].([]any)
	maxRefsValue, err := b.setting(ctx, "IMAGE_EDIT_MAX_REFERENCE_IMAGES", 16)
	if err != nil {
		return providerConfig{}, err
	}
	maxRefs := imageCreditValue(maxRefsValue, 16)
	marketplace, err := b.setting(ctx, "MODEL_MARKETPLACE_CONFIG", nil)
	if err != nil {
		return providerConfig{}, err
	}
	modelKey := strings.ToLower(strings.TrimSpace(model))
	entry := goMapObject(goMapObject(marketplace, "imageByModel"), modelKey)
	if value, ok := entry["maxReferenceImages"].(float64); ok {
		maxRefs = value
	}
	resolution := strings.ToLower(extractString(body, "resolution"))
	for _, candidate := range candidates {
		if allowed, exists := candidate.resolutions[modelKey]; exists && resolution != "" && !containsString(allowed, resolution) {
			continue
		}
		cfg, e := b.pickImageProvider(ctx, model, group, candidate.id, safety)
		if e != nil {
			if ae, ok := e.(*apiError); ok && ae.code == "NO_ELIGIBLE_MEDIA_PROVIDER" {
				continue
			}
			return cfg, e
		}
		limit := maxRefs
		if value, exists := cfg.adapter["imageMaxReferenceImages"]; exists {
			limit = imageCreditValue(value, limit)
		}
		if value, exists := goMapObject(cfg.adapter, "imageMaxReferenceImagesByModel")[modelKey]; exists {
			limit = imageCreditValue(value, limit)
		}
		if float64(len(refs)) > limit {
			continue
		}
		if _, e = imageProviderParameters(cfg, model, body); e != nil {
			continue
		}
		if cfg.adapter["convertReferenceImagesToPublicUrl"] == true && (len(refs) > 10 || body["mask"] != nil) {
			continue
		}
		return cfg, nil
	}
	return providerConfig{}, &apiError{503, "NO_ELIGIBLE_MEDIA_PROVIDER", "已授权分组中没有支持当前分辨率、尺寸和参考图数量的供应商"}
}
