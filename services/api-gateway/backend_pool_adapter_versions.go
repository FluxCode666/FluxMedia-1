package main

// API 供应商适配版本历史与回滚。
//
// 适配版本表只追加不修改：回滚不会把当前指针改回旧行，而是以旧版本配置为
// 基础追加一个新修订号，从而保留完整审计链。回滚始终保留当前的认证配置和
// 密钥，旧版本中的认证方式不会被恢复。

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// poolEditableConfigKeys 是保存接口接受的适配配置字段（不含密钥和乐观锁字段）。
var poolEditableConfigKeys = []string{
	"baseUrl", "useStream", "imageSizeConfigId", "imageSizeConfigIdsByModel",
	"imageMaxReferenceImages", "imageMaxReferenceImagesByModel",
	"convertReferenceImagesToPublicUrl", "videoSubmissionRetryCount", "videoProtocolMode",
	"videoInputFormat", "videoInputCapabilities", "videoInputCapabilitiesByModel",
	"modelMappings", "authentication", "operations",
}

// registerPoolAdapterVersionRoutes 注册后台会话使用的适配版本历史和回滚接口。
func (b *backend) registerPoolAdapterVersionRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/admin/image-backend/members/{id}/adapter-versions", b.endpoint(b.handlePoolAdapterVersions))
	mux.HandleFunc("GET /api/admin/image-backend/members/{id}/adapter-versions/{versionId}", b.endpoint(b.handlePoolAdapterVersion))
	mux.HandleFunc("POST /api/admin/image-backend/members/{id}/adapter-rollback", b.endpoint(b.handlePoolAdapterRollback))
}

// editableAdapterConfig 把已保存的脱敏配置快照转换为保存接口可接受的输入：
// 尺寸配置快照还原为 ID，并移除只读的派生字段。
func editableAdapterConfig(snapshot map[string]any) map[string]any {
	source := cloneJSONMap(snapshot)
	delete(source, "apiKey")
	poolAdapterDefaults(source)
	out := map[string]any{}
	for _, key := range poolEditableConfigKeys {
		if value, exists := source[key]; exists && value != nil {
			out[key] = value
		}
	}
	if sizeConfig, ok := source["imageSizeConfig"].(map[string]any); ok {
		if id, ok := sizeConfig["id"].(string); ok && id != "" {
			out["imageSizeConfigId"] = id
		}
	}
	if byModel, ok := source["imageSizeConfigsByModel"].(map[string]any); ok {
		ids := map[string]any{}
		for model, raw := range byModel {
			if sizeConfig, ok := raw.(map[string]any); ok {
				if id, ok := sizeConfig["id"].(string); ok && id != "" {
					ids[model] = id
				}
			}
		}
		out["imageSizeConfigIdsByModel"] = ids
	}
	return out
}

// cloneJSONMap 通过 JSON 往返深拷贝配置，避免修改调用方持有的快照。
func cloneJSONMap(value map[string]any) map[string]any {
	out := map[string]any{}
	if value == nil {
		return out
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return out
	}
	_ = json.Unmarshal(raw, &out)
	return out
}

// poolMemberRecord 是 queryPoolMembers 返回的单个脱敏成员及其当前版本信息。
type poolMemberRecord struct {
	Raw              map[string]any
	Write            poolMemberWrite
	CurrentVersionID string
	CurrentRevision  int
}

// loadPoolMemberRecord 读取单个成员，并构造可直接回写的保存输入。
func (b *backend) loadPoolMemberRecord(ctx context.Context, memberID string) (*poolMemberRecord, error) {
	memberID = strings.TrimSpace(memberID)
	if memberID == "" || len(memberID) > 128 {
		return nil, invalid("供应商 ID 无效")
	}
	records, err := b.queryPoolMembers(ctx, memberID)
	if err != nil {
		return nil, err
	}
	if len(records) == 0 {
		return nil, &apiError{http.StatusNotFound, "NOT_FOUND", "供应商不存在"}
	}
	raw, _ := records[0].(map[string]any)
	record := &poolMemberRecord{Raw: raw}
	encoded, err := json.Marshal(raw)
	if err != nil {
		return nil, err
	}
	var decoded struct {
		poolMemberWrite
		Config map[string]any `json:"config"`
	}
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		return nil, err
	}
	record.Write = decoded.poolMemberWrite
	record.Write.Type = "api"
	if record.Write.Resolutions == nil {
		record.Write.Resolutions = map[string][]string{}
	}
	if current, ok := decoded.Config["currentAdapterVersion"].(map[string]any); ok {
		record.CurrentVersionID, _ = current["id"].(string)
		if revision, ok := current["revision"].(float64); ok {
			record.CurrentRevision = int(revision)
		}
	}
	record.Write.Config = editableAdapterConfig(decoded.Config)
	return record, nil
}

