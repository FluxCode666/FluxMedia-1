package main

// 管理员 agent 通用接口（/me）与供应商适配器配置接口：/api/admin-agent/v1/*。
//
// 外部 agent 使用全局 agent 令牌读取 API 供应商配置、运行无网络脚本测试、增量修改
// 配置和回滚历史版本。读取与脚本测试需要 suppliers:read，修改与回滚需要
// suppliers:write。约束如下：
//   - 任何接口都不返回供应商密钥；
//   - 不允许修改密钥（apiKey）和认证配置（authentication），baseUrl 可以修改；
//   - 每次修改必须携带 expectedCurrentVersionId 做乐观锁；
//   - 适配配置变化会追加新版本，只影响新任务，运行中任务继续固定旧版本；
//   - 每次实际写入都记录管理员审计日志，但不记录脚本或配置内容。

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"time"
)

// adminAgentPatchableConfigKeys 是 agent 可修改的适配配置字段（不含认证和密钥）。
var adminAgentPatchableConfigKeys = map[string]bool{
	"baseUrl": true, "useStream": true, "imageSizeConfigId": true, "imageSizeConfigIdsByModel": true,
	"imageMaxReferenceImages": true, "imageMaxReferenceImagesByModel": true,
	"convertReferenceImagesToPublicUrl": true, "videoSubmissionRetryCount": true,
	"videoProtocolMode": true, "videoInputFormat": true, "videoInputCapabilities": true,
	"videoInputCapabilitiesByModel": true, "modelMappings": true, "operations": true,
}

// registerAdminAgentRoutes 注册 agent 令牌鉴权的通用接口与供应商配置接口。
func (b *backend) registerAdminAgentRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/admin-agent/v1/me", b.endpoint(b.handleAdminAgentMe))
	mux.HandleFunc("GET /api/admin-agent/v1/catalog", b.endpoint(b.handleAdminAgentCatalog))
	mux.HandleFunc("GET /api/admin-agent/v1/suppliers", b.endpoint(b.handleAdminAgentSuppliers))
	mux.HandleFunc("GET /api/admin-agent/v1/suppliers/{id}", b.endpoint(b.handleAdminAgentSupplier))
	mux.HandleFunc("PATCH /api/admin-agent/v1/suppliers/{id}", b.endpoint(b.handleAdminAgentPatchSupplier))
	mux.HandleFunc("GET /api/admin-agent/v1/suppliers/{id}/versions", b.endpoint(b.handleAdminAgentVersions))
	mux.HandleFunc("GET /api/admin-agent/v1/suppliers/{id}/versions/{versionId}", b.endpoint(b.handleAdminAgentVersion))
	mux.HandleFunc("POST /api/admin-agent/v1/suppliers/{id}/rollback", b.endpoint(b.handleAdminAgentRollback))
	mux.HandleFunc("POST /api/admin-agent/v1/script-test", b.endpoint(b.handleAdminAgentScriptTest))
}

// handleAdminAgentMe 返回当前令牌身份与授权范围，供 agent 在开始工作前自检权限。
// 任何有效令牌都可调用，不要求特定 scope；availableScopes 列出全部可签发的 scope。
func (b *backend) handleAdminAgentMe(w http.ResponseWriter, r *http.Request) error {
	principal, err := b.authenticateAdminAgent(r)
	if err != nil {
		return err
	}
	noStore(w)
	writeJSON(w, http.StatusOK, map[string]any{
		"tokenId": principal.TokenID, "tokenName": principal.TokenName, "scopes": nonNilStrings(principal.Scopes),
		"availableScopes": adminAgentScopeRegistry,
		"user":            map[string]any{"id": principal.UserID, "role": principal.Role},
	})
	return nil
}

