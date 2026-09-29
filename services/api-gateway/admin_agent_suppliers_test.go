package main

// agent 供应商配置通道的纯逻辑单元测试：补丁合并、字段比较、可编辑配置还原与令牌格式。

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func agentTestBaseWrite() poolMemberWrite {
	return poolMemberWrite{
		ID: "member-1", Type: "api", Name: "supplier", GroupIDs: []string{"g2", "g1"},
		Models: []string{"gpt-image-2"}, Resolutions: map[string][]string{"gpt-image-2": {"1k"}},
		Enabled: true, Priority: 1, Concurrency: 2,
		Config: map[string]any{
			"baseUrl":        "https://provider.example/v1",
			"authentication": map[string]any{"mode": "bearer"},
			"useStream":      false,
			"operations": map[string]any{
				"images.generate": map[string]any{"path": "/gen", "requestScript": "return {};", "responseScript": ""},
			},
		},
	}
}

func assertAPIErrorCode(t *testing.T, err error, status int, code string) {
	t.Helper()
	var apiErr *apiError
	if !errors.As(err, &apiErr) || apiErr.status != status || (code != "" && apiErr.code != code) {
		t.Fatalf("expected %d %s, got %v", status, code, err)
	}
}

func TestApplyAdminAgentPatchRejectsCredentialFields(t *testing.T) {
	base := agentTestBaseWrite()
	for _, key := range []string{"apiKey", "authentication"} {
		_, err := applyAdminAgentPatch(base, adminAgentSupplierPatch{Config: map[string]any{key: "x"}})
		assertAPIErrorCode(t, err, http.StatusForbidden, "CREDENTIAL_CHANGE_FORBIDDEN")
	}
	for _, key := range []string{"credentialScope", "expectedCurrentVersionId", "imageSizeConfig", "unknown"} {
		_, err := applyAdminAgentPatch(base, adminAgentSupplierPatch{Config: map[string]any{key: "x"}})
		assertAPIErrorCode(t, err, http.StatusBadRequest, "INVALID_REQUEST")
	}
}