// cloneMemberWrite 深拷贝保存输入，便于在副本上应用修改并与原值比较。
func cloneMemberWrite(in poolMemberWrite) poolMemberWrite {
	raw, _ := json.Marshal(in)
	var out poolMemberWrite
	_ = json.Unmarshal(raw, &out)
	return out
}

// poolChangedFields 比较两份保存输入，返回发生变化的字段路径（不含字段值）。
func poolChangedFields(before, after poolMemberWrite) []string {
	changed := []string{}
	beforeTop := memberWriteTopLevel(before)
	afterTop := memberWriteTopLevel(after)
	for key, value := range afterTop {
		if !reflect.DeepEqual(beforeTop[key], value) {
			changed = append(changed, key)
		}
	}
	beforeCfg := cloneJSONMap(before.Config)
	afterCfg := cloneJSONMap(after.Config)
	keys := map[string]bool{}
	for key := range beforeCfg {
		keys[key] = true
	}
	for key := range afterCfg {
		keys[key] = true
	}
	for key := range keys {
		if key == "expectedCurrentVersionId" {
			continue
		}
		if key == "operations" {
			beforeOps, _ := beforeCfg[key].(map[string]any)
			afterOps, _ := afterCfg[key].(map[string]any)
			for op := range apiUpstreamOperations {
				beforeEntry, _ := beforeOps[op].(map[string]any)
				afterEntry, _ := afterOps[op].(map[string]any)
				for _, field := range []string{"path", "requestScript", "responseScript"} {
					if !reflect.DeepEqual(beforeEntry[field], afterEntry[field]) {
						changed = append(changed, "config.operations."+op+"."+field)
					}
				}
			}
			continue
		}
		if !reflect.DeepEqual(beforeCfg[key], afterCfg[key]) {
			changed = append(changed, "config."+key)
		}
	}
	sort.Strings(changed)
	return changed
}

// memberWriteTopLevel 把成员顶层字段转换为可比较的 JSON 值（分组忽略顺序）。
func memberWriteTopLevel(in poolMemberWrite) map[string]any {
	groups := append([]string(nil), in.GroupIDs...)
	sort.Strings(groups)
	raw, _ := json.Marshal(map[string]any{
		"name": in.Name, "groupIds": groups, "supportedModelIds": in.Models,
		"supportedResolutionsByModel": in.Resolutions, "contentSafetyEnabled": in.Safety,
		"isEnabled": in.Enabled, "alwaysActive": in.Always, "failureCooldownEnabled": in.Cooldown,
		"priority": in.Priority, "concurrency": in.Concurrency,
	})
	out := map[string]any{}
	_ = json.Unmarshal(raw, &out)
	return out
}

// poolAdapterVersionSummary 是版本列表中的单条摘要，不包含脚本内容。
type poolAdapterVersionSummary struct {
	ID              string `json:"id"`
	Revision        int    `json:"revision"`
	CredentialScope string `json:"credentialScope"`
	BaseURL         string `json:"baseUrl"`
	CreatedAt       string `json:"createdAt"`
	IsCurrent       bool   `json:"isCurrent"`
}