// handleAdminAgentCatalog 返回分组、尺寸配置集和操作清单，供 agent 选择合法 ID。
func (b *backend) handleAdminAgentCatalog(w http.ResponseWriter, r *http.Request) error {
	if _, err := b.requireAdminAgentScope(r, adminAgentScopeSuppliersRead); err != nil {
		return err
	}
	groups, err := b.backendPoolGroups(r)
	if err != nil {
		return err
	}
	groupItems := make([]map[string]any, 0, len(groups))
	for _, group := range groups {
		groupItems = append(groupItems, map[string]any{"id": group["id"], "name": group["name"], "isEnabled": group["isEnabled"]})
	}
	rows, err := b.db.Query(r.Context(), `SELECT id,name FROM image_size_config ORDER BY name ASC,id ASC`)
	if err != nil {
		return err
	}
	defer rows.Close()
	sizeConfigs := make([]map[string]any, 0)
	for rows.Next() {
		var id, name string
		if err := rows.Scan(&id, &name); err != nil {
			return err
		}
		sizeConfigs = append(sizeConfigs, map[string]any{"id": id, "name": name})
	}
	if err := rows.Err(); err != nil {
		return err
	}
	operations := []map[string]any{
		{"id": "images.generate", "method": "POST", "defaultPath": "/images/generations", "contentType": "application/json"},
		{"id": "images.generate.query", "method": "GET", "defaultPath": "", "contentType": nil},
		{"id": "images.edit", "method": "POST", "defaultPath": "/images/edits", "contentType": "multipart/form-data"},
		{"id": "images.edit.query", "method": "GET", "defaultPath": "", "contentType": nil},
		{"id": "videos.generate", "method": "POST", "defaultPath": "/videos/generations", "contentType": "application/json"},
		{"id": "videos.query", "method": "GET", "defaultPath": "/videos/{task_id}", "contentType": nil},
	}
	noStore(w)
	writeJSON(w, http.StatusOK, map[string]any{
		"groups": groupItems, "sizeConfigs": sizeConfigs, "operations": operations,
		"limits":              map[string]any{"scriptMaxLength": 32768, "pathMaxLength": 2048},
		"patchableConfigKeys": sortedKeys(adminAgentPatchableConfigKeys),
		"forbiddenConfigKeys": []string{"apiKey", "authentication", "credentialScope"},
		"videoProtocolModes":  []string{"custom", "gemini", "seedance"},
		"videoInputFormats":   []string{"url", "base64"},
	})
	return nil
}

// handleAdminAgentSuppliers 列出供应商摘要（不含脚本内容和密钥）。
func (b *backend) handleAdminAgentSuppliers(w http.ResponseWriter, r *http.Request) error {
	if _, err := b.requireAdminAgentScope(r, adminAgentScopeSuppliersRead); err != nil {
		return err
	}
	records, err := b.queryPoolMembers(r.Context(), "")
	if err != nil {
		return err
	}
	query := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	items := make([]map[string]any, 0, len(records))
	for _, raw := range records {
		member, _ := raw.(map[string]any)
		name, _ := member["name"].(string)
		id, _ := member["id"].(string)
		if query != "" && !strings.Contains(strings.ToLower(name), query) && !strings.Contains(strings.ToLower(id), query) {
			continue
		}
		items = append(items, adminAgentSupplierSummary(member))
	}
	noStore(w)
	writeJSON(w, http.StatusOK, map[string]any{"suppliers": items})
	return nil
}

// adminAgentSupplierSummary 生成供应商摘要，只列出已配置脚本的操作名而不含源码。
func adminAgentSupplierSummary(member map[string]any) map[string]any {
	cfg, _ := member["config"].(map[string]any)
	scripted := []string{}
	if operations, ok := cfg["operations"].(map[string]any); ok {
		for _, op := range sortedKeys(apiUpstreamOperations) {
			entry, _ := operations[op].(map[string]any)
			for _, field := range []string{"requestScript", "responseScript"} {
				if script, _ := entry[field].(string); strings.TrimSpace(script) != "" {
					scripted = append(scripted, op+"."+field)
				}
			}
		}
	}
	return map[string]any{
		"id": member["id"], "name": member["name"], "isEnabled": member["isEnabled"],
		"status": member["status"], "healthStatus": member["healthStatus"], "groupIds": member["groupIds"],
		"supportedModelIds": member["supportedModelIds"], "baseUrl": cfg["baseUrl"],
		"videoProtocolMode": cfg["videoProtocolMode"], "hasApiKey": cfg["hasApiKey"],
		"currentAdapterVersion": cfg["currentAdapterVersion"], "scriptedFields": scripted,
	}
}

