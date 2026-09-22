package main

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"net/url"
	"reflect"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
)

type poolMemberWrite struct {
	ID          string              `json:"id"`
	Type        string              `json:"type"`
	Name        string              `json:"name"`
	GroupIDs    []string            `json:"groupIds"`
	Models      []string            `json:"supportedModelIds"`
	Resolutions map[string][]string `json:"supportedResolutionsByModel"`
	Safety      bool                `json:"contentSafetyEnabled"`
	Enabled     bool                `json:"isEnabled"`
	Always      bool                `json:"alwaysActive"`
	Cooldown    bool                `json:"failureCooldownEnabled"`
	Priority    int                 `json:"priority"`
	Concurrency int                 `json:"concurrency"`
	Config      map[string]any      `json:"config"`
}

func poolAdapterDefaults(config map[string]any) {
	defaults := map[string]any{"useStream": false, "imageSizeConfig": nil, "imageSizeConfigsByModel": map[string]any{}, "imageMaxReferenceImagesByModel": map[string]any{}, "convertReferenceImagesToPublicUrl": false, "videoSubmissionRetryCount": float64(2), "videoProtocolMode": "custom", "videoInputFormat": "url", "videoInputCapabilities": map[string]any{"referenceVideos": false, "referenceAudios": false}, "videoInputCapabilitiesByModel": map[string]any{}, "modelMappings": []any{}, "authentication": map[string]any{"mode": "bearer"}}
	for key, value := range defaults {
		if config[key] == nil {
			config[key] = value
		}
	}
	operations, ok := config["operations"].(map[string]any)
	if !ok {
		operations = map[string]any{}
	}
	for op := range apiUpstreamOperations {
		entry, ok := operations[op].(map[string]any)
		if !ok {
			entry = map[string]any{}
		}
		for _, field := range []string{"path", "requestScript", "responseScript"} {
			if entry[field] == nil {
				entry[field] = ""
			}
		}
		operations[op] = entry
	}
	config["operations"] = operations
}

func poolCredentialScope(config map[string]any) (string, error) {
	base, err := url.Parse(extractString(config, "baseUrl"))
	if err != nil || base.Host == "" || (base.Scheme != "http" && base.Scheme != "https") || base.User != nil || base.Fragment != "" || base.RawQuery != "" || base.ForceQuery {
		return "", invalid("媒体上游地址无效")
	}
	auth, ok := config["authentication"].(map[string]any)
	if !ok {
		return "", invalid("供应商认证配置无效")
	}
	mode := extractString(auth, "mode")
	if mode != "none" && mode != "bearer" && mode != "raw_authorization" && mode != "custom_header" {
		return "", invalid("供应商认证方式无效")
	}
	if !settingsObjectHasOnly(auth, "mode", "headerName") || (mode != "custom_header" && auth["headerName"] != nil) {
		return "", invalid("供应商认证字段无效")
	}
	host := base.Host
	if base.Scheme == "https" && base.Port() == "443" || base.Scheme == "http" && base.Port() == "80" {
		host = base.Hostname()
		if strings.Contains(host, ":") {
			host = "[" + host + "]"
		}
	}
	scope := strings.ToLower(base.Scheme+"://"+host) + "|" + mode
	if mode == "custom_header" {
		cfg := providerConfig{apiKey: "validation", adapter: config}
		if _, _, err := imageProviderAuthentication(cfg); err != nil || poolBlockedAuthHeader(extractString(auth, "headerName")) {
			return "", invalid("供应商认证请求头无效")
		}
		scope += ":" + strings.ToLower(extractString(auth, "headerName"))
	}
	return scope, nil
}

