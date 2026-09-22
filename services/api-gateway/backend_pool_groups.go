package main

import (
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"net/http"
	"strings"
)

type poolGroupWrite struct {
	ID              string             `json:"id"`
	Name            string             `json:"name"`
	Description     *string            `json:"description"`
	Enabled         bool               `json:"isEnabled"`
	Default         bool               `json:"isDefault"`
	Selectable      bool               `json:"isUserSelectable"`
	Safety          string             `json:"contentSafety"`
	ImagePrices     map[string]any     `json:"imageCreditOverrides"`
	VideoPrices     map[string]float64 `json:"videoCreditOverrides"`
	VideoItemPrices map[string]float64 `json:"videoCreditsPerItemOverrides"`
	Children        []string           `json:"childGroupIds"`
	Priority        int                `json:"priority"`
}

func validatePoolGroup(in *poolGroupWrite) error {
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" || len([]rune(in.Name)) > 120 || len(in.ID) > 128 || in.Priority < 0 || in.Priority > 10000 || len(in.Children) > 100 || !containsString([]string{"inherit", "enabled", "disabled"}, in.Safety) {
		return invalid("分组字段无效")
	}
	if in.Description != nil && len([]rune(*in.Description)) > 500 {
		return invalid("分组描述过长")
	}
	seen := map[string]bool{}
	for _, child := range in.Children {
		if child == "" || len(child) > 128 || child == in.ID || seen[child] {
			return invalid("子分组不能重复或包含自身")
		}
		seen[child] = true
	}
	if in.Children == nil {
		in.Children = []string{}
	}
	if in.ImagePrices == nil {
		in.ImagePrices = map[string]any{"version": float64(1), "byModel": map[string]any{}}
	}
	if !settingsObjectHasOnly(in.ImagePrices, "version", "byModel") || in.ImagePrices["version"] != float64(1) {
		return invalid("分组图片价格格式无效")
	}
	byModel, ok := in.ImagePrices["byModel"].(map[string]any)
	if !ok || len(byModel) > 200 {
		return invalid("分组图片价格格式无效")
	}
	for model, raw := range byModel {
		price, ok := raw.(map[string]any)
		if !ok || model == "" || len(model) > 120 || !settingsObjectHasOnly(price, "base1024Credits", "base1kCredits", "base2kCredits", "base4kCredits", "base8kCredits") {
			return invalid("分组图片价格无效")
		}
		primary := false
		for key, v := range price {
			n, ok := v.(float64)
			if !ok || n <= 0 || n > 100000 {
				return invalid("分组图片价格无效")
			}
			if key != "base8kCredits" {
				primary = true
			}
		}
		if !primary {
			return invalid("至少配置一个图片价格")
		}
	}
	if in.VideoPrices == nil {
		in.VideoPrices = map[string]float64{}
	}
	if in.VideoItemPrices == nil {
		in.VideoItemPrices = map[string]float64{}
	}
	for _, prices := range []map[string]float64{in.VideoPrices, in.VideoItemPrices} {
		for key, value := range prices {
			if strings.TrimSpace(key) == "" || len(key) > 280 || value <= 0 || value > 100000 {
				return invalid("分组视频价格无效")
			}
		}
	}
	return nil
}

func (b *backend) backendPoolSaveGroup(w http.ResponseWriter, r *http.Request) error {
	var in poolGroupWrite
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	if err := validatePoolGroup(&in); err != nil {
		return err
	}
	creating := in.ID == ""
	if creating {
		in.ID = newRequestID()
	}
	tx, err := b.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer rollback(tx)
	if _, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended('pool-groups',0))`); err != nil {
		return err
	}
	rows, err := tx.Query(r.Context(), `SELECT id,metadata FROM image_backend_group ORDER BY id FOR UPDATE`)
	if err != nil {
		return err
	}
	graph := map[string][]string{}
	for rows.Next() {
		var id string
		var raw []byte
		if err = rows.Scan(&id, &raw); err != nil {
			rows.Close()
			return err
		}
		var meta struct {
			Children []string `json:"childGroupIds"`
		}
		_ = json.Unmarshal(raw, &meta)
		graph[id] = meta.Children
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if _, ok := graph[in.ID]; !creating && !ok {
		return &apiError{404, "NOT_FOUND", "媒体后端分组不存在"}
	}
	for _, child := range in.Children {
		if _, ok := graph[child]; !ok {
			return invalid("子分组不存在")
		}
	}
	graph[in.ID] = in.Children
	state := map[string]int{}
	var cycle func(string) bool
	cycle = func(id string) bool {
		if state[id] == 1 {
			return true
		}
		if state[id] == 2 {
			return false
		}
		state[id] = 1
		for _, child := range graph[id] {
			if cycle(child) {
				return true
			}
		}
		state[id] = 2
		return false
	}
	for id := range graph {
		if cycle(id) {
			return invalid("分组不能形成循环引用")
		}
	}
	if in.Default {
		if _, err = tx.Exec(r.Context(), `UPDATE image_backend_group SET is_default=false,updated_at=now() WHERE is_default`); err != nil {
			return err
		}
	}
	var safety *bool
	if in.Safety != "inherit" {
		v := in.Safety == "enabled"
		safety = &v
	}
	meta := map[string]any{"imageCreditOverrides": in.ImagePrices, "videoCreditOverrides": in.VideoPrices, "videoCreditsPerItemOverrides": in.VideoItemPrices, "childGroupIds": in.Children}
	_, err = tx.Exec(r.Context(), `INSERT INTO image_backend_group(id,name,description,is_enabled,is_default,is_user_selectable,content_safety_enabled,priority,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,is_enabled=excluded.is_enabled,is_default=excluded.is_default,is_user_selectable=excluded.is_user_selectable,content_safety_enabled=excluded.content_safety_enabled,priority=excluded.priority,metadata=excluded.metadata,updated_at=now()`, in.ID, in.Name, in.Description, in.Enabled, in.Default, in.Selectable, safety, in.Priority, mustJSON(meta))
	if err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"id": in.ID})
	return nil
}
func (b *backend) backendPoolDeleteGroup(w http.ResponseWriter, r *http.Request) error {
	id := strings.TrimPrefix(r.URL.Path, "/api/admin/image-backend/groups/")
	if id == "" {
		return invalid("分组 ID 无效")
	}
	tx, err := b.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer rollback(tx)
	if _, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended('pool-groups',0))`); err != nil {
		return err
	}
	var def bool
	if err = tx.QueryRow(r.Context(), `SELECT is_default FROM image_backend_group WHERE id=$1 FOR UPDATE`, id).Scan(&def); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return &apiError{404, "NOT_FOUND", "媒体后端分组不存在"}
		}
		return err
	}
	if def {
		return &apiError{409, "CONFLICT", "默认分组不能删除"}
	}
	var used bool
	err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM image_backend_member_group WHERE group_id=$1 UNION ALL SELECT 1 FROM external_api_key WHERE generation_group_id=$1 UNION ALL SELECT 1 FROM image_backend_group WHERE (id=$1 AND jsonb_array_length(COALESCE(metadata::jsonb->'childGroupIds','[]'::jsonb))>0) OR metadata::jsonb->'childGroupIds' @> jsonb_build_array($1::text))`, id).Scan(&used)
	if err != nil {
		return err
	}
	if used {
		return &apiError{409, "CONFLICT", "分组仍被成员、密钥或分组层级使用"}
	}
	if _, err = tx.Exec(r.Context(), `DELETE FROM image_backend_group WHERE id=$1`, id); err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"success": true})
	return nil
}
