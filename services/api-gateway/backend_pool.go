package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// handleBackendPoolAdmin owns the persistence used by the supplier/group admin
// pages. Secrets are accepted only on writes and are never returned by reads.
func (b *backend) handleBackendPoolAdmin(w http.ResponseWriter, r *http.Request) error {
	if r.Method == http.MethodGet {
		if _, err := b.requireAdminViewer(r); err != nil {
			return err
		}
	} else if _, err := b.requireAdmin(r, false); err != nil {
		return err
	}
	path := r.URL.Path
	switch {
	case path == "/api/admin/image-backend/pool" && r.Method == http.MethodGet:
		groups, err := b.backendPoolGroups(r)
		if err != nil {
			return err
		}
		ms, err := b.backendPoolMembers(r)
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, map[string]any{"groups": groups, "members": ms})
		return nil
	case path == "/api/admin/image-backend/groups" && r.Method == http.MethodGet:
		groups, err := b.backendPoolGroups(r)
		if err != nil {
			return err
		}
		name := strings.TrimSpace(r.URL.Query().Get("name"))
		page, size := poolPage(r)
		filtered := make([]any, 0)
		for _, g := range groups {
			if name == "" || strings.Contains(strings.ToLower(g["name"].(string)), strings.ToLower(name)) {
				filtered = append(filtered, g)
			}
		}
		writeJSON(w, http.StatusOK, poolPageResult(filtered, page, size))
		return nil
	case path == "/api/admin/image-backend/members" && r.Method == http.MethodGet:
		members, err := b.backendPoolMembers(r)
		if err != nil {
			return err
		}
		members, err = filterPoolMembers(r, members)
		if err != nil {
			return err
		}
		page, size := poolPage(r)
		writeJSON(w, http.StatusOK, poolPageResult(members, page, size))
		return nil
	case path == "/api/admin/image-backend/groups" && r.Method == http.MethodPost:
		return b.backendPoolSaveGroup(w, r)
	case strings.HasPrefix(path, "/api/admin/image-backend/groups/") && r.Method == http.MethodDelete:
		return b.backendPoolDeleteGroup(w, r)
	case path == "/api/admin/image-backend/members" && r.Method == http.MethodPost:
		return b.backendPoolSaveMember(w, r)
	case strings.HasPrefix(path, "/api/admin/image-backend/members/") && strings.HasSuffix(path, "/enabled") && r.Method == http.MethodPost:
		return b.backendPoolSetEnabled(w, r)
	case strings.HasPrefix(path, "/api/admin/image-backend/members/") && strings.HasSuffix(path, "/reset-status") && r.Method == http.MethodPost:
		return b.backendPoolResetStatus(w, r)
	case strings.HasPrefix(path, "/api/admin/image-backend/members/") && r.Method == http.MethodDelete:
		return b.backendPoolDeleteMember(w, r)
	}
	return invalid("unknown backend pool resource")
}

func poolPage(r *http.Request) (int, int) {
	page, size := 1, 20
	fmt.Sscanf(r.URL.Query().Get("page"), "%d", &page)
	fmt.Sscanf(r.URL.Query().Get("pageSize"), "%d", &size)
	if page < 1 {
		page = 1
	}
	if size != 10 && size != 20 && size != 50 {
		size = 20
	}
	return page, size
}
func poolPageResult(records []any, page, size int) map[string]any {
	total := len(records)
	pages := (total + size - 1) / size
	if pages < 1 {
		pages = 1
	}
	if page > pages {
		page = pages
	}
	start := (page - 1) * size
	if start > total {
		start = total
	}
	end := start + size
	if end > total {
		end = total
	}
	return map[string]any{"records": records[start:end], "page": page, "pageSize": size, "totalCount": total, "totalPages": pages}
}