func readPoolSizeSnapshot(ctx context.Context, tx pgx.Tx, id string) (any, error) {
	if id == "" {
		return nil, nil
	}
	var name string
	if err := tx.QueryRow(ctx, `SELECT name FROM image_size_config WHERE id=$1 FOR SHARE`, id).Scan(&name); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, invalid("尺寸配置集不存在")
		}
		return nil, err
	}
	rows, err := tx.Query(ctx, `SELECT resolution,aspect_ratio,size FROM image_size_config_mapping WHERE config_id=$1 ORDER BY resolution,aspect_ratio,size`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	mappings := []any{}
	for rows.Next() {
		var resolution, ratio, size string
		if err = rows.Scan(&resolution, &ratio, &size); err != nil {
			return nil, err
		}
		mappings = append(mappings, map[string]any{"resolution": resolution, "aspectRatio": ratio, "size": size})
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	return map[string]any{"id": id, "name": name, "mappings": mappings}, nil
}

func (b *backend) validatePoolAdapter(ctx context.Context, cfg map[string]any) error {
	for _, key := range []string{"useStream", "convertReferenceImagesToPublicUrl"} {
		if _, ok := cfg[key].(bool); !ok {
			return invalid(key + " must be a boolean")
		}
	}
	for _, key := range []string{"imageMaxReferenceImages", "videoSubmissionRetryCount"} {
		if v, exists := cfg[key]; exists {
			n, ok := v.(float64)
			max := float64(9007199254740991)
			if key == "videoSubmissionRetryCount" {
				max = 10
			}
			if !ok || n < 0 || n > max || math.Trunc(n) != n {
				return invalid(key + " is invalid")
			}
		}
	}
	if !containsString([]string{"custom", "gemini", "seedance"}, extractString(cfg, "videoProtocolMode")) || !containsString([]string{"url", "base64"}, extractString(cfg, "videoInputFormat")) {
		return invalid("视频供应商协议配置无效")
	}
	operations := cfg["operations"].(map[string]any)
	for op, raw := range operations {
		entry, ok := raw.(map[string]any)
		if !apiUpstreamOperations[op] || !ok || !settingsObjectHasOnly(entry, "path", "requestScript", "responseScript") {
			return invalid("供应商操作配置无效")
		}
		path, ok := entry["path"].(string)
		if !ok || len(path) > 2048 {
			return invalid("供应商操作路径无效")
		}
		if path != "" {
			if !strings.HasPrefix(path, "/") || strings.HasPrefix(path, "//") || strings.ContainsAny(path, "\\?#\r\n\x00") {
				return invalid("供应商操作路径必须为相对路径")
			}
			decoded := path
			for range 4 {
				next, e := url.PathUnescape(decoded)
				if e != nil {
					return invalid("供应商操作路径编码无效")
				}
				if next == decoded {
					break
				}
				decoded = next
			}
			if strings.HasPrefix(decoded, "//") || strings.ContainsAny(decoded, "\\?#") || strings.IndexFunc(decoded, func(r rune) bool { return r < 32 || r == 127 }) >= 0 {
				return invalid("供应商操作路径无效")
			}
			for _, segment := range strings.Split(decoded, "/") {
				if segment == "." || segment == ".." {
					return invalid("供应商操作路径不能包含父级目录")
				}
			}
			count := strings.Count(path, "{task_id}")
			if strings.HasSuffix(op, ".query") && count != 1 || !strings.HasSuffix(op, ".query") && count != 0 {
				return invalid("供应商操作任务占位符无效")
			}
		}
		for _, stage := range []string{"request", "response"} {
			script, ok := entry[stage+"Script"].(string)
			if !ok || len([]rune(script)) > 32768 {
				return invalid("供应商脚本无效")
			}
			if strings.TrimSpace(script) == "" {
				continue
			}
			client := newScriptRuntimeClient(b.config.scriptRuntimeURL, b.config.scriptRuntimeToken)
			if client == nil {
				return &apiError{503, "SCRIPT_RUNTIME_UNAVAILABLE", "供应商脚本校验服务不可用"}
			}
			_, err := client.execute(ctx, scriptRuntimeRequest{ValidateOnly: true, Script: script, Operation: op, Stage: stage, Input: map[string]any{}, Context: map[string]any{}})
			if err != nil {
				var unavailable *scriptRuntimeUnavailableError
				if errors.As(err, &unavailable) {
					return &apiError{503, "SCRIPT_RUNTIME_UNAVAILABLE", "供应商脚本校验服务不可用"}
				}
				return invalid("供应商脚本语法无效")
			}
		}
	}
	return nil
}

func (b *backend) backendPoolSaveMember(w http.ResponseWriter, r *http.Request) error {
	var in poolMemberWrite
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	in.Name = strings.TrimSpace(in.Name)
	in.ID = strings.TrimSpace(in.ID)
	if in.Type != "api" || in.Name == "" || len([]rune(in.Name)) > 120 || len(in.ID) > 128 || in.Priority < 0 || in.Priority > 10000 || in.Concurrency < 1 || in.Concurrency > 10000 || len(in.GroupIDs) < 1 || len(in.GroupIDs) > 100 || len(in.Models) < 1 {
		return invalid("供应商成员字段无效")
	}
	models := map[string]bool{}
	normalized := []string{}
	for _, id := range in.Models {
		id = strings.TrimSpace(id)
		lower := strings.ToLower(id)
		if id == "" || len(id) > 240 || isLegacyVideoModel(id) {
			return invalid("供应商模型 ID 无效")
		}
		if !models[lower] {
			normalized = append(normalized, id)
			models[lower] = true
		}
	}
	in.Models = normalized
	groups := map[string]bool{}
	for _, id := range in.GroupIDs {
		if id == "" || len(id) > 128 || groups[id] {
			return invalid("供应商分组不能为空或重复")
		}
		groups[id] = true
	}
	if in.Resolutions == nil {
		in.Resolutions = map[string][]string{}
	}
	for id, values := range in.Resolutions {
		if !models[strings.ToLower(id)] || len(values) == 0 || len(values) > 20 {
			return invalid("供应商模型分辨率无效")
		}
	}
	cfg := in.Config
	if cfg == nil || !settingsObjectHasOnly(cfg, "baseUrl", "apiKey", "useStream", "imageSizeConfigId", "imageSizeConfigIdsByModel", "imageMaxReferenceImages", "imageMaxReferenceImagesByModel", "convertReferenceImagesToPublicUrl", "videoSubmissionRetryCount", "videoProtocolMode", "videoInputFormat", "videoInputCapabilities", "videoInputCapabilitiesByModel", "modelMappings", "authentication", "credentialScope", "operations", "expectedCurrentVersionId") {
		return invalid("供应商配置字段无效")
	}
	expected, hasExpected := cfg["expectedCurrentVersionId"]
	if in.ID != "" && !hasExpected {
		return invalid("编辑供应商必须提供当前适配版本")
	}
	apiKey, keySupplied := cfg["apiKey"].(string)
	if _, exists := cfg["apiKey"]; exists && !keySupplied {
		return invalid("供应商密钥必须为字符串")
	}
	apiKey = strings.TrimSpace(apiKey)
	if strings.ContainsAny(apiKey, "\r\n") {
		return invalid("供应商密钥无效")
	}
	if expected != nil {
		value, ok := expected.(string)
		if !ok || value == "" || len(value) > 256 {
			return invalid("适配版本无效")
		}
	}
	if keySupplied && (strings.TrimSpace(apiKey) == "" || len(apiKey) > 8192) {
		return invalid("供应商密钥无效")
	}
	poolAdapterDefaults(cfg)
	scope, err := poolCredentialScope(cfg)
	if err != nil {
		return err
	}
	cfg["credentialScope"] = scope
	for _, key := range []string{"imageSizeConfigIdsByModel", "imageMaxReferenceImagesByModel", "videoInputCapabilitiesByModel"} {
		if value, exists := cfg[key]; exists {
			entries, ok := value.(map[string]any)
			if !ok {
				return invalid("供应商模型覆盖无效")
			}
			for id := range entries {
				if !models[strings.ToLower(strings.TrimSpace(id))] {
					return invalid("供应商模型覆盖必须对应支持的模型")
				}
			}
		}
	}
	if err = validatePoolModelOverrides(&in); err != nil {
		return err
	}
	if err = b.validatePoolAdapter(r.Context(), cfg); err != nil {
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
	if err = lockPoolSizeBindings(r.Context(), tx); err != nil {
		return err
	}
	if _, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock_shared(hashtextextended('pool-groups',0))`); err != nil {
		return err
	}
	if _, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "pool-member:"+in.ID); err != nil {
		return err
	}
	var currentID, currentScope, currentKey string
	var revision int
	var currentJSON []byte
	if !creating {
		var memberID string
		if err = tx.QueryRow(r.Context(), `SELECT id FROM image_backend_member WHERE id=$1 FOR UPDATE`, in.ID).Scan(&memberID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return &apiError{404, "NOT_FOUND", "供应商不存在"}
			}
			return err
		}
		err = tx.QueryRow(r.Context(), `SELECT COALESCE(c.current_adapter_version_id,''),COALESCE(c.credential_scope,''),COALESCE(c.api_key,''),COALESCE(v.revision,0),COALESCE(v.configuration,'{}'::json) FROM image_backend_member_api_config c LEFT JOIN image_backend_member_api_adapter_version v ON v.id=c.current_adapter_version_id WHERE c.member_id=$1`, in.ID).Scan(&currentID, &currentScope, &currentKey, &revision, &currentJSON)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if expected != nil && expected != currentID || expected == nil && currentID != "" {
			return &apiError{409, "VERSION_CONFLICT", "供应商配置已更新，请刷新后重试"}
		}
	}
	for _, id := range in.GroupIDs {
		var exists bool
		if err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM image_backend_group WHERE id=$1)`, id).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return invalid("供应商分组不存在")
		}
	}
	if scope != currentScope && currentID != "" {
		var used bool
		if err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM image_backend_member_lease WHERE member_id=$1 AND expires_at>now() UNION ALL SELECT 1 FROM generation WHERE status='pending' AND (api_adapter_member_id=$1 OR metadata->'billingSnapshot'->>'providerMemberId'=$1) UNION ALL SELECT 1 FROM video_generation WHERE api_adapter_member_id=$1 AND status NOT IN ('completed','failed'))`, in.ID).Scan(&used); err != nil {
			return err
		}
		if used {
			return &apiError{409, "CREDENTIAL_SCOPE_CONFLICT", "供应商仍有在途任务，不能修改凭据作用域"}
		}
	}
	if !keySupplied {
		apiKey = currentKey
	}
	if strings.HasSuffix(scope, "|none") {
		apiKey = ""
	} else if apiKey == "" {
		return invalid("供应商认证需要密钥")
	}
	snapshot, err := readPoolSizeSnapshot(r.Context(), tx, extractString(cfg, "imageSizeConfigId"))
	if err != nil {
		return err
	}
	cfg["imageSizeConfig"] = snapshot
	byModel := map[string]any{}
	if ids, ok := cfg["imageSizeConfigIdsByModel"].(map[string]any); ok {
		for model, value := range ids {
			configID, ok := value.(string)
			if !ok || configID == "" {
				return invalid("尺寸配置 ID 无效")
			}
			snapshot, err := readPoolSizeSnapshot(r.Context(), tx, configID)
			if err != nil {
				return err
			}
			byModel[strings.ToLower(strings.TrimSpace(model))] = snapshot
		}
	}
	cfg["imageSizeConfigsByModel"] = byModel
	for _, key := range []string{"apiKey", "expectedCurrentVersionId", "imageSizeConfigId", "imageSizeConfigIdsByModel"} {
		delete(cfg, key)
	}
	var current any
	if len(currentJSON) > 0 {
		_ = json.Unmarshal(currentJSON, &current)
	}
	versionID := currentID
	if currentID == "" || !reflect.DeepEqual(current, cfg) {
		versionID = newRequestID()
		revision++
		if _, err = tx.Exec(r.Context(), `INSERT INTO image_backend_member_api_adapter_version(id,member_id_snapshot,revision,credential_scope,configuration) VALUES($1,$2,$3,$4,$5)`, versionID, in.ID, revision, scope, mustJSON(cfg)); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(r.Context(), `INSERT INTO image_backend_member(id,type,name,supported_model_ids,supported_resolutions_by_model,content_safety_enabled,is_enabled,always_active,failure_cooldown_enabled,priority,concurrency) VALUES($1,'api',$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET name=excluded.name,supported_model_ids=excluded.supported_model_ids,supported_resolutions_by_model=excluded.supported_resolutions_by_model,content_safety_enabled=excluded.content_safety_enabled,is_enabled=excluded.is_enabled,always_active=excluded.always_active,failure_cooldown_enabled=excluded.failure_cooldown_enabled,priority=excluded.priority,concurrency=excluded.concurrency,updated_at=now()`, in.ID, in.Name, mustJSON(in.Models), mustJSON(in.Resolutions), in.Safety, in.Enabled, in.Always, in.Cooldown, in.Priority, in.Concurrency); err != nil {
		return err
	}
	if _, err = tx.Exec(r.Context(), `INSERT INTO image_backend_member_api_config(member_id,api_key,current_adapter_version_id,credential_scope) VALUES($1,NULLIF($2,''),$3,$4) ON CONFLICT(member_id) DO UPDATE SET api_key=excluded.api_key,current_adapter_version_id=excluded.current_adapter_version_id,credential_scope=excluded.credential_scope,updated_at=now()`, in.ID, apiKey, versionID, scope); err != nil {
		return err
	}
	if _, err = tx.Exec(r.Context(), `DELETE FROM image_backend_member_group WHERE member_id=$1`, in.ID); err != nil {
		return err
	}
	sort.Strings(in.GroupIDs)
	for _, id := range in.GroupIDs {
		if _, err = tx.Exec(r.Context(), `INSERT INTO image_backend_member_group(id,member_id,group_id) VALUES($1,$2,$3)`, newRequestID(), in.ID, id); err != nil {
			return err
		}
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"id": in.ID})
	return nil
}