// handleAdminAgentSupplier 返回单个供应商：supplier 为脱敏详情，editable 为可直接修改的输入形状。
func (b *backend) handleAdminAgentSupplier(w http.ResponseWriter, r *http.Request) error {
	if _, err := b.requireAdminAgentScope(r, adminAgentScopeSuppliersRead); err != nil {
		return err
	}
	record, err := b.loadPoolMemberRecord(r.Context(), r.PathValue("id"))
	if err != nil {
		return err
	}
	noStore(w)
	writeJSON(w, http.StatusOK, adminAgentSupplierDetail(record))
	return nil
}

// adminAgentSupplierDetail 组装供应商详情响应。
func adminAgentSupplierDetail(record *poolMemberRecord) map[string]any {
	return map[string]any{
		"supplier":                 record.Raw,
		"editable":                 adminAgentEditable(record.Write),
		"expectedCurrentVersionId": record.CurrentVersionID,
		"currentRevision":          record.CurrentRevision,
	}
}

// adminAgentEditable 把保存输入转换为 PATCH 可接受的字段形状（不含 id/type）。
func adminAgentEditable(in poolMemberWrite) map[string]any {
	out := memberWriteTopLevel(in)
	cfg := cloneJSONMap(in.Config)
	delete(cfg, "expectedCurrentVersionId")
	out["config"] = cfg
	return out
}

// adminAgentSupplierPatch 是 agent 增量修改请求；省略的字段保持不变。
type adminAgentSupplierPatch struct {
	ExpectedCurrentVersionID string               `json:"expectedCurrentVersionId"`
	Reason                   string               `json:"reason"`
	DryRun                   bool                 `json:"dryRun"`
	Name                     *string              `json:"name"`
	GroupIDs                 *[]string            `json:"groupIds"`
	Models                   *[]string            `json:"supportedModelIds"`
	Resolutions              *map[string][]string `json:"supportedResolutionsByModel"`
	Safety                   *bool                `json:"contentSafetyEnabled"`
	Enabled                  *bool                `json:"isEnabled"`
	Always                   *bool                `json:"alwaysActive"`
	Cooldown                 *bool                `json:"failureCooldownEnabled"`
	Priority                 *int                 `json:"priority"`
	Concurrency              *int                 `json:"concurrency"`
	Config                   map[string]any       `json:"config"`
}

// applyAdminAgentPatch 把增量修改应用到保存输入副本上。
// 配置字段整体替换，null 表示恢复默认；operations 按操作和字段合并，null 表示清空。
func applyAdminAgentPatch(base poolMemberWrite, patch adminAgentSupplierPatch) (poolMemberWrite, error) {
	next := cloneMemberWrite(base)
	if next.Config == nil {
		next.Config = map[string]any{}
	}
	if patch.Name != nil {
		next.Name = *patch.Name
	}
	if patch.GroupIDs != nil {
		next.GroupIDs = *patch.GroupIDs
	}
	if patch.Models != nil {
		next.Models = *patch.Models
	}
	if patch.Resolutions != nil {
		next.Resolutions = *patch.Resolutions
	}
	if patch.Safety != nil {
		next.Safety = *patch.Safety
	}
	if patch.Enabled != nil {
		next.Enabled = *patch.Enabled
	}
	if patch.Always != nil {
		next.Always = *patch.Always
	}
	if patch.Cooldown != nil {
		next.Cooldown = *patch.Cooldown
	}
	if patch.Priority != nil {
		next.Priority = *patch.Priority
	}
	if patch.Concurrency != nil {
		next.Concurrency = *patch.Concurrency
	}
	for key, value := range patch.Config {
		if key == "apiKey" || key == "authentication" {
			return next, forbiddenCredentialChange()
		}
		if !adminAgentPatchableConfigKeys[key] {
			return next, invalid("不支持修改的供应商配置字段: " + key)
		}
		if key == "operations" {
			if err := mergeAdminAgentOperations(next.Config, value); err != nil {
				return next, err
			}
			continue
		}
		if value == nil {
			delete(next.Config, key)
			continue
		}
		next.Config[key] = value
	}
	return next, nil
}

