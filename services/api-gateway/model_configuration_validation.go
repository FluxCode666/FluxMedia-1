package main

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"
)

var uuidPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func validateModelConfigurationCovers(config map[string]any, bucket string) error {
	for category, section := range map[string]string{"image": "imageByModel", "video": "videoByFamily"} {
		for _, raw := range goMapObject(config, section) {
			entry, ok := raw.(map[string]any)
			if !ok {
				return invalid("模型配置条目格式无效")
			}
			if err := validateModelCover(category, bucket, entry["cover"]); err != nil {
				return err
			}
		}
	}
	return nil
}

func validateModelConfigurationTarget(ctx context.Context, tx pgx.Tx, settings map[string]map[string]any, command *modelConfigurationCommand, existingCustom bool) error {
	config := settings["MODEL_MARKETPLACE_CONFIG"]
	_, builtVideo := goVideoCapabilities[command.Key]
	imageKnown := false
	for _, section := range []map[string]any{goMapObject(config, "imageByModel"), goMapObject(settings["IMAGE_MODEL_CREDIT_PRICES"], "byModel")} {
		for key := range section {
			if strings.EqualFold(key, command.Key) {
				imageKnown = true
			}
		}
	}
	// The adapter operation is part of model identity: an image-only member must
	// not make a video model configurable or vice versa.
	groupIDs, err := publicModelGroupIDs(ctx, tx)
	if err != nil {
		return err
	}
	var runtimeImage bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM image_backend_member m JOIN image_backend_member_group mg ON mg.member_id=m.id JOIN image_backend_group g ON g.id=mg.group_id JOIN image_backend_member_api_config c ON c.member_id=m.id JOIN image_backend_member_api_adapter_version v ON v.id=c.current_adapter_version_id AND v.member_id_snapshot=m.id AND v.credential_scope=c.credential_scope CROSS JOIN LATERAL jsonb_array_elements_text(m.supported_model_ids::jsonb) ids(id) WHERE m.is_enabled AND m.type='api' AND g.id=ANY($2::text[]) AND v.configuration::jsonb->'operations' ? 'images.generate' AND lower(ids.id)=lower($1))`, command.Key, groupIDs).Scan(&runtimeImage); err != nil {
		return err
	}
	imageKnown = imageKnown || runtimeImage
	if existingCustom && !command.IsCustom {
		return invalid("模型自定义标记与当前目录不一致")
	}
	if command.IsCustom && !existingCustom {
		custom, _ := config["customModels"].([]any)
		if len(custom) >= 200 {
			return invalid("自定义模型数量已达上限")
		}
		if builtVideo || imageKnown || goMapObject(config, "videoByFamily")[command.Key] != nil || *command.ExpectedRevision != 0 {
			return invalid("自定义模型ID已存在或修订号无效")
		}
	} else if !existingCustom {
		if command.Category == "image" && (!imageKnown || builtVideo) {
			return invalid("模型不在当前图像配置清单中")
		}
		if command.Category == "video" && !builtVideo {
			return invalid("模型不在当前视频配置清单中")
		}
	}
	if command.Category == "image" {
		return nil
	}
	settingsAny := map[string]any{}
	for key, value := range settings {
		settingsAny[key] = value
	}
	catalog, err := configureGoVideoModels(goVideoPricingContext{Models: map[string]goVideoModelConfig{}}, settingsAny)
	if err != nil {
		return err
	}
	cfg := catalog.Models[command.Key]
	if len(command.SupportedResolutions) == 0 {
		command.SupportedResolutions = cfg.SupportedResolutions
	}
	if len(command.SupportedResolutions) == 0 || len(command.SupportedResolutions) != len(command.CreditsPerSecond) || len(command.SupportedResolutions) != len(command.CreditsPerItem) {
		return invalid("视频分辨率价格与模型目录不一致")
	}
	for _, res := range command.SupportedResolutions {
		if command.CreditsPerSecond[res] <= 0 || command.CreditsPerItem[res] <= 0 {
			return invalid("视频两种价格必须完整覆盖所选分辨率")
		}
		if !command.IsCustom && !containsString([]string{"480p", "720p", "1080p", "2k", "4k", "8k"}, res) {
			return invalid("内置视频模型分辨率无效")
		}
		if command.IsCustom && !containsString([]string{"480p", "720p", "1080p", "2k", "4k", "8k"}, res) && len(command.OutputSizes[res]) != len(videoRatios) {
			return invalid("自定义视频分辨率必须为六种宽高比提供输出像素映射")
		}
	}
	if cfg.Capability.RefConfig {
		if command.MaxReferenceImages == nil || *command.MaxReferenceImages < 1 {
			return invalid("该视频模型必须提交有效参考图上限")
		}
	} else if command.MaxReferenceImages != nil {
		return invalid("该视频模型不允许配置参考图上限")
	}
	if !command.IsCustom && command.OutputSizes != nil {
		return invalid("输出像素映射只适用于自定义视频模型")
	}
	for res, sizes := range command.OutputSizes {
		if !containsString(command.SupportedResolutions, res) || len(sizes) == 0 {
			return invalid("输出像素映射必须对应支持的分辨率")
		}
		for ratio, size := range sizes {
			if !containsString(videoRatios, ratio) || size.Width < 1 || size.Height < 1 || size.Width > 9007199254740991 || size.Height > 9007199254740991 {
				return invalid("自定义视频输出像素无效")
			}
		}
	}
	return nil
}

func modelCoverReferenced(config map[string]any, cover any) bool {
	ref, ok := cover.(map[string]any)
	if !ok {
		return false
	}
	for _, section := range []string{"imageByModel", "videoByFamily"} {
		for _, raw := range goMapObject(config, section) {
			entry, _ := raw.(map[string]any)
			current := goMapObject(entry, "cover")
			if current["bucket"] == ref["bucket"] && current["key"] == ref["key"] {
				return true
			}
		}
	}
	return false
}

// Cleanup receipts survive provider failures and process crashes. The same
// settings lock used by mutations prevents deleting a cover being reattached.
func (b *backend) cleanupModelConfigurationCovers(ctx context.Context) error {
	bucket, _, err := b.storageBuckets(ctx)
	if err != nil {
		return err
	}
	tx, err := b.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('system-settings:bootstrap'))`); err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `SELECT id,metadata FROM admin_audit_log WHERE action='modelConfiguration.coverCleanup' AND COALESCE(metadata->>'completedAt','')='' ORDER BY created_at,id LIMIT 50 FOR UPDATE`)
	if err != nil {
		return err
	}
	type pendingCover struct {
		id  string
		ref map[string]any
	}
	pending := []pendingCover{}
	for rows.Next() {
		var id string
		var raw []byte
		if err = rows.Scan(&id, &raw); err != nil {
			rows.Close()
			return err
		}
		var ref map[string]any
		if json.Unmarshal(raw, &ref) != nil {
			rows.Close()
			return fmt.Errorf("invalid cover cleanup receipt")
		}
		pending = append(pending, pendingCover{id, ref})
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if len(pending) == 0 {
		return tx.Commit(ctx)
	}
	var raw []byte
	if err = tx.QueryRow(ctx, `SELECT value FROM system_setting WHERE key='MODEL_MARKETPLACE_CONFIG'`).Scan(&raw); err != nil {
		return err
	}
	var config map[string]any
	if json.Unmarshal(raw, &config) != nil {
		return invalid("模型配置格式无效")
	}
	for _, item := range pending {
		key := stringValue(item.ref["key"])
		category := strings.SplitN(key, "/", 2)[0]
		if category != "image" && category != "video" {
			return invalid("旧封面回收引用无效")
		}
		if err = validateModelCover(category, bucket, item.ref); err != nil {
			return err
		}
		if !modelCoverReferenced(config, item.ref) {
			if err = b.deleteStorageObject(ctx, bucket, key); err != nil {
				continue
			}
		}
		if _, err = tx.Exec(ctx, `UPDATE admin_audit_log SET metadata=metadata::jsonb||jsonb_build_object('completedAt',now()) WHERE id=$1`, item.id); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