func (b *backend) backendPoolGroups(r *http.Request) ([]map[string]any, error) {
	rows, err := b.db.Query(r.Context(), `SELECT id,name,description,is_enabled,is_default,is_user_selectable,content_safety_enabled,priority,metadata FROM image_backend_group ORDER BY priority ASC,id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]map[string]any, 0)
	for rows.Next() {
		var id, name string
		var desc *string
		var enabled, def, selectable bool
		var safety *bool
		var priority int
		var raw []byte
		if err := rows.Scan(&id, &name, &desc, &enabled, &def, &selectable, &safety, &priority, &raw); err != nil {
			return nil, err
		}
		meta := map[string]any{}
		_ = json.Unmarshal(raw, &meta)
		if meta == nil {
			meta = map[string]any{}
		}
		cs := "inherit"
		if safety != nil {
			if *safety {
				cs = "enabled"
			} else {
				cs = "disabled"
			}
		}
		out = append(out, map[string]any{"id": id, "name": name, "description": desc, "isEnabled": enabled, "isDefault": def, "isUserSelectable": selectable, "contentSafety": cs, "imageCreditOverrides": metaOr(meta, "imageCreditOverrides", map[string]any{"version": 1, "byModel": map[string]any{}}), "videoCreditOverrides": metaOr(meta, "videoCreditOverrides", map[string]any{}), "videoCreditsPerItemOverrides": metaOr(meta, "videoCreditsPerItemOverrides", map[string]any{}), "childGroupIds": metaOr(meta, "childGroupIds", []any{}), "priority": priority})
	}
	return out, rows.Err()
}
func metaOr(m map[string]any, key string, fallback any) any {
	if v, ok := m[key]; ok && v != nil {
		return v
	}
	return fallback
}

func (b *backend) backendPoolMembers(r *http.Request) ([]any, error) {
	rows, err := b.db.Query(r.Context(), `SELECT m.id,m.name,m.supported_model_ids,m.supported_resolutions_by_model,m.content_safety_enabled,m.is_enabled,m.always_active,m.failure_cooldown_enabled,m.priority,m.concurrency,m.status,m.health_status,m.lease_acquired_count,m.created_at,m.last_acquired_at,m.last_used_at,m.last_error,m.last_error_at,(a.api_key IS NOT NULL),v.id,COALESCE(v.revision,0),v.created_at,v.configuration,(SELECT count(*) FROM image_backend_member_lease l WHERE l.member_id=m.id AND l.expires_at>now()),COALESCE((SELECT json_agg(mg.group_id ORDER BY mg.group_id) FROM image_backend_member_group mg WHERE mg.member_id=m.id),'[]'::json) FROM image_backend_member m LEFT JOIN image_backend_member_api_config a ON a.member_id=m.id LEFT JOIN image_backend_member_api_adapter_version v ON v.id=a.current_adapter_version_id ORDER BY m.priority ASC,m.id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]any, 0)
	for rows.Next() {
		var id, name, status, health string
		var models, resolutions, config, groups []byte
		var safety, enabled, always, cooldown, hasKey bool
		var priority, concurrency, leaseCount, revision, inflight int
		var created time.Time
		var acquired, used, errorAt *time.Time
		var lastError *string
		var versionID *string
		var versionCreated *time.Time
		if err := rows.Scan(&id, &name, &models, &resolutions, &safety, &enabled, &always, &cooldown, &priority, &concurrency, &status, &health, &leaseCount, &created, &acquired, &used, &lastError, &errorAt, &hasKey, &versionID, &revision, &versionCreated, &config, &inflight, &groups); err != nil {
			return nil, err
		}
		var mids, gids []any
		_ = json.Unmarshal(models, &mids)
		_ = json.Unmarshal(groups, &gids)
		if mids == nil {
			mids = []any{}
		}
		if gids == nil {
			gids = []any{}
		}
		var cfg map[string]any
		_ = json.Unmarshal(config, &cfg)
		if cfg == nil {
			cfg = map[string]any{}
		}
		// Adapter versions are deliberately secret-free. Older rows may have
		// been written before the Go boundary existed, so sanitize defensively.
		delete(cfg, "apiKey")
		delete(cfg, "expectedCurrentVersionId")
		poolAdapterDefaults(cfg)
		delete(cfg, "imageSizeConfigId")
		delete(cfg, "imageSizeConfigIdsByModel")
		cfg["hasApiKey"] = hasKey
		cfg["currentAdapterVersion"] = nil
		if versionID != nil && versionCreated != nil {
			cfg["currentAdapterVersion"] = map[string]any{"id": *versionID, "revision": revision, "createdAt": versionCreated.UTC().Format(time.RFC3339Nano)}
		}
		out = append(out, map[string]any{"id": id, "name": name, "type": "api", "groupIds": gids, "supportedModelIds": mids, "supportedResolutionsByModel": jsonValue(resolutions, map[string]any{}), "contentSafetyEnabled": safety, "isEnabled": enabled, "alwaysActive": always, "failureCooldownEnabled": cooldown, "priority": priority, "concurrency": concurrency, "status": status, "healthStatus": health, "inflightCount": inflight, "leaseAcquiredCount": leaseCount, "createdAt": created.UTC().Format(time.RFC3339Nano), "lastAcquiredAt": timeValue(acquired), "lastUsedAt": timeValue(used), "lastError": lastError, "lastErrorAt": timeValue(errorAt), "config": cfg})
	}
	return out, rows.Err()
}
func jsonValue(raw []byte, fallback any) any {
	var v any
	if json.Unmarshal(raw, &v) == nil && v != nil {
		return v
	}
	return fallback
}
func timeValue(v *time.Time) any {
	if v == nil {
		return nil
	}
	return v.UTC().Format(time.RFC3339Nano)
}

