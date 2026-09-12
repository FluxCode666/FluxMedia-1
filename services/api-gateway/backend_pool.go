package main

import (
	"net/http"
	"time"
)

// handleBackendPoolRead exposes the read-only pool resources consumed by the
// web server actions.  Credentials are intentionally never selected here.
func (b *backend) handleBackendPoolRead(w http.ResponseWriter, r *http.Request) error {
	switch r.URL.Path {
	case "/api/image-backend/groups/options":
		if _, err := b.requireSession(r); err != nil {
			return err
		}
		rows, err := b.db.Query(r.Context(), `SELECT id,name FROM image_backend_group WHERE is_enabled AND is_user_selectable ORDER BY priority ASC,id ASC`)
		if err != nil {
			return err
		}
		defer rows.Close()
		options := make([]map[string]string, 0)
		for rows.Next() {
			var id, name string
			if err := rows.Scan(&id, &name); err != nil {
				return err
			}
			options = append(options, map[string]string{"id": id, "name": name})
		}
		writeJSON(w, http.StatusOK, map[string]any{"options": options})
		return nil

	case "/api/admin/image-backend/size-configs":
		if _, err := b.requireAdminViewer(r); err != nil {
			return err
		}
		rows, err := b.db.Query(r.Context(), `SELECT c.id,c.name,c.created_at,c.updated_at,m.resolution,m.aspect_ratio,m.size FROM image_size_config c LEFT JOIN image_size_config_mapping m ON m.config_id=c.id ORDER BY c.name ASC,c.id ASC,m.id ASC`)
		if err != nil {
			return err
		}
		defer rows.Close()
		type config struct {
			ID        string              `json:"id"`
			Name      string              `json:"name"`
			CreatedAt time.Time           `json:"createdAt"`
			UpdatedAt time.Time           `json:"updatedAt"`
			Mappings  []map[string]string `json:"mappings"`
		}
		configs := make([]config, 0)
		for rows.Next() {
			var id, name string
			var created, updated time.Time
			var resolution, aspect, size *string
			if err := rows.Scan(&id, &name, &created, &updated, &resolution, &aspect, &size); err != nil {
				return err
			}
			if len(configs) == 0 || configs[len(configs)-1].ID != id {
				configs = append(configs, config{ID: id, Name: name, CreatedAt: created, UpdatedAt: updated, Mappings: make([]map[string]string, 0)})
			}
			if resolution != nil && aspect != nil && size != nil {
				last := &configs[len(configs)-1]
				last.Mappings = append(last.Mappings, map[string]string{"resolution": *resolution, "aspectRatio": *aspect, "size": *size})
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"configs": configs})
		return nil
	}
	return invalid("unknown backend pool resource")
}
