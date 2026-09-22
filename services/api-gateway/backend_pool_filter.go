package main

import (
	"net/http"
	"strings"
	"time"
)

func filterPoolMembers(r *http.Request, members []any) ([]any, error) {
	q := r.URL.Query()
	name, model, resolution := strings.ToLower(strings.TrimSpace(q.Get("name"))), strings.ToLower(strings.TrimSpace(q.Get("modelId"))), strings.ToLower(strings.TrimSpace(q.Get("resolution")))
	if model == "all" {
		model = ""
	}
	if resolution == "all" {
		resolution = ""
	}
	if status := q.Get("credentialStatus"); status != "" && status != "all" && status != "not_applicable" {
		return nil, invalid("凭据状态筛选无效")
	}
	zone := q.Get("timeZone")
	if zone == "" {
		zone = "UTC"
	}
	loc, err := time.LoadLocation(zone)
	if err != nil {
		return nil, invalid("无效的 IANA 时区")
	}
	from, to := q.Get("createdFrom"), q.Get("createdTo")
	for _, date := range []string{from, to} {
		if date != "" {
			if parsed, err := time.Parse("2006-01-02", date); err != nil || parsed.Format("2006-01-02") != date {
				return nil, invalid("创建日期无效")
			}
		}
	}
	out := []any{}
	if from != "" && to != "" && from > to {
		return out, nil
	}
	for _, raw := range members {
		m := raw.(map[string]any)
		if name != "" && !strings.Contains(strings.ToLower(stringValue(m["name"])), name) {
			continue
		}
		if model != "" {
			found := false
			for _, id := range stringSlice(m["supportedModelIds"]) {
				found = found || strings.EqualFold(id, model)
			}
			if !found {
				continue
			}
		}
		if resolution != "" {
			found := false
			byModel, _ := m["supportedResolutionsByModel"].(map[string]any)
			for id, values := range byModel {
				if model != "" && !strings.EqualFold(id, model) {
					continue
				}
				for _, v := range stringSlice(values) {
					found = found || strings.EqualFold(v, resolution)
				}
			}
			if !found {
				continue
			}
		}
		if from != "" || to != "" {
			created, err := time.Parse(time.RFC3339Nano, stringValue(m["createdAt"]))
			if err != nil {
				continue
			}
			day := created.In(loc).Format("2006-01-02")
			if from != "" && day < from || to != "" && day > to {
				continue
			}
		}
		m["credentialHealthStatus"] = nil
		out = append(out, m)
	}
	return out, nil
}