// mergeAdminAgentOperations 按操作和字段合并六操作配置。
func mergeAdminAgentOperations(cfg map[string]any, value any) error {
	patch, ok := value.(map[string]any)
	if !ok {
		return invalid("operations 必须是对象")
	}
	operations, _ := cfg["operations"].(map[string]any)
	if operations == nil {
		operations = map[string]any{}
	}
	for op, raw := range patch {
		if !apiUpstreamOperations[op] {
			return invalid("未知的供应商操作: " + op)
		}
		fields, ok := raw.(map[string]any)
		if !ok {
			return invalid("供应商操作 " + op + " 的配置必须是对象")
		}
		entry, _ := operations[op].(map[string]any)
		if entry == nil {
			entry = map[string]any{}
		}
		for field, fieldValue := range fields {
			if field != "path" && field != "requestScript" && field != "responseScript" {
				return invalid("供应商操作 " + op + " 不支持字段: " + field)
			}
			if fieldValue == nil {
				entry[field] = ""
				continue
			}
			text, ok := fieldValue.(string)
			if !ok {
				return invalid("供应商操作 " + op + "." + field + " 必须是字符串")
			}
			entry[field] = text
		}
		operations[op] = entry
	}
	cfg["operations"] = operations
	return nil
}

// handleAdminAgentPatchSupplier 增量修改供应商配置；dryRun 时只校验不落库。
func (b *backend) handleAdminAgentPatchSupplier(w http.ResponseWriter, r *http.Request) error {
	principal, err := b.requireAdminAgentScope(r, adminAgentScopeSuppliersWrite)
	if err != nil {
		return err
	}
	var patch adminAgentSupplierPatch
	if err := decodeBody(r, &patch); err != nil {
		return err
	}
	patch.ExpectedCurrentVersionID = strings.TrimSpace(patch.ExpectedCurrentVersionID)
	if patch.ExpectedCurrentVersionID == "" || len(patch.ExpectedCurrentVersionID) > 256 {
		return invalid("必须提供 expectedCurrentVersionId")
	}
	if len([]rune(patch.Reason)) > 500 {
		return invalid("操作原因不能超过 500 个字符")
	}
	record, err := b.loadPoolMemberRecord(r.Context(), r.PathValue("id"))
	if err != nil {
		return err
	}
	if record.CurrentVersionID != patch.ExpectedCurrentVersionID {
		return &apiError{http.StatusConflict, "VERSION_CONFLICT", "供应商配置已更新，请重新读取后重试"}
	}
	next, err := applyAdminAgentPatch(record.Write, patch)
	if err != nil {
		return err
	}
	changed := poolChangedFields(record.Write, next)
	if len(changed) == 0 {
		return invalid("没有需要修改的字段")
	}
	next.Config["expectedCurrentVersionId"] = record.CurrentVersionID
	result, err := b.savePoolMember(r.Context(), next, poolSaveOptions{DryRun: patch.DryRun, PreserveCredentials: true})
	if err != nil {
		return err
	}
	delete(next.Config, "expectedCurrentVersionId")
	response := map[string]any{
		"memberId": result.ID, "dryRun": patch.DryRun, "changed": true, "versionCreated": result.Changed,
		"changedFields":   changed,
		"previousVersion": map[string]any{"id": result.PreviousVersionID, "revision": result.PreviousRevision},
		"currentVersion":  poolResultVersion(result, patch.DryRun),
		"editable":        adminAgentEditable(next),
	}
	if !patch.DryRun {
		b.auditAdminAgentWrite(r.Context(), principal, "admin_agent.supplier.update", patch.Reason, result, changed, nil)
		if fresh, err := b.loadPoolMemberRecord(r.Context(), result.ID); err == nil {
			response["supplier"] = fresh.Raw
			response["expectedCurrentVersionId"] = fresh.CurrentVersionID
		}
	}
	writeJSON(w, http.StatusOK, response)
	return nil
}

// auditAdminAgentWrite 记录 agent 写操作审计：令牌身份、成员、版本和变更字段名。
func (b *backend) auditAdminAgentWrite(ctx context.Context, principal *adminAgentPrincipal, action, reason string, result poolSaveResult, changed []string, extra map[string]any) {
	metadata := map[string]any{
		"channel": "agent", "tokenId": principal.TokenID, "tokenName": principal.TokenName,
		"memberId": result.ID, "changedFields": changed, "versionCreated": result.Changed,
	}
	for key, value := range extra {
		metadata[key] = value
	}
	b.auditAdminWithMetadata(ctx, principal.UserID, action, reason,
		poolVersionAuditState(result.PreviousVersionID, result.PreviousRevision),
		poolVersionAuditState(result.VersionID, result.Revision), metadata)
}