func (b *backend) backendPoolSetEnabled(w http.ResponseWriter, r *http.Request) error {
	id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/admin/image-backend/members/"), "/enabled")
	var in struct {
		IsEnabled bool `json:"isEnabled"`
	}
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	tag, err := b.db.Exec(r.Context(), `UPDATE image_backend_member SET is_enabled=$2,updated_at=now() WHERE id=$1`, id, in.IsEnabled)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return &apiError{404, "NOT_FOUND", "媒体后端成员不存在"}
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "isEnabled": in.IsEnabled})
	return nil
}
func (b *backend) backendPoolResetStatus(w http.ResponseWriter, r *http.Request) error {
	id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/admin/image-backend/members/"), "/reset-status")
	tag, err := b.db.Exec(r.Context(), `UPDATE image_backend_member SET status='active',health_status='healthy',error_ewma=0,success_streak=0,fail_streak=0,cooldown_until=NULL,last_observed_at=now(),last_error=NULL,last_error_at=NULL,updated_at=now() WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return &apiError{404, "NOT_FOUND", "媒体后端成员不存在"}
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
	return nil
}
func (b *backend) backendPoolDeleteMember(w http.ResponseWriter, r *http.Request) error {
	id := strings.TrimPrefix(r.URL.Path, "/api/admin/image-backend/members/")
	if id == "" {
		return invalid("成员 ID 无效")
	}
	tx, err := b.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer rollback(tx)
	if _, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock_shared(hashtextextended('pool-groups',0)),pg_advisory_xact_lock(hashtextextended($1,0))`, "pool-member:"+id); err != nil {
		return err
	}
	var locked string
	if err = tx.QueryRow(r.Context(), `SELECT id FROM image_backend_member WHERE id=$1 FOR UPDATE`, id).Scan(&locked); err != nil {
		if err == pgx.ErrNoRows {
			return &apiError{404, "NOT_FOUND", "媒体后端成员不存在"}
		}
		return err
	}
	var used bool
	if err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM image_backend_member_lease WHERE member_id=$1 AND expires_at>now() UNION ALL SELECT 1 FROM generation WHERE status='pending' AND (api_adapter_member_id=$1 OR metadata->'billingSnapshot'->>'providerMemberId'=$1) UNION ALL SELECT 1 FROM video_generation WHERE api_adapter_member_id=$1 AND status NOT IN ('completed','failed'))`, id).Scan(&used); err != nil {
		return err
	}
	if used {
		return &apiError{409, "CONFLICT", "成员仍有未完成任务或运行租约"}
	}
	if _, err = tx.Exec(r.Context(), `DELETE FROM image_backend_member WHERE id=$1`, id); err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"success": true})
	return nil
}

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

func (b *backend) handleBackendPoolSizeConfigWrite(w http.ResponseWriter, r *http.Request) error {
	if _, err := b.requireAdmin(r, false); err != nil {
		return err
	}
	var in struct {
		ID       string `json:"id"`
		Name     string `json:"name"`
		Mappings []struct {
			Resolution  string `json:"resolution"`
			AspectRatio string `json:"aspectRatio"`
			Size        string `json:"size"`
		} `json:"mappings"`
	}
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	if strings.TrimSpace(in.Name) == "" || len([]rune(in.Name)) > 120 || len(in.ID) > 128 || len(in.Mappings) == 0 || len(in.Mappings) > 500 {
		return invalid("name and mappings are required")
	}
	id := strings.TrimSpace(in.ID)
	if id == "" {
		id = "size_" + newRequestID()
	}
	tx, err := b.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer rollback(tx)
	if err = lockPoolSizeBindings(r.Context(), tx); err != nil {
		return err
	}
	_, err = tx.Exec(r.Context(), `INSERT INTO image_size_config(id,name,created_at,updated_at) VALUES($1,$2,now(),now()) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,updated_at=now()`, id, strings.TrimSpace(in.Name))
	if err != nil {
		return err
	}
	if _, err = tx.Exec(r.Context(), `DELETE FROM image_size_config_mapping WHERE config_id=$1`, id); err != nil {
		return err
	}
	seen := map[string]bool{}
	for _, m := range in.Mappings {
		key := strings.ToLower(strings.TrimSpace(m.Resolution) + "|" + strings.TrimSpace(m.AspectRatio))
		if seen[key] || len([]rune(m.Resolution)) > 64 || len([]rune(m.AspectRatio)) > 64 || len([]rune(m.Size)) > 64 {
			return invalid("尺寸映射重复或超长")
		}
		seen[key] = true
		if strings.TrimSpace(m.Resolution) == "" || strings.TrimSpace(m.AspectRatio) == "" || strings.TrimSpace(m.Size) == "" {
			return invalid("mapping values are required")
		}
		if _, err = tx.Exec(r.Context(), `INSERT INTO image_size_config_mapping(id,config_id,resolution,aspect_ratio,size) VALUES($1,$2,$3,$4,$5)`, newRequestID(), id, strings.TrimSpace(m.Resolution), strings.TrimSpace(m.AspectRatio), strings.TrimSpace(m.Size)); err != nil {
			return err
		}
	}
	snapshot, err := readPoolSizeSnapshot(r.Context(), tx, id)
	if err != nil {
		return err
	}
	if err = refreshPoolSizeBindings(r.Context(), tx, id, snapshot); err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id})
	return nil
}

func (b *backend) handleBackendPoolSizeConfigDelete(w http.ResponseWriter, r *http.Request) error {
	if _, err := b.requireAdmin(r, false); err != nil {
		return err
	}
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		return invalid("id is required")
	}
	tx, err := b.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer rollback(tx)
	if err = lockPoolSizeBindings(r.Context(), tx); err != nil {
		return err
	}
	if err = refreshPoolSizeBindings(r.Context(), tx, id, nil); err != nil {
		return err
	}
	result, err := tx.Exec(r.Context(), `DELETE FROM image_size_config WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return &apiError{404, "NOT_FOUND", "尺寸配置不存在"}
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
	return nil
}