func TestApplyAdminAgentPatchMergesOperationsAndKeepsBase(t *testing.T) {
	base := agentTestBaseWrite()
	name := "renamed"
	next, err := applyAdminAgentPatch(base, adminAgentSupplierPatch{
		Name: &name,
		Config: map[string]any{
			"baseUrl":   "https://other.example/v2",
			"useStream": nil,
			"operations": map[string]any{
				"images.generate": map[string]any{"responseScript": "return {status:'failed'};", "requestScript": nil},
				"videos.query":    map[string]any{"path": "/v/{task_id}"},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if base.Name != "supplier" || base.Config["baseUrl"] != "https://provider.example/v1" {
		t.Fatal("patch mutated base write")
	}
	ops := next.Config["operations"].(map[string]any)
	gen := ops["images.generate"].(map[string]any)
	if gen["path"] != "/gen" || gen["requestScript"] != "" || gen["responseScript"] != "return {status:'failed'};" {
		t.Fatalf("operation merge wrong: %v", gen)
	}
	if ops["videos.query"].(map[string]any)["path"] != "/v/{task_id}" {
		t.Fatal("new operation not merged")
	}
	if _, exists := next.Config["useStream"]; exists {
		t.Fatal("null config value must reset to default")
	}
	if !reflect.DeepEqual(next.Config["authentication"], base.Config["authentication"]) {
		t.Fatal("authentication must be preserved")
	}
	changed := poolChangedFields(base, next)
	want := []string{
		"config.baseUrl",
		"config.operations.images.generate.requestScript",
		"config.operations.images.generate.responseScript",
		"config.operations.videos.query.path",
		"config.useStream",
		"name",
	}
	if !reflect.DeepEqual(changed, want) {
		t.Fatalf("changed fields = %v", changed)
	}
}

func TestApplyAdminAgentPatchValidatesOperationShape(t *testing.T) {
	base := agentTestBaseWrite()
	cases := []map[string]any{
		{"operations": "x"},
		{"operations": map[string]any{"images.unknown": map[string]any{}}},
		{"operations": map[string]any{"images.generate": "x"}},
		{"operations": map[string]any{"images.generate": map[string]any{"method": "GET"}}},
		{"operations": map[string]any{"images.generate": map[string]any{"path": 1}}},
	}
	for _, cfg := range cases {
		_, err := applyAdminAgentPatch(base, adminAgentSupplierPatch{Config: cfg})
		assertAPIErrorCode(t, err, http.StatusBadRequest, "INVALID_REQUEST")
	}
}

func TestPoolChangedFieldsIgnoresGroupOrder(t *testing.T) {
	base := agentTestBaseWrite()
	next := cloneMemberWrite(base)
	next.GroupIDs = []string{"g1", "g2"}
	if changed := poolChangedFields(base, next); len(changed) != 0 {
		t.Fatalf("group order must not count as change: %v", changed)
	}
}

func TestEditableAdapterConfigRestoresSizeIDsAndDropsDerived(t *testing.T) {
	snapshot := map[string]any{
		"baseUrl":                 "https://provider.example",
		"apiKey":                  "secret",
		"hasApiKey":               true,
		"credentialScope":         "https://provider.example|bearer",
		"currentAdapterVersion":   map[string]any{"id": "v1"},
		"imageSizeConfig":         map[string]any{"id": "size-1", "name": "n", "mappings": []any{}},
		"imageSizeConfigsByModel": map[string]any{"gpt-image-2": map[string]any{"id": "size-2"}},
	}
	out := editableAdapterConfig(snapshot)
	for _, key := range []string{"apiKey", "hasApiKey", "credentialScope", "currentAdapterVersion", "imageSizeConfig", "imageSizeConfigsByModel"} {
		if _, exists := out[key]; exists {
			t.Fatalf("editable config must not contain %s", key)
		}
	}
	if out["imageSizeConfigId"] != "size-1" || out["imageSizeConfigIdsByModel"].(map[string]any)["gpt-image-2"] != "size-2" {
		t.Fatalf("size ids not restored: %v", out)
	}
	if _, ok := out["operations"].(map[string]any)["videos.query"]; !ok {
		t.Fatal("defaults not applied")
	}
	if snapshot["apiKey"] != "secret" {
		t.Fatal("snapshot mutated")
	}
}

func TestAdminAgentTokenFormat(t *testing.T) {
	valid := adminAgentTokenPrefix + strings.Repeat("ab", adminAgentTokenRandomBytes)
	if !validAdminAgentTokenFormat(valid) {
		t.Fatal("valid token rejected")
	}
	for _, token := range []string{"", "fmat_", valid + "a", "mcp_" + strings.Repeat("ab", adminAgentTokenRandomBytes), adminAgentTokenPrefix + strings.Repeat("zz", adminAgentTokenRandomBytes)} {
		if validAdminAgentTokenFormat(token) {
			t.Fatalf("invalid token accepted: %q", token)
		}
	}
	if hashAdminAgentToken(valid) == valid || len(hashAdminAgentToken(valid)) != 64 {
		t.Fatal("token must be stored as sha256 hex")
	}
}

func TestAuthenticateAdminAgentRejectsMissingOrMalformedTokenBeforeDatabase(t *testing.T) {
	b := &backend{}
	for _, header := range []string{"", "Bearer ", "Basic abc", "Bearer mcp_abc", "Bearer fmat_nothex"} {
		r := httptest.NewRequest("GET", "/api/admin-agent/v1/me", nil)
		if header != "" {
			r.Header.Set("Authorization", header)
		}
		_, err := b.authenticateAdminAgent(r)
		assertAPIErrorCode(t, err, http.StatusUnauthorized, "UNAUTHORIZED")
	}
}

func TestNormalizeAdminAgentScopes(t *testing.T) {
	got, err := normalizeAdminAgentScopes([]string{" suppliers:write ", "suppliers:write"})
	if err != nil || !reflect.DeepEqual(got, []string{adminAgentScopeSuppliersRead, adminAgentScopeSuppliersWrite}) {
		t.Fatalf("write must dedupe and imply read in registry order: %v %v", got, err)
	}
	got, err = normalizeAdminAgentScopes([]string{"suppliers:read"})
	if err != nil || !reflect.DeepEqual(got, []string{adminAgentScopeSuppliersRead}) {
		t.Fatalf("read scope wrong: %v %v", got, err)
	}
	for _, input := range [][]string{nil, {}, {"suppliers:admin"}, {""}, {"suppliers:read", "users:write"}} {
		_, err := normalizeAdminAgentScopes(input)
		assertAPIErrorCode(t, err, http.StatusBadRequest, "INVALID_REQUEST")
	}
}

func TestAdminAgentScopeRegistryIsConsistent(t *testing.T) {
	seen := map[string]bool{}
	for _, scope := range adminAgentScopeRegistry {
		if seen[scope.ID] || !strings.Contains(scope.ID, ":") || scope.Label == "" || scope.Description == "" || scope.Requires == nil || scope.Risky != (scope.RiskNote != "") {
			t.Fatalf("invalid scope definition: %+v", scope)
		}
		for _, required := range scope.Requires {
			if !seen[required] {
				t.Fatalf("scope %s requires unknown or later scope %s", scope.ID, required)
			}
		}
		seen[scope.ID] = true
	}
}

func TestAdminAgentPrincipalHasScope(t *testing.T) {
	p := &adminAgentPrincipal{Scopes: []string{adminAgentScopeSuppliersRead}}
	if !p.hasScope(adminAgentScopeSuppliersRead) || p.hasScope(adminAgentScopeSuppliersWrite) {
		t.Fatal("scope check wrong")
	}
}