// listPoolAdapterVersions 按修订号倒序分页列出成员的适配版本。
func (b *backend) listPoolAdapterVersions(ctx context.Context, memberID string, page, size int) (map[string]any, error) {
	record, err := b.loadPoolMemberRecord(ctx, memberID)
	if err != nil {
		return nil, err
	}
	var total int
	if err := b.db.QueryRow(ctx, `SELECT count(*) FROM image_backend_member_api_adapter_version WHERE member_id_snapshot=$1`, record.Write.ID).Scan(&total); err != nil {
		return nil, err
	}
	rows, err := b.db.Query(ctx, `SELECT id,revision,credential_scope,COALESCE(configuration->>'baseUrl',''),created_at FROM image_backend_member_api_adapter_version WHERE member_id_snapshot=$1 ORDER BY revision DESC LIMIT $2 OFFSET $3`, record.Write.ID, size, (page-1)*size)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []poolAdapterVersionSummary{}
	for rows.Next() {
		var item poolAdapterVersionSummary
		var created time.Time
		if err := rows.Scan(&item.ID, &item.Revision, &item.CredentialScope, &item.BaseURL, &created); err != nil {
			return nil, err
		}
		item.CreatedAt = created.UTC().Format(time.RFC3339Nano)
		item.IsCurrent = item.ID == record.CurrentVersionID
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	totalPages := (total + size - 1) / size
	if totalPages < 1 {
		totalPages = 1
	}
	return map[string]any{
		"memberId": record.Write.ID, "currentVersionId": record.CurrentVersionID,
		"items": items, "total": total, "page": page, "pageSize": size, "totalPages": totalPages,
	}, nil
}

// getPoolAdapterVersion 读取单个适配版本的完整脱敏配置。
func (b *backend) getPoolAdapterVersion(ctx context.Context, memberID, versionID string) (map[string]any, error) {
	versionID = strings.TrimSpace(versionID)
	if versionID == "" || len(versionID) > 256 {
		return nil, invalid("适配版本无效")
	}
	record, err := b.loadPoolMemberRecord(ctx, memberID)
	if err != nil {
		return nil, err
	}
	var summary poolAdapterVersionSummary
	var created time.Time
	var raw []byte
	err = b.db.QueryRow(ctx, `SELECT id,revision,credential_scope,COALESCE(configuration->>'baseUrl',''),created_at,configuration FROM image_backend_member_api_adapter_version WHERE member_id_snapshot=$1 AND id=$2`, record.Write.ID, versionID).Scan(&summary.ID, &summary.Revision, &summary.CredentialScope, &summary.BaseURL, &created, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, &apiError{http.StatusNotFound, "NOT_FOUND", "适配版本不存在"}
	}
	if err != nil {
		return nil, err
	}
	summary.CreatedAt = created.UTC().Format(time.RFC3339Nano)
	summary.IsCurrent = summary.ID == record.CurrentVersionID
	var cfg map[string]any
	_ = json.Unmarshal(raw, &cfg)
	if cfg == nil {
		cfg = map[string]any{}
	}
	delete(cfg, "apiKey")
	delete(cfg, "expectedCurrentVersionId")
	poolAdapterDefaults(cfg)
	return map[string]any{
		"id": summary.ID, "revision": summary.Revision, "credentialScope": summary.CredentialScope,
		"baseUrl": summary.BaseURL, "createdAt": summary.CreatedAt, "isCurrent": summary.IsCurrent,
		"config": cfg,
	}, nil
}

// poolRollbackInput 是回滚请求：以 VersionID 的配置追加新版本。
type poolRollbackInput struct {
	VersionID                string `json:"versionId"`
	ExpectedCurrentVersionID string `json:"expectedCurrentVersionId"`
	Reason                   string `json:"reason"`
	DryRun                   bool   `json:"dryRun"`
}

// poolRollbackOutcome 汇总回滚结果，供会话接口和 agent 接口共用。
type poolRollbackOutcome struct {
	Result        poolSaveResult
	Before        poolMemberWrite
	After         poolMemberWrite
	ChangedFields []string
	TargetVersion string
	TargetRev     int
}

// rollbackPoolAdapter 以目标版本配置追加新修订，保留当前成员字段、认证配置和密钥。
func (b *backend) rollbackPoolAdapter(ctx context.Context, memberID string, in poolRollbackInput) (*poolRollbackOutcome, error) {
	in.VersionID = strings.TrimSpace(in.VersionID)
	in.ExpectedCurrentVersionID = strings.TrimSpace(in.ExpectedCurrentVersionID)
	if in.VersionID == "" || len(in.VersionID) > 256 || in.ExpectedCurrentVersionID == "" || len(in.ExpectedCurrentVersionID) > 256 {
		return nil, invalid("回滚必须提供目标版本和当前版本")
	}
	if len([]rune(in.Reason)) > 500 {
		return nil, invalid("操作原因不能超过 500 个字符")
	}
	record, err := b.loadPoolMemberRecord(ctx, memberID)
	if err != nil {
		return nil, err
	}
	if record.CurrentVersionID != in.ExpectedCurrentVersionID {
		return nil, &apiError{http.StatusConflict, "VERSION_CONFLICT", "供应商配置已更新，请刷新后重试"}
	}
	var revision int
	var raw []byte
	err = b.db.QueryRow(ctx, `SELECT revision,configuration FROM image_backend_member_api_adapter_version WHERE member_id_snapshot=$1 AND id=$2`, record.Write.ID, in.VersionID).Scan(&revision, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, &apiError{http.StatusNotFound, "NOT_FOUND", "适配版本不存在"}
	}
	if err != nil {
		return nil, err
	}
	var target map[string]any
	if err := json.Unmarshal(raw, &target); err != nil || target == nil {
		return nil, invalid("适配版本配置无效")
	}
	after := cloneMemberWrite(record.Write)
	after.Config = editableAdapterConfig(target)
	after.Config["authentication"] = record.Write.Config["authentication"]
	changed := poolChangedFields(record.Write, after)
	after.Config["expectedCurrentVersionId"] = record.CurrentVersionID
	result, err := b.savePoolMember(ctx, after, poolSaveOptions{DryRun: in.DryRun, PreserveCredentials: true})
	if err != nil {
		return nil, err
	}
	delete(after.Config, "expectedCurrentVersionId")
	return &poolRollbackOutcome{Result: result, Before: record.Write, After: after, ChangedFields: changed, TargetVersion: in.VersionID, TargetRev: revision}, nil
}

// auditAdminWithMetadata 写入带扩展元数据的管理员审计记录，失败不阻断主流程。
func (b *backend) auditAdminWithMetadata(ctx context.Context, admin, action, reason string, before, after, metadata any) {
	raw1, _ := json.Marshal(before)
	raw2, _ := json.Marshal(after)
	raw3, _ := json.Marshal(metadata)
	_, _ = b.db.Exec(ctx, `INSERT INTO admin_audit_log(id,admin_user_id,target_user_id,action,reason,before,after,metadata) VALUES($1,$2,NULL,$3,$4,$5,$6,$7)`, newRequestID(), admin, action, strings.TrimSpace(reason), raw1, raw2, raw3)
}

// poolVersionAuditState 生成审计快照：只记录版本标识，不记录脚本或配置内容。
func poolVersionAuditState(versionID string, revision int) map[string]any {
	return map[string]any{"adapterVersionId": versionID, "revision": revision}
}

// handlePoolAdapterVersions 分页列出成员适配版本（后台只读角色可用）。
func (b *backend) handlePoolAdapterVersions(w http.ResponseWriter, r *http.Request) error {
	if _, err := b.requireAdminViewer(r); err != nil {
		return err
	}
	page, size := poolPage(r)
	out, err := b.listPoolAdapterVersions(r.Context(), r.PathValue("id"), page, size)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, out)
	return nil
}

