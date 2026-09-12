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
	rows, err := b.db.Query(r.Context(), `SELECT m.id,m.name,m.supported_model_ids,m.supported_resolutions_by_model,m.content_safety_enabled,m.is_enabled,m.always_active,m.failure_cooldown_enabled,m.priority,m.concurrency,m.status,m.health_status,m.lease_acquired_count,m.created_at,m.last_acquired_at,m.last_used_at,m.last_error,m.last_error_at,(a.api_key IS NOT NULL),v.id,v.revision,v.created_at,v.configuration,COALESCE((SELECT json_agg(mg.group_id ORDER BY mg.group_id) FROM image_backend_member_group mg WHERE mg.member_id=m.id),'[]'::json) FROM image_backend_member m LEFT JOIN image_backend_member_api_config a ON a.member_id=m.id LEFT JOIN image_backend_member_api_adapter_version v ON v.id=a.current_adapter_version_id ORDER BY m.priority ASC,m.id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]any, 0)
	for rows.Next() {
		var id, name, status, health string
		var models, resolutions, config, groups []byte
		var safety, enabled, always, cooldown, hasKey bool
		var priority, concurrency, leaseCount, revision int
		var created time.Time
		var acquired, used, errorAt *time.Time
		var lastError *string
		var versionID *string
		var versionCreated *time.Time
		if err := rows.Scan(&id, &name, &models, &resolutions, &safety, &enabled, &always, &cooldown, &priority, &concurrency, &status, &health, &leaseCount, &created, &acquired, &used, &lastError, &errorAt, &hasKey, &versionID, &revision, &versionCreated, &config, &groups); err != nil {
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
		cfg["hasApiKey"] = hasKey
		out = append(out, map[string]any{"id": id, "name": name, "type": "api", "groupIds": gids, "supportedModelIds": mids, "supportedResolutionsByModel": jsonValue(resolutions, map[string]any{}), "contentSafetyEnabled": safety, "isEnabled": enabled, "alwaysActive": always, "failureCooldownEnabled": cooldown, "priority": priority, "concurrency": concurrency, "status": status, "healthStatus": health, "inflightCount": 0, "leaseAcquiredCount": leaseCount, "createdAt": created.UTC().Format(time.RFC3339Nano), "lastAcquiredAt": timeValue(acquired), "lastUsedAt": timeValue(used), "lastError": lastError, "lastErrorAt": timeValue(errorAt), "credentialHealthStatus": nil, "config": cfg})
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

func (b *backend) backendPoolSaveGroup(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		ID                           *string  `json:"id"`
		Name                         string   `json:"name"`
		Description                  *string  `json:"description"`
		IsEnabled                    bool     `json:"isEnabled"`
		IsDefault                    bool     `json:"isDefault"`
		IsUserSelectable             bool     `json:"isUserSelectable"`
		ContentSafety                string   `json:"contentSafety"`
		ImageCreditOverrides         any      `json:"imageCreditOverrides"`
		VideoCreditOverrides         any      `json:"videoCreditOverrides"`
		VideoCreditsPerItemOverrides any      `json:"videoCreditsPerItemOverrides"`
		ChildGroupIDs                []string `json:"childGroupIds"`
		Priority                     int      `json:"priority"`
	}
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	if strings.TrimSpace(in.Name) == "" {
		return invalid("分组名称不能为空")
	}
	id := newRequestID()
	if in.ID != nil && strings.TrimSpace(*in.ID) != "" {
		id = strings.TrimSpace(*in.ID)
	}
	meta, _ := json.Marshal(map[string]any{"imageCreditOverrides": in.ImageCreditOverrides, "videoCreditOverrides": in.VideoCreditOverrides, "videoCreditsPerItemOverrides": in.VideoCreditsPerItemOverrides, "childGroupIds": in.ChildGroupIDs})
	var safety *bool
	if in.ContentSafety == "enabled" {
		v := true
		safety = &v
	} else if in.ContentSafety == "disabled" {
		v := false
		safety = &v
	}
	_, err := b.db.Exec(r.Context(), `INSERT INTO image_backend_group(id,name,description,is_enabled,is_default,is_user_selectable,content_safety_enabled,priority,metadata,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),now()) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,is_enabled=EXCLUDED.is_enabled,is_default=EXCLUDED.is_default,is_user_selectable=EXCLUDED.is_user_selectable,content_safety_enabled=EXCLUDED.content_safety_enabled,priority=EXCLUDED.priority,metadata=EXCLUDED.metadata,updated_at=now()`, id, in.Name, in.Description, in.IsEnabled, in.IsDefault, in.IsUserSelectable, safety, in.Priority, meta)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id})
	return nil
}
func (b *backend) backendPoolDeleteGroup(w http.ResponseWriter, r *http.Request) error {
	id := strings.TrimPrefix(r.URL.Path, "/api/admin/image-backend/groups/")
	if id == "" {
		return invalid("分组 ID 无效")
	}
	var def bool
	err := b.db.QueryRow(r.Context(), `SELECT is_default FROM image_backend_group WHERE id=$1`, id).Scan(&def)
	if err == pgx.ErrNoRows {
		return &apiError{404, "NOT_FOUND", "媒体后端分组不存在"}
	}
	if err != nil {
		return err
	}
	if def {
		return &apiError{409, "CONFLICT", "默认分组不能删除"}
	}
	var count int
	if err := b.db.QueryRow(r.Context(), `SELECT count(*) FROM image_backend_member_group WHERE group_id=$1`, id).Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return &apiError{409, "CONFLICT", "分组仍被成员使用"}
	}
	tag, err := b.db.Exec(r.Context(), `DELETE FROM image_backend_group WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return &apiError{404, "NOT_FOUND", "媒体后端分组不存在"}
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
	return nil
}
func (b *backend) backendPoolSaveMember(w http.ResponseWriter, r *http.Request) error {
	var raw map[string]json.RawMessage
	if err := decodeBody(r, &raw); err != nil {
		return err
	}
	getS := func(k string) string { var v string; _ = json.Unmarshal(raw[k], &v); return strings.TrimSpace(v) }
	getB := func(k string, d bool) bool {
		var v bool
		if json.Unmarshal(raw[k], &v) != nil {
			return d
		}
		return v
	}
	getI := func(k string, d int) int {
		var v int
		if json.Unmarshal(raw[k], &v) != nil {
			return d
		}
		return v
	}
	id := getS("id")
	if id == "" {
		id = newRequestID()
	}
	name := getS("name")
	if name == "" {
		return invalid("成员名称不能为空")
	}
	var models, resolutions []byte
	models = raw["supportedModelIds"]
	resolutions = raw["supportedResolutionsByModel"]
	if len(models) == 0 {
		models = []byte(`[]`)
	}
	if len(resolutions) == 0 {
		resolutions = []byte(`{}`)
	}
	groups := raw["groupIds"]
	if len(groups) == 0 {
		groups = []byte(`[]`)
	}
	cfg := raw["config"]
	var config map[string]any
	_ = json.Unmarshal(cfg, &config)
	if config == nil {
		config = map[string]any{}
	}
	apiKey, _ := config["apiKey"].(string)
	baseURL, _ := config["baseUrl"].(string)
	credentialScope, _ := config["credentialScope"].(string)
	if credentialScope == "" {
		credentialScope = baseURL
	}
	if credentialScope == "" {
		return invalid("API 成员缺少上游地址")
	}
	delete(config, "apiKey")
	configuration, err := json.Marshal(config)
	if err != nil {
		return invalid("API 成员配置无效")
	}
	tx, err := b.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	_, err = tx.Exec(r.Context(), `INSERT INTO image_backend_member(id,type,name,supported_model_ids,supported_resolutions_by_model,content_safety_enabled,is_enabled,always_active,failure_cooldown_enabled,priority,concurrency,updated_at,created_at) VALUES($1,'api',$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),now()) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,supported_model_ids=EXCLUDED.supported_model_ids,supported_resolutions_by_model=EXCLUDED.supported_resolutions_by_model,content_safety_enabled=EXCLUDED.content_safety_enabled,is_enabled=EXCLUDED.is_enabled,always_active=EXCLUDED.always_active,failure_cooldown_enabled=EXCLUDED.failure_cooldown_enabled,priority=EXCLUDED.priority,concurrency=EXCLUDED.concurrency,updated_at=now()`, id, name, models, resolutions, getB("contentSafetyEnabled", true), getB("isEnabled", true), getB("alwaysActive", false), getB("failureCooldownEnabled", false), getI("priority", 50), getI("concurrency", 10))
	if err != nil {
		return err
	}
	var previousRevision int
	_ = tx.QueryRow(r.Context(), `SELECT COALESCE(v.revision,0) FROM image_backend_member_api_config a LEFT JOIN image_backend_member_api_adapter_version v ON v.id=a.current_adapter_version_id WHERE a.member_id=$1`, id).Scan(&previousRevision)
	versionID := newRequestID()
	_, err = tx.Exec(r.Context(), `INSERT INTO image_backend_member_api_adapter_version(id,member_id_snapshot,revision,credential_scope,configuration,created_at) VALUES($1,$2,$3,$4,$5,now())`, versionID, id, previousRevision+1, credentialScope, configuration)
	if err != nil {
		return err
	}
	_, err = tx.Exec(r.Context(), `INSERT INTO image_backend_member_api_config(member_id,api_key,current_adapter_version_id,credential_scope,created_at,updated_at) VALUES($1,$2,$3,$4,now(),now()) ON CONFLICT(member_id) DO UPDATE SET api_key=COALESCE(NULLIF(EXCLUDED.api_key,''),image_backend_member_api_config.api_key),current_adapter_version_id=EXCLUDED.current_adapter_version_id,credential_scope=EXCLUDED.credential_scope,updated_at=now()`, id, apiKey, versionID, credentialScope)
	if err != nil {
		return err
	}
	if _, err = tx.Exec(r.Context(), `DELETE FROM image_backend_member_group WHERE member_id=$1`, id); err != nil {
		return err
	}
	var gids []string
	_ = json.Unmarshal(groups, &gids)
	for _, gid := range gids {
		if _, err = tx.Exec(r.Context(), `INSERT INTO image_backend_member_group(id,member_id,group_id,created_at) VALUES($1,$2,$3,now()) ON CONFLICT DO NOTHING`, newRequestID(), id, gid); err != nil {
			return err
		}
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id})
	return nil
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
	var n int
	if err := b.db.QueryRow(r.Context(), `SELECT count(*) FROM image_backend_member_lease WHERE member_id=$1 AND expires_at>now()`, id).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return &apiError{409, "CONFLICT", "成员仍有运行中的租约"}
	}
	tag, err := b.db.Exec(r.Context(), `DELETE FROM image_backend_member WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return &apiError{404, "NOT_FOUND", "媒体后端成员不存在"}
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
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
