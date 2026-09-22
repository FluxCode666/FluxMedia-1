package main

import (
	"math"
	"regexp"
	"strings"
)

var poolResolutionLabel = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,31}$`)

func poolBlockedAuthHeader(header string) bool {
	key := strings.ToLower(header)
	return len(header) > 256 || containsString([]string{"authorization", "connection", "content-length", "content-type", "cookie", "forwarded", "host", "keep-alive", "origin", "referer", "te", "trailer", "transfer-encoding", "upgrade", "via", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"}, key) || strings.HasPrefix(key, "proxy-") || strings.HasPrefix(key, "sec-") || strings.HasPrefix(key, "x-fluxmedia-")
}
func validatePoolModelOverrides(in *poolMemberWrite) error {
	supported := map[string]bool{}
	for _, id := range in.Models {
		supported[strings.ToLower(id)] = true
	}
	resolutions := map[string][]string{}
	for model, values := range in.Resolutions {
		model = strings.ToLower(strings.TrimSpace(model))
		if _, exists := resolutions[model]; exists {
			return invalid("模型分辨率覆盖不能重复")
		}
		seen := map[string]bool{}
		normalized := []string{}
		for _, v := range values {
			v = strings.ToLower(strings.TrimSpace(v))
			if !poolResolutionLabel.MatchString(v) || seen[v] {
				return invalid("模型分辨率无效或重复")
			}
			seen[v] = true
			normalized = append(normalized, v)
		}
		resolutions[model] = normalized
	}
	in.Resolutions = resolutions
	for _, key := range []string{"imageSizeConfigIdsByModel", "imageMaxReferenceImagesByModel", "videoInputCapabilitiesByModel"} {
		entries, _ := in.Config[key].(map[string]any)
		normalized := map[string]any{}
		for model, value := range entries {
			model = strings.ToLower(strings.TrimSpace(model))
			if _, exists := normalized[model]; exists {
				return invalid("模型覆盖不能重复")
			}
			if key == "imageMaxReferenceImagesByModel" {
				n, ok := value.(float64)
				if !ok || n < 0 || n > 9007199254740991 || math.Trunc(n) != n {
					return invalid("模型参考图上限无效")
				}
			}
			if key == "videoInputCapabilitiesByModel" {
				if !poolValidVideoInputs(value) {
					return invalid("视频输入能力无效")
				}
			}
			normalized[model] = value
		}
		in.Config[key] = normalized
	}
	if !poolValidVideoInputs(in.Config["videoInputCapabilities"]) {
		return invalid("视频输入能力无效")
	}
	mappings, ok := in.Config["modelMappings"].([]any)
	if !ok || len(mappings) > 1000 {
		return invalid("模型映射无效")
	}
	seen := map[string]bool{}
	for _, raw := range mappings {
		m, ok := raw.(map[string]any)
		if !ok || !settingsObjectHasOnly(m, "modelId", "upstreamModelId") {
			return invalid("模型映射无效")
		}
		source, target := strings.TrimSpace(extractString(m, "modelId")), strings.TrimSpace(extractString(m, "upstreamModelId"))
		key := strings.ToLower(source)
		if source == "" || len(source) > 120 || target == "" || len(target) > 240 || !supported[key] || seen[key] {
			return invalid("模型映射来源无效或重复")
		}
		seen[key] = true
		m["modelId"], m["upstreamModelId"] = source, target
	}
	if value, exists := in.Config["imageSizeConfigId"]; exists && value != nil {
		id, ok := value.(string)
		if !ok || strings.TrimSpace(id) == "" || len(id) > 128 {
			return invalid("尺寸配置 ID 无效")
		}
		in.Config["imageSizeConfigId"] = strings.TrimSpace(id)
	}
	return nil
}
func poolValidVideoInputs(value any) bool {
	m, ok := value.(map[string]any)
	if !ok || !settingsObjectHasOnly(m, "referenceVideos", "referenceAudios") {
		return false
	}
	for _, key := range []string{"referenceVideos", "referenceAudios"} {
		if v, exists := m[key]; exists {
			if _, ok := v.(bool); !ok {
				return false
			}
		} else {
			m[key] = false
		}
	}
	return true
}
