package main

// 管理员 agent 令牌的授权范围（scope）注册表与校验。
//
// agent 令牌是全局管理员凭据，具体能力由签发时勾选的 scope 决定。新的管理功能接入
// agent 时，在 adminAgentScopeRegistry 追加 scope，并在对应接口调用
// requireAdminAgentScope。注册表是 scope 清单的唯一来源：签发接口据此校验输入，
// 令牌列表和 /me 据此返回说明，前端和 skill 不另行硬编码。

import (
	"net/http"
	"slices"
	"strings"
)

const (
	adminAgentScopeSuppliersRead  = "suppliers:read"
	adminAgentScopeSuppliersWrite = "suppliers:write"
	adminAgentMaxScopes           = 32
)

// adminAgentScope 描述一个可授予 agent 令牌的能力。
type adminAgentScope struct {
	// ID 是 scope 标识，格式为 <资源>:<动作>。
	ID string `json:"id"`
	// Group 是界面分组名称。
	Group string `json:"group"`
	// Label 是简短中文名称。
	Label string `json:"label"`
	// Description 说明该 scope 允许的操作。
	Description string `json:"description"`
	// Risky 标记高风险能力，签发界面需要额外提示。
	Risky bool `json:"risky"`
	// Requires 是授予该 scope 时自动附带的前置 scope。
	Requires []string `json:"requires"`
}

// adminAgentScopeRegistry 按展示顺序列出全部可授予的 scope。
var adminAgentScopeRegistry = []adminAgentScope{
	{
		ID: adminAgentScopeSuppliersRead, Group: "供应商", Label: "读取供应商配置",
		Description: "读取 API 供应商的脱敏配置、适配版本历史和目录，并用合成样例在线测试请求/响应脚本。",
		Requires:    []string{},
	},
	{
		ID: adminAgentScopeSuppliersWrite, Group: "供应商", Label: "修改供应商配置",
		Description: "增量修改和回滚 API 供应商配置（含 baseUrl、路径、模型映射和请求/响应脚本），不能修改认证方式和密钥。",
		Risky:       true, Requires: []string{adminAgentScopeSuppliersRead},
	},
}

// adminAgentScopeByID 按 ID 查找已注册的 scope。
func adminAgentScopeByID(id string) (adminAgentScope, bool) {
	for _, scope := range adminAgentScopeRegistry {
		if scope.ID == id {
			return scope, true
		}
	}
	return adminAgentScope{}, false
}

// normalizeAdminAgentScopes 校验并规范化签发输入：去空白、去重、补齐前置 scope，
// 并按注册表顺序排序。未知 scope 或结果为空时返回参数错误。
func normalizeAdminAgentScopes(input []string) ([]string, error) {
	if len(input) == 0 {
		return nil, invalid("至少需要选择一个授权范围")
	}
	if len(input) > adminAgentMaxScopes {
		return nil, invalid("授权范围数量过多")
	}
	selected := map[string]bool{}
	var pending []string
	for _, raw := range input {
		id := strings.TrimSpace(raw)
		if _, ok := adminAgentScopeByID(id); !ok {
			return nil, invalid("未知的授权范围：" + truncateRunes(id, 64))
		}
		pending = append(pending, id)
	}
	for len(pending) > 0 {
		id := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		if selected[id] {
			continue
		}
		selected[id] = true
		scope, _ := adminAgentScopeByID(id)
		pending = append(pending, scope.Requires...)
	}
	out := make([]string, 0, len(selected))
	for _, scope := range adminAgentScopeRegistry {
		if selected[scope.ID] {
			out = append(out, scope.ID)
		}
	}
	return out, nil
}

// truncateRunes 按字符截断字符串，用于在错误信息中安全回显用户输入。
func truncateRunes(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}

// hasScope 判断调用方令牌是否具有指定 scope。
func (p *adminAgentPrincipal) hasScope(scope string) bool {
	return slices.Contains(p.Scopes, scope)
}

// requireAdminAgentScope 校验 agent 令牌并要求其具有指定 scope。
// 缺少 scope 时返回 403 INSUFFICIENT_SCOPE，错误信息中带出所需 scope 便于 agent 提示管理员。
func (b *backend) requireAdminAgentScope(r *http.Request, scope string) (*adminAgentPrincipal, error) {
	principal, err := b.authenticateAdminAgent(r)
	if err != nil {
		return nil, err
	}
	if !principal.hasScope(scope) {
		return nil, &apiError{http.StatusForbidden, "INSUFFICIENT_SCOPE", "当前 agent 令牌缺少授权范围 " + scope}
	}
	return principal, nil
}

// nonNilStrings 把 nil 切片转成空切片，保证 JSON 输出为 [] 而不是 null。
func nonNilStrings(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}
