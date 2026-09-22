package main

import (
	"net/http"
)

// registerMarketingSLARoutes exposes the public homepage SLA flag and the
// administrator-only update used by the marketing homepage toggle.
func (b *backend) registerMarketingSLARoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/marketing/sla-visibility", b.endpoint(b.handleMarketingSLAVisibilityGet))
	mux.HandleFunc("GET /api/marketing/sla-stats", b.endpoint(b.handleMarketingSLAStatsGet))
	mux.HandleFunc("PUT /api/marketing/sla-visibility", b.endpoint(b.handleMarketingSLAVisibilityUpdate))
}

func (b *backend) handleMarketingSLAStatsGet(w http.ResponseWriter, r *http.Request) error {
	// The public homepage uses the latest 1000 terminal tasks, including older
	// tasks on quiet installations. Pending work never enters the sample.
	rows, err := b.db.Query(r.Context(), `SELECT status,error FROM generation WHERE status IN ('completed','failed') ORDER BY created_at DESC,id DESC LIMIT 1000`)
	if err != nil {
		return err
	}
	defer rows.Close()
	var sample, completed, failed, platform, moderation, userRequest int
	for rows.Next() {
		var status string
		var message *string
		if err := rows.Scan(&status, &message); err != nil {
			return err
		}
		sample++
		if status == "completed" {
			completed++
			continue
		}
		failed++
		switch classifyGenerationError(message) {
		case "moderation":
			moderation++
		case "user_request":
			userRequest++
		default:
			platform++
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	rate := 1.0
	if denominator := completed + platform; denominator > 0 {
		rate = float64(completed) / float64(denominator)
	}
	noStore(w)
	writeJSON(w, http.StatusOK, map[string]any{"sampleSize": sample, "completed": completed, "failed": failed, "successRate": rate, "platformErrors": platform, "moderationErrors": moderation, "userRequestErrors": userRequest})
	return nil
}

func (b *backend) handleMarketingSLAVisibilityGet(w http.ResponseWriter, r *http.Request) error {
	enabled, err := b.settingBool(r.Context(), "MARKETING_SLA_STATUS_ENABLED", true)
	if err != nil {
		return err
	}
	noStore(w)
	writeJSON(w, http.StatusOK, map[string]bool{"enabled": enabled})
	return nil
}

func (b *backend) handleMarketingSLAVisibilityUpdate(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireAdmin(r, false)
	if err != nil {
		return err
	}
	var in struct {
		Enabled *bool `json:"enabled"`
	}
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	if in.Enabled == nil {
		return invalid("enabled is required")
	}
	raw := []byte("true")
	if !*in.Enabled {
		raw = []byte("false")
	}
	if _, err := b.db.Exec(r.Context(), `INSERT INTO system_setting(key,value,is_secret,updated_by,updated_at) VALUES('MARKETING_SLA_STATUS_ENABLED',$1,false,$2,now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=now()`, raw, s.User.ID); err != nil {
		return err
	}
	noStore(w)
	writeJSON(w, http.StatusOK, map[string]bool{"enabled": *in.Enabled})
	return nil
}
