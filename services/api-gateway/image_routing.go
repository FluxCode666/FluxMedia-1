package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type imageGroupSnapshot struct {
	Priority             int    `json:"priority"`
	ID                   string `json:"id"`
	Name                 string `json:"name"`
	ContentSafetyEnabled *bool  `json:"contentSafetyEnabled"`
	ImageCreditOverrides any    `json:"imageCreditOverrides"`
}

func (b *backend) resolveImageGroup(ctx context.Context, p *apiPrincipal, requested string) (imageGroupSnapshot, error) {
	if p == nil || p.UserID == "" {
		return imageGroupSnapshot{}, unauthorized()
	}
	target := strings.TrimSpace(requested)
	if p.KeyID != "" {
		if target != "" {
			return imageGroupSnapshot{}, &apiError{403, "BACKEND_GROUP_OVERRIDE_FORBIDDEN", "API Key 调用不能覆盖服务端绑定的媒体后端分组"}
		}
		var groupID *string
		if err := b.db.QueryRow(ctx, `SELECT generation_group_id FROM external_api_key WHERE id=$1 AND user_id=$2 AND is_active`, p.KeyID, p.UserID).Scan(&groupID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return imageGroupSnapshot{}, unauthorized()
			}
			return imageGroupSnapshot{}, err
		}
		if groupID != nil {
			target = *groupID
		}
	}
	rows, err := b.db.Query(ctx, `SELECT id,name,priority,is_default,is_user_selectable,content_safety_enabled,metadata FROM image_backend_group WHERE is_enabled ORDER BY id`)
	if err != nil {
		return imageGroupSnapshot{}, err
	}
	defer rows.Close()
	var selected imageGroupSnapshot
	matches := 0
	for rows.Next() {
		var group imageGroupSnapshot
		var isDefault, selectable bool
		var raw []byte
		if err := rows.Scan(&group.ID, &group.Name, &group.Priority, &isDefault, &selectable, &group.ContentSafetyEnabled, &raw); err != nil {
			return imageGroupSnapshot{}, err
		}
		if (target != "" && group.ID != target) || (target == "" && !isDefault) {
			continue
		}
		if p.KeyID == "" && requested != "" && !selectable {
			return imageGroupSnapshot{}, &apiError{403, "BACKEND_GROUP_NOT_SELECTABLE", "目标媒体后端分组不可由用户选择"}
		}
		var meta map[string]any
		_ = json.Unmarshal(raw, &meta)
		group.ImageCreditOverrides = meta["imageCreditOverrides"]
		selected = group
		matches++
	}
	if err := rows.Err(); err != nil {
		return imageGroupSnapshot{}, err
	}
	if matches != 1 {
		return imageGroupSnapshot{}, &apiError{503, "NO_ELIGIBLE_BACKEND_GROUP", "目标媒体后端分组不可用或未配置唯一默认分组"}
	}
	return selected, nil
}