// handlePoolAdapterVersion 读取单个适配版本详情（后台只读角色可用）。
func (b *backend) handlePoolAdapterVersion(w http.ResponseWriter, r *http.Request) error {
	if _, err := b.requireAdminViewer(r); err != nil {
		return err
	}
	out, err := b.getPoolAdapterVersion(r.Context(), r.PathValue("id"), r.PathValue("versionId"))
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, out)
	return nil
}

// handlePoolAdapterRollback 由后台管理员把适配配置回滚到历史版本并记录审计。
func (b *backend) handlePoolAdapterRollback(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireAdmin(r, false)
	if err != nil {
		return err
	}
	var in poolRollbackInput
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	outcome, err := b.rollbackPoolAdapter(r.Context(), r.PathValue("id"), in)
	if err != nil {
		return err
	}
	if !in.DryRun && outcome.Result.Changed {
		b.auditAdminWithMetadata(r.Context(), s.User.ID, "pool.member.adapter_rollback", in.Reason,
			poolVersionAuditState(outcome.Result.PreviousVersionID, outcome.Result.PreviousRevision),
			poolVersionAuditState(outcome.Result.VersionID, outcome.Result.Revision),
			map[string]any{"channel": "session", "memberId": outcome.Result.ID, "targetVersionId": outcome.TargetVersion, "targetRevision": outcome.TargetRev, "changedFields": outcome.ChangedFields})
	}
	writeJSON(w, http.StatusOK, poolRollbackResponse(outcome, in.DryRun))
	return nil
}

// poolRollbackResponse 构造回滚响应体。
func poolRollbackResponse(outcome *poolRollbackOutcome, dryRun bool) map[string]any {
	return map[string]any{
		"memberId": outcome.Result.ID, "dryRun": dryRun, "changed": outcome.Result.Changed,
		"changedFields":   outcome.ChangedFields,
		"previousVersion": map[string]any{"id": outcome.Result.PreviousVersionID, "revision": outcome.Result.PreviousRevision},
		"currentVersion":  poolResultVersion(outcome.Result, dryRun),
		"targetVersion":   map[string]any{"id": outcome.TargetVersion, "revision": outcome.TargetRev},
	}
}

// poolResultVersion 返回保存后的当前版本；预演时新版本并未落库，因此不返回其 ID。
func poolResultVersion(result poolSaveResult, dryRun bool) map[string]any {
	if dryRun && result.Changed {
		return map[string]any{"id": nil, "revision": result.Revision}
	}
	return map[string]any{"id": result.VersionID, "revision": result.Revision}
}
