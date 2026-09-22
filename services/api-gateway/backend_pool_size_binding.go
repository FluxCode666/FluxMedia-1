package main

import (
	"context"
	"encoding/json"
	"reflect"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Share the existing binding lock with member edits, before taking any row
// locks. Historical task snapshots remain immutable while new calls follow the
// atomically advanced current adapter pointer.
func lockPoolSizeBindings(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(1229801287,1397313351)`)
	return err
}

func canonicalPoolSizeSnapshot(value any) any {
	snapshot, ok := value.(map[string]any)
	if !ok {
		return value
	}
	mappings, ok := snapshot["mappings"].([]any)
	if !ok {
		return value
	}
	key := func(raw any) string {
		m, _ := raw.(map[string]any)
		return strings.ToLower(strings.TrimSpace(stringValue(m["resolution"]))) + "\x00" + strings.ToLower(strings.TrimSpace(stringValue(m["aspectRatio"]))) + "\x00" + stringValue(m["size"])
	}
	sort.SliceStable(mappings, func(i, j int) bool { return key(mappings[i]) < key(mappings[j]) })
	return snapshot
}

func refreshPoolSizeBindings(ctx context.Context, tx pgx.Tx, configID string, snapshot any) error {
	rows, err := tx.Query(ctx, `SELECT c.member_id,c.current_adapter_version_id,v.revision,v.credential_scope,v.configuration FROM image_backend_member_api_config c JOIN image_backend_member_api_adapter_version v ON v.id=c.current_adapter_version_id AND v.member_id_snapshot=c.member_id AND v.credential_scope=c.credential_scope WHERE v.configuration::jsonb#>>'{imageSizeConfig,id}'=$1 OR EXISTS(SELECT 1 FROM jsonb_each(COALESCE(v.configuration::jsonb->'imageSizeConfigsByModel','{}'::jsonb)) p WHERE p.value->>'id'=$1) ORDER BY c.member_id FOR UPDATE OF c`, configID)
	if err != nil {
		return err
	}
	type boundAdapter struct {
		member, version, scope string
		revision               int
		configuration          []byte
	}
	bound := []boundAdapter{}
	for rows.Next() {
		var item boundAdapter
		if err = rows.Scan(&item.member, &item.version, &item.revision, &item.scope, &item.configuration); err != nil {
			rows.Close()
			return err
		}
		bound = append(bound, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	snapshot = canonicalPoolSizeSnapshot(snapshot)
	for _, item := range bound {
		var cfg map[string]any
		if err = json.Unmarshal(item.configuration, &cfg); err != nil {
			return err
		}
		changed := false
		if current := goMapObject(cfg, "imageSizeConfig"); current["id"] == configID && !reflect.DeepEqual(canonicalPoolSizeSnapshot(current), snapshot) {
			cfg["imageSizeConfig"] = snapshot
			changed = true
		}
		byModel := goMapObject(cfg, "imageSizeConfigsByModel")
		for model, value := range byModel {
			current, _ := value.(map[string]any)
			if current["id"] != configID || reflect.DeepEqual(canonicalPoolSizeSnapshot(current), snapshot) {
				continue
			}
			if snapshot == nil {
				delete(byModel, model)
			} else {
				byModel[model] = snapshot
			}
			changed = true
		}
		if !changed {
			continue
		}
		cfg["imageSizeConfigsByModel"] = byModel
		next := newRequestID()
		if _, err = tx.Exec(ctx, `INSERT INTO image_backend_member_api_adapter_version(id,member_id_snapshot,revision,credential_scope,configuration) VALUES($1,$2,$3,$4,$5)`, next, item.member, item.revision+1, item.scope, mustJSON(cfg)); err != nil {
			return err
		}
		result, err := tx.Exec(ctx, `UPDATE image_backend_member_api_config SET current_adapter_version_id=$1,updated_at=now() WHERE member_id=$2 AND current_adapter_version_id=$3`, next, item.member, item.version)
		if err != nil {
			return err
		}
		if result.RowsAffected() != 1 {
			return &apiError{409, "VERSION_CONFLICT", "尺寸配置绑定的供应商版本已更新"}
		}
	}
	return nil
}