// No image provider lookup is allowed to cross the authorized group. A pinned
// member is revalidated against that group when a queued job starts.
func (b *backend) pickImageProvider(ctx context.Context, model string, group imageGroupSnapshot, memberID string, requiresSafety bool) (providerConfig, error) {
	var cfg providerConfig
	var raw []byte
	var priority int
	selection := mediaSchedulerSelection{GroupID: group.ID, StartedAt: time.Now()}
	strategy, err := b.mediaSchedulingStrategy(ctx)
	if err != nil {
		return cfg, err
	}
	selection.Strategy = strategy
	groupIDs, err := reachableMediaGroupIDs(ctx, b.db, group.ID)
	if err != nil {
		return cfg, err
	}
	err = b.db.QueryRow(ctx, `SELECT m.id,m.priority,COALESCE(c.api_key,''),v.configuration,m.content_safety_enabled,v.id,count(*) OVER()
 FROM image_backend_member m

 JOIN image_backend_member_api_config c ON c.member_id=m.id
 JOIN image_backend_member_api_adapter_version v ON v.id=c.current_adapter_version_id AND v.member_id_snapshot=m.id AND v.credential_scope=c.credential_scope
 WHERE EXISTS(SELECT 1 FROM image_backend_member_group membership WHERE membership.member_id=m.id AND membership.group_id=ANY($2::text[])) AND m.type='api' AND m.is_enabled AND m.status<>'error' AND (m.cooldown_until IS NULL OR m.cooldown_until<=now())
 AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(m.supported_model_ids::jsonb) models(id) WHERE lower(trim(models.id))=lower(trim($1)))
 AND ($3='' OR m.id=$3) AND (NOT $4 OR m.content_safety_enabled)
 ORDER BY CASE WHEN m.concurrency>(SELECT count(*) FROM image_backend_member_lease l WHERE l.member_id=m.id AND l.expires_at>now()) THEN 0 ELSE 1 END,`+mediaSchedulingOrder(strategy)+` LIMIT 1`, model, groupIDs, memberID, requiresSafety).Scan(&cfg.memberID, &priority, &cfg.apiKey, &raw, &cfg.contentSafetyEnabled, &cfg.versionID, &selection.Candidates)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			if ctx.Value(imageWorkerClaimKey{}) != nil {
				if metricErr := b.recordMediaSchedulerRejection(ctx, "image", "no_candidate", selection); metricErr != nil {
					return cfg, metricErr
				}
			}
			return cfg, &apiError{503, "NO_ELIGIBLE_MEDIA_PROVIDER", fmt.Sprintf("已授权分组中没有可用的模型供应商: %s", model)}
		}
		return cfg, err
	}
	cfg.scheduler = &selection
	var settings map[string]any
	if json.Unmarshal(raw, &settings) != nil {
		return cfg, errors.New("invalid media provider configuration")
	}
	cfg.baseURL = stringValue(settings["baseUrl"])
	if cfg.baseURL == "" {
		cfg.baseURL = stringValue(settings["baseURL"])
	}
	if cfg.baseURL == "" {
		return cfg, errors.New("media provider baseUrl is missing")
	}
	cfg.baseURL = strings.TrimRight(cfg.baseURL, "/")
	cfg.operations, _ = settings["operations"].(map[string]any)
	cfg.adapter = settings
	cfg.auth = stringValue(settings["authentication"])
	if cfg.auth == "" {
		cfg.auth = "bearer"
	}
	if group.ContentSafetyEnabled != nil {
		cfg.contentSafetyEnabled = *group.ContentSafetyEnabled
	}
	return cfg, nil
}

func (b *backend) imageTaskProvider(ctx context.Context, generationID, userID, model string) (providerConfig, error) {
	var raw []byte
	if err := b.db.QueryRow(ctx, `SELECT metadata FROM generation WHERE id=$1 AND user_id=$2`, generationID, userID).Scan(&raw); err != nil {
		return providerConfig{}, err
	}
	var metadata struct {
		BillingSnapshot struct {
			Version           int                `json:"version"`
			Group             imageGroupSnapshot `json:"group"`
			ProviderMemberID  string             `json:"providerMemberId"`
			ModerationEnabled bool               `json:"moderationEnabled"`
		} `json:"billingSnapshot"`
	}
	if len(raw) > 0 && json.Unmarshal(raw, &metadata) != nil {
		return providerConfig{}, errors.New("invalid image billing snapshot")
	}
	snapshot := metadata.BillingSnapshot
	if snapshot.Version >= 2 {
		if snapshot.Group.ID == "" || snapshot.ProviderMemberID == "" {
			return providerConfig{}, errors.New("image billing snapshot omitted authorized route")
		}
		cfg, err := b.pickImageProvider(ctx, model, snapshot.Group, snapshot.ProviderMemberID, snapshot.ModerationEnabled)
		cfg.contentSafetyEnabled = snapshot.ModerationEnabled
		return cfg, err
	}
	// Pre-migration tasks do not contain trusted route metadata. Resolve their
	// principal from durable task ownership and API-key binding, never from input.
	var keyID string
	if err := b.db.QueryRow(ctx, `SELECT COALESCE(api_key_id,'') FROM image_async_task WHERE generation_id=$1 OR generation_ids::jsonb @> jsonb_build_array($1::text) ORDER BY created_at LIMIT 1`, generationID).Scan(&keyID); err != nil {
		return providerConfig{}, err
	}
	if keyID == "site" || keyID == "session" || keyID == "web:session" {
		keyID = ""
	}
	group, err := b.resolveImageGroup(ctx, &apiPrincipal{UserID: userID, KeyID: keyID}, "")
	if err != nil {
		return providerConfig{}, err
	}
	enabled, err := b.settingBool(ctx, "CONTENT_MODERATION_ENABLED", true)
	if err != nil {
		return providerConfig{}, err
	}
	return b.pickImageProvider(ctx, model, group, "", enabled && (group.ContentSafetyEnabled == nil || *group.ContentSafetyEnabled))
}