// handleAdminAgentVersions 分页列出适配版本。
func (b *backend) handleAdminAgentVersions(w http.ResponseWriter, r *http.Request) error {
	if _, err := b.requireAdminAgentScope(r, adminAgentScopeSuppliersRead); err != nil {
		return err
	}
	page, size := poolPage(r)
	out, err := b.listPoolAdapterVersions(r.Context(), r.PathValue("id"), page, size)
	if err != nil {
		return err
	}
	noStore(w)
	writeJSON(w, http.StatusOK, out)
	return nil
}

// handleAdminAgentVersion 读取单个适配版本详情。
func (b *backend) handleAdminAgentVersion(w http.ResponseWriter, r *http.Request) error {
	if _, err := b.requireAdminAgentScope(r, adminAgentScopeSuppliersRead); err != nil {
		return err
	}
	out, err := b.getPoolAdapterVersion(r.Context(), r.PathValue("id"), r.PathValue("versionId"))
	if err != nil {
		return err
	}
	noStore(w)
	writeJSON(w, http.StatusOK, out)
	return nil
}

// handleAdminAgentRollback 以历史版本配置追加新版本，保留当前认证与密钥。
func (b *backend) handleAdminAgentRollback(w http.ResponseWriter, r *http.Request) error {
	principal, err := b.requireAdminAgentScope(r, adminAgentScopeSuppliersWrite)
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
		b.auditAdminAgentWrite(r.Context(), principal, "admin_agent.supplier.rollback", in.Reason, outcome.Result, outcome.ChangedFields,
			map[string]any{"targetVersionId": outcome.TargetVersion, "targetRevision": outcome.TargetRev})
	}
	writeJSON(w, http.StatusOK, poolRollbackResponse(outcome, in.DryRun))
	return nil
}

// adminAgentScriptTestRequest 是 agent 脚本测试请求：script 与 supplierId 二选一。
// 提供 supplierId 时测试该供应商当前已保存的脚本。
type adminAgentScriptTestRequest struct {
	Operation  string          `json:"operation"`
	Stage      string          `json:"stage"`
	Script     *string         `json:"script"`
	SupplierID string          `json:"supplierId"`
	Sample     json.RawMessage `json:"sample"`
}

// handleAdminAgentScriptTest 使用合成样例运行脚本，不访问上游、不读取密钥、不产生费用。
func (b *backend) handleAdminAgentScriptTest(w http.ResponseWriter, r *http.Request) error {
	if _, err := b.requireAdminAgentScope(r, adminAgentScopeSuppliersRead); err != nil {
		return err
	}
	var in adminAgentScriptTestRequest
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	supplierID := strings.TrimSpace(in.SupplierID)
	if (in.Script == nil) == (supplierID == "") {
		return invalid("script 与 supplierId 必须且只能提供一个")
	}
	script := ""
	source := "inline"
	if in.Script != nil {
		script = *in.Script
	} else {
		if !apiUpstreamOperations[in.Operation] || (in.Stage != "request" && in.Stage != "response") {
			return invalid("API 上游脚本操作或阶段无效")
		}
		record, err := b.loadPoolMemberRecord(r.Context(), supplierID)
		if err != nil {
			return err
		}
		operations, _ := record.Write.Config["operations"].(map[string]any)
		entry, _ := operations[in.Operation].(map[string]any)
		script, _ = entry[in.Stage+"Script"].(string)
		source = "supplier"
	}
	started := time.Now()
	preview, err := b.runApiUpstreamScriptTest(r.Context(), apiUpstreamScriptTestRequest{Operation: in.Operation, Stage: in.Stage, Script: script, Sample: in.Sample})
	if err != nil {
		return err
	}
	noStore(w)
	writeJSON(w, http.StatusOK, map[string]any{
		"preview": preview, "source": source, "scriptEmpty": strings.TrimSpace(script) == "",
		"elapsedMs": time.Since(started).Milliseconds(),
	})
	return nil
}

// sortedKeys 返回布尔集合的有序键列表，保证响应稳定。
func sortedKeys(set map[string]bool) []string {
	keys := make([]string, 0, len(set))
	for key := range set {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
