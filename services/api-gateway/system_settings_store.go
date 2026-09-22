package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/jackc/pgx/v5"
)

type systemSettingUpdate struct {
	Key   string          `json:"key"`
	Value json.RawMessage `json:"value"`
	Clear bool            `json:"clear"`
}
type plannedSetting struct {
	Definition settingDefinition
	Value      any
	Clear      bool
}

func planSettingsUpdate(input []systemSettingUpdate) ([]plannedSetting, error) {
	if len(input) == 0 {
		return nil, invalid("settings is required")
	}
	if len(input) > len(systemSettingDefinitions) {
		return nil, invalid("设置项过多")
	}
	result := make([]plannedSetting, 0, len(input))
	seen := map[string]bool{}
	for _, in := range input {
		d, ok := systemSettingDefinitionByKey[in.Key]
		if !ok {
			return nil, invalid("系统设置包含未知或已下线的字段")
		}
		if seen[in.Key] {
			return nil, invalid("设置项重复")
		}
		seen[in.Key] = true
		if d.ManagedByDedicatedOperation {
			return nil, invalid(d.Label + "只能通过专用配置入口修改")
		}
		if in.Clear {
			if len(in.Value) > 0 {
				return nil, invalid("清空设置时不能同时提交 value")
			}
			result = append(result, plannedSetting{Definition: d, Clear: true})
			continue
		}
		if len(in.Value) == 0 {
			return nil, invalid("设置更新必须提供 value 或 clear=true")
		}
		var value any
		if err := json.Unmarshal(in.Value, &value); err != nil {
			return nil, invalid("设置 value 无效")
		}
		if d.Secret {
			if text, ok := value.(string); ok && strings.TrimSpace(text) == "" {
				continue
			}
		}
		value, err := coerceSystemSetting(d, value)
		if err != nil {
			return nil, err
		}
		text, isText := value.(string)
		result = append(result, plannedSetting{Definition: d, Value: value, Clear: isText && text == ""})
	}
	return result, nil
}
func nullableSettingActor(actor string) any {
	if actor == "" {
		return nil
	}
	return actor
}
func writeSystemSetting(ctx context.Context, tx pgx.Tx, d settingDefinition, value any, actor string, overwrite bool) (bool, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return false, fmt.Errorf("encode setting: %w", err)
	}
	query := `INSERT INTO system_setting(key,value,is_secret,updated_by,updated_at) VALUES($1,$2,$3,$4,now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,is_secret=EXCLUDED.is_secret,updated_by=EXCLUDED.updated_by,updated_at=now()`
	if !overwrite {
		query += ` WHERE system_setting.value IS NULL OR system_setting.value::jsonb='null'::jsonb OR system_setting.value::jsonb='""'::jsonb`
	}
	tag, err := tx.Exec(ctx, query, d.Key, raw, d.Secret, nullableSettingActor(actor))
	if err != nil {
		return false, fmt.Errorf("write system setting: %w", err)
	}
	return tag.RowsAffected() > 0, nil
}
func (b *backend) updateSystemSettings(ctx context.Context, input []systemSettingUpdate, actor string) ([]string, error) {
	plan, err := planSettingsUpdate(input)
	if err != nil {
		return nil, err
	}
	tx, err := b.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('system-settings:bootstrap'))`); err != nil {
		return nil, err
	}
	storageKeys := map[string]bool{"STORAGE_ACCESS_KEY_ID": true, "STORAGE_SECRET_ACCESS_KEY": true, "STORAGE_ENDPOINT": true, "STORAGE_REGION": true, "STORAGE_BUCKET_NAME": true, "LOCAL_STORAGE_PATH": true}
	for _, change := range plan {
		if !storageKeys[change.Definition.Key] {
			continue
		}
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('operations-export:storage-config'))`); err != nil {
			return nil, err
		}
		var busy bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM operations_export_task WHERE status IN ('queued','running','completed') OR (status='expired' AND object_deleted_at IS NULL)) OR EXISTS(SELECT 1 FROM admin_audit_log orphan WHERE orphan.action='operations.exportOrphan' AND NOT EXISTS(SELECT 1 FROM admin_audit_log cleaned WHERE cleaned.action='operations.exportOrphanDeleted' AND cleaned.metadata->>'orphanAuditId'=orphan.id))`).Scan(&busy); err != nil {
			return nil, err
		}
		if busy {
			return nil, invalid("存储配置暂不可切换：存在未完成或尚未清理的运营导出任务")
		}
		break
	}
	changed := []string{}
	for _, change := range plan {
		if change.Clear {
			if _, err := tx.Exec(ctx, `DELETE FROM system_setting WHERE key=$1`, change.Definition.Key); err != nil {
				return nil, err
			}
		} else {
			if _, err := writeSystemSetting(ctx, tx, change.Definition, change.Value, actor, true); err != nil {
				return nil, err
			}
		}
		changed = append(changed, change.Definition.Key)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return changed, nil
}
func importSettingsEnvironment(ctx context.Context, tx pgx.Tx, stored map[string]storedSystemSetting, actor string, overwrite bool) ([]string, int, error) {
	keys := []string{}
	skipped := 0
	for _, d := range systemSettingDefinitions {
		if d.ManagedByDedicatedOperation {
			continue
		}
		env := strings.TrimSpace(os.Getenv(d.Key))
		if env == "" {
			continue
		}
		if !overwrite && configuredSetting(stored[d.Key].Value) {
			skipped++
			continue
		}
		value, err := coerceSystemSetting(d, env)
		if err != nil {
			return nil, 0, err
		}
		if !configuredSetting(value) {
			continue
		}
		wrote, err := writeSystemSetting(ctx, tx, d, value, actor, overwrite)
		if err != nil {
			return nil, 0, err
		}
		if wrote {
			keys = append(keys, d.Key)
			stored[d.Key] = storedSystemSetting{Value: value, Secret: d.Secret}
		} else {
			skipped++
		}
	}
	return keys, skipped, nil
}
func (b *backend) importSettingsEnv(ctx context.Context, actor string, overwrite bool) ([]string, int, error) {
	tx, err := b.db.Begin(ctx)
	if err != nil {
		return nil, 0, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('system-settings:bootstrap'))`); err != nil {
		return nil, 0, err
	}
	stored, err := readSystemSettings(ctx, tx)
	if err != nil {
		return nil, 0, err
	}
	keys, skipped, err := importSettingsEnvironment(ctx, tx, stored, actor, overwrite)
	if err != nil {
		return nil, 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, 0, err
	}
	return keys, skipped, nil
}
func initializeSettingsDefaults(ctx context.Context, tx pgx.Tx, stored map[string]storedSystemSetting, actor string) ([]string, error) {
	keys, err := migrateCompatibleSettings(ctx, tx, stored, actor)
	if err != nil {
		return nil, err
	}
	for _, d := range systemSettingDefinitions {
		if d.Secret || configuredSetting(stored[d.Key].Value) {
			continue
		}
		value := d.DefaultValue
		if d.ExampleValue != nil {
			value = d.ExampleValue
		}
		if !configuredSetting(value) {
			continue
		}
		wrote, err := writeSystemSetting(ctx, tx, d, value, actor, false)
		if err != nil {
			return nil, err
		}
		if wrote {
			keys = append(keys, d.Key)
			stored[d.Key] = storedSystemSetting{Value: value}
		}
	}
	return keys, nil
}
func (b *backend) initializeSettingsDefaults(ctx context.Context, actor string) ([]string, error) {
	tx, err := b.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('system-settings:bootstrap'))`); err != nil {
		return nil, err
	}
	stored, err := readSystemSettings(ctx, tx)
	if err != nil {
		return nil, err
	}
	keys, err := initializeSettingsDefaults(ctx, tx, stored, actor)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return keys, nil
}
func (b *backend) bootstrapSettings(ctx context.Context) (map[string]any, error) {
	tx, err := b.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	// Serialize bootstrap's read/import/default sequence across Go processes.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('system-settings:bootstrap'))`); err != nil {
		return nil, err
	}
	stored, err := readSystemSettings(ctx, tx)
	if err != nil {
		return nil, err
	}
	imported, _, err := importSettingsEnvironment(ctx, tx, stored, "", false)
	if err != nil {
		return nil, err
	}
	initialized, err := initializeSettingsDefaults(ctx, tx, stored, "")
	if err != nil {
		return nil, err
	}
	loaded := 0
	for key, row := range stored {
		if _, known := systemSettingDefinitionByKey[key]; known && configuredSetting(row.Value) {
			loaded++
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	source := "database"
	if len(imported) > 0 {
		source = "hybrid"
		if loaded == len(imported) {
			source = "env"
		}
	}
	return map[string]any{"loadedCount": loaded, "source": source, "importedCount": len(imported), "initializedCount": len(initialized)}, nil
}
