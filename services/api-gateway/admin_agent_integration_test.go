//go:build integration

package main

// agent 供应商配置通道的端到端集成测试：令牌签发与撤销、Bearer 鉴权、
// 禁止修改认证与密钥、乐观锁、预演、增量修改、版本历史、回滚与审计。

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func agentRequest(t *testing.T, b *backend, method, path, token string, body any) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	raw := ""
	if body != nil {
		raw = mustJSON(body)
	}
	r := httptest.NewRequest(method, "http://localhost:3000"+path, strings.NewReader(raw))
	requestIP := newRequestID()
	r.RemoteAddr = fmt.Sprintf("[fd00:%s:%s:%s::1]:1234", requestIP[:4], requestIP[4:8], requestIP[8:12])
	r.Header.Set("Content-Type", "application/json")
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	b.handler().ServeHTTP(w, r)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	// 错误响应形如 {"error":{"code":...}}，提升 code 便于断言。
	if apiErr, ok := out["error"].(map[string]any); ok {
		out["code"] = apiErr["code"]
	}
	return w, out
}

func agentTestAdmin(t *testing.T, b *backend) (string, *http.Cookie) {
	t.Helper()
	id, email := seedAuthUser(t, b)
	if _, err := b.db.Exec(context.Background(), `UPDATE "user" SET role='admin' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	return id, signInTestUser(t, b, email)
}

func agentTestIssueToken(t *testing.T, b *backend, cookie *http.Cookie, canWrite bool) (string, string) {
	t.Helper()
	w := authRequest(t, b, "POST", "/api/admin/agent-tokens", mustJSON(map[string]any{"name": "agent", "canWrite": canWrite, "expiresInDays": 7}), cookie)
	if w.Code != 200 {
		t.Fatalf("issue token failed: %d %s", w.Code, w.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	token, _ := out["token"].(string)
	if !strings.HasPrefix(token, adminAgentTokenPrefix) {
		t.Fatalf("token missing: %v", out)
	}
	var stored string
	if err := b.db.QueryRow(context.Background(), `SELECT token_hash FROM admin_agent_token WHERE id=$1`, out["id"]).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored == token || stored != hashAdminAgentToken(token) {
		t.Fatal("token must be stored hashed")
	}
	return out["id"].(string), token
}

func agentTestCurrent(t *testing.T, b *backend, memberID string) (string, int, string, map[string]any) {
	t.Helper()
	var version, key string
	var revision int
	var raw []byte
	if err := b.db.QueryRow(context.Background(), `SELECT c.current_adapter_version_id,COALESCE(c.api_key,''),v.revision,v.configuration FROM image_backend_member_api_config c JOIN image_backend_member_api_adapter_version v ON v.id=c.current_adapter_version_id WHERE c.member_id=$1`, memberID).Scan(&version, &key, &revision, &raw); err != nil {
		t.Fatal(err)
	}
	cfg := map[string]any{}
	_ = json.Unmarshal(raw, &cfg)
	return version, revision, key, cfg
}

func TestAdminAgentSupplierLifecycle(t *testing.T) {
	b := integrationBackend(t)
	ctx := context.Background()
	adminID, cookie := agentTestAdmin(t, b)
	group := poolTestGroup(t, b)
	memberID, err := poolTestSaveMember(t, b, poolTestMember(group))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = b.db.Exec(ctx, `DELETE FROM admin_audit_log WHERE admin_user_id=$1`, adminID) })
	writeID, writeToken := agentTestIssueToken(t, b, cookie, true)
	_, readToken := agentTestIssueToken(t, b, cookie, false)

	if w, _ := agentRequest(t, b, "GET", "/api/admin-agent/v1/me", "", nil); w.Code != 401 {
		t.Fatalf("missing token must be rejected: %d", w.Code)
	}
	if w, _ := agentRequest(t, b, "GET", "/api/admin-agent/v1/me", adminAgentTokenPrefix+strings.Repeat("0", 64), nil); w.Code != 401 {
		t.Fatalf("unknown token must be rejected: %d", w.Code)
	}
	if w, out := agentRequest(t, b, "GET", "/api/admin-agent/v1/me", writeToken, nil); w.Code != 200 || out["canWrite"] != true {
		t.Fatalf("me failed: %d %v", w.Code, out)
	}

	w, detail := agentRequest(t, b, "GET", "/api/admin-agent/v1/suppliers/"+memberID, readToken, nil)
	if w.Code != 200 || strings.Contains(w.Body.String(), "old-secret") {
		t.Fatalf("detail failed or leaked secret: %d %s", w.Code, w.Body.String())
	}
	expected := detail["expectedCurrentVersionId"].(string)
	originalVersion, originalRevision, _, _ := agentTestCurrent(t, b, memberID)
	if expected != originalVersion || originalRevision != 1 {
		t.Fatalf("detail version mismatch %s %s", expected, originalVersion)
	}
	if w, list := agentRequest(t, b, "GET", "/api/admin-agent/v1/suppliers", readToken, nil); w.Code != 200 || strings.Contains(w.Body.String(), "old-secret") || len(list["suppliers"].([]any)) == 0 {
		t.Fatalf("list failed: %d %s", w.Code, w.Body.String())
	}

	patchPath := "/api/admin-agent/v1/suppliers/" + memberID
	pathPatch := map[string]any{"expectedCurrentVersionId": expected, "config": map[string]any{"operations": map[string]any{"images.generate": map[string]any{"path": "/custom/generate"}}}}
	if w, out := agentRequest(t, b, "PATCH", patchPath, readToken, pathPatch); w.Code != 403 || out["code"] != "READ_ONLY_TOKEN" {
		t.Fatalf("read-only token wrote: %d %v", w.Code, out)
	}
	for _, forbiddenCfg := range []map[string]any{{"apiKey": "stolen"}, {"authentication": map[string]any{"mode": "none"}}} {
		w, out := agentRequest(t, b, "PATCH", patchPath, writeToken, map[string]any{"expectedCurrentVersionId": expected, "config": forbiddenCfg})
		if w.Code != 403 || out["code"] != "CREDENTIAL_CHANGE_FORBIDDEN" {
			t.Fatalf("credential change accepted: %d %v", w.Code, out)
		}
	}
	if w, _ := agentRequest(t, b, "PATCH", patchPath, writeToken, map[string]any{"expectedCurrentVersionId": expected, "type": "api"}); w.Code != 400 {
		t.Fatalf("unknown top-level field accepted: %d", w.Code)
	}
	if w, out := agentRequest(t, b, "PATCH", patchPath, writeToken, map[string]any{"expectedCurrentVersionId": "stale", "name": "x"}); w.Code != 409 || out["code"] != "VERSION_CONFLICT" {
		t.Fatalf("stale version accepted: %d %v", w.Code, out)
	}

	dry := map[string]any{"expectedCurrentVersionId": expected, "dryRun": true, "config": pathPatch["config"]}
	if w, out := agentRequest(t, b, "PATCH", patchPath, writeToken, dry); w.Code != 200 || out["dryRun"] != true || out["versionCreated"] != true {
		t.Fatalf("dry run failed: %d %v", w.Code, out)
	}
	if version, _, _, _ := agentTestCurrent(t, b, memberID); version != originalVersion {
		t.Fatal("dry run persisted a version")
	}

	update := map[string]any{"expectedCurrentVersionId": expected, "reason": "switch gateway", "config": map[string]any{
		"baseUrl":    "https://provider.example/v2",
		"operations": map[string]any{"images.generate": map[string]any{"path": "/custom/generate"}},
	}}
	w, out := agentRequest(t, b, "PATCH", patchPath, writeToken, update)
	if w.Code != 200 || out["versionCreated"] != true {
		t.Fatalf("update failed: %d %s", w.Code, w.Body.String())
	}
	version2, revision2, key, cfg := agentTestCurrent(t, b, memberID)
	ops := cfg["operations"].(map[string]any)
	if revision2 != 2 || key != "old-secret" || cfg["baseUrl"] != "https://provider.example/v2" || ops["images.generate"].(map[string]any)["path"] != "/custom/generate" {
		t.Fatalf("update not applied: rev=%d cfg=%v", revision2, cfg)
	}
	if auth := cfg["authentication"].(map[string]any); auth["mode"] != "bearer" {
		t.Fatal("authentication changed")
	}
	var auditBefore, auditAfter, auditMeta string
	if err := b.db.QueryRow(ctx, `SELECT before::text,after::text,metadata::text FROM admin_audit_log WHERE admin_user_id=$1 AND action='admin_agent.supplier.update'`, adminID).Scan(&auditBefore, &auditAfter, &auditMeta); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(auditMeta, writeID) || !strings.Contains(auditMeta, "config.baseUrl") || strings.Contains(auditBefore+auditAfter+auditMeta, "/custom/generate") || strings.Contains(auditBefore+auditAfter+auditMeta, "old-secret") {
		t.Fatalf("audit wrong: %s %s %s", auditBefore, auditAfter, auditMeta)
	}

	w, versions := agentRequest(t, b, "GET", patchPath+"/versions", readToken, nil)
	items, _ := versions["items"].([]any)
	if w.Code != 200 || len(items) != 2 || items[0].(map[string]any)["isCurrent"] != true || items[0].(map[string]any)["revision"].(float64) != 2 {
		t.Fatalf("versions wrong: %d %s", w.Code, w.Body.String())
	}
	if w, one := agentRequest(t, b, "GET", patchPath+"/versions/"+originalVersion, readToken, nil); w.Code != 200 || one["revision"].(float64) != 1 || strings.Contains(w.Body.String(), "old-secret") {
		t.Fatalf("version detail wrong: %d %s", w.Code, w.Body.String())
	}

	rollback := map[string]any{"versionId": originalVersion, "expectedCurrentVersionId": originalVersion, "reason": "revert"}
	if w, _ := agentRequest(t, b, "POST", patchPath+"/rollback", writeToken, rollback); w.Code != 409 {
		t.Fatalf("rollback with stale version accepted: %d", w.Code)
	}
	rollback["expectedCurrentVersionId"] = version2
	if w, out := agentRequest(t, b, "POST", patchPath+"/rollback", readToken, rollback); w.Code != 403 {
		t.Fatalf("read-only rollback accepted: %d %v", w.Code, out)
	}
	if w, out := agentRequest(t, b, "POST", patchPath+"/rollback", writeToken, rollback); w.Code != 200 || out["changed"] != true {
		t.Fatalf("rollback failed: %d %s", w.Code, w.Body.String())
	}
	version3, revision3, key, cfg := agentTestCurrent(t, b, memberID)
	ops = cfg["operations"].(map[string]any)
	if version3 == originalVersion || revision3 != 3 || key != "old-secret" || cfg["baseUrl"] != "https://provider.example/v1" || ops["images.generate"].(map[string]any)["path"] != "" {
		t.Fatalf("rollback not applied as new revision: rev=%d cfg=%v", revision3, cfg)
	}

	// 会话接口：列表只显示本人令牌，撤销后令牌立即失效。
	lw := authRequest(t, b, "GET", "/api/admin/agent-tokens", "", cookie)
	if lw.Code != 200 || strings.Contains(lw.Body.String(), writeToken) || strings.Contains(lw.Body.String(), "token_hash") {
		t.Fatalf("token list leaked plaintext: %d %s", lw.Code, lw.Body.String())
	}
	if rw := authRequest(t, b, "POST", "/api/admin/agent-tokens/"+writeID+"/revoke", "{}", cookie); rw.Code != 200 {
		t.Fatalf("revoke failed: %d %s", rw.Code, rw.Body.String())
	}
	if w, _ := agentRequest(t, b, "GET", "/api/admin-agent/v1/me", writeToken, nil); w.Code != 401 {
		t.Fatalf("revoked token accepted: %d", w.Code)
	}
	// 签发人失去管理员角色后，剩余令牌也立即失效。
	if _, err := b.db.Exec(ctx, `UPDATE "user" SET role='user' WHERE id=$1`, adminID); err != nil {
		t.Fatal(err)
	}
	if w, _ := agentRequest(t, b, "GET", "/api/admin-agent/v1/me", readToken, nil); w.Code != 403 {
		t.Fatalf("demoted issuer token accepted: %d", w.Code)
	}
}

func TestAdminAgentTokenIssueRules(t *testing.T) {
	b := integrationBackend(t)
	ctx := context.Background()
	adminID, cookie := agentTestAdmin(t, b)
	t.Cleanup(func() { _, _ = b.db.Exec(ctx, `DELETE FROM admin_audit_log WHERE admin_user_id=$1`, adminID) })
	for _, body := range []map[string]any{{"name": ""}, {"name": "x", "expiresInDays": 0}, {"name": "x", "expiresInDays": 91}, {"name": "x", "extra": true}} {
		if w := authRequest(t, b, "POST", "/api/admin/agent-tokens", mustJSON(body), cookie); w.Code != 400 {
			t.Fatalf("invalid token input accepted: %v %d", body, w.Code)
		}
	}
	for range adminAgentTokenMaxActive {
		agentTestIssueToken(t, b, cookie, false)
	}
	if w := authRequest(t, b, "POST", "/api/admin/agent-tokens", mustJSON(map[string]any{"name": "over"}), cookie); w.Code != 409 {
		t.Fatalf("token limit not enforced: %d", w.Code)
	}
	// 其他普通管理员不能撤销他人令牌。
	var tokenID string
	if err := b.db.QueryRow(ctx, `SELECT id FROM admin_agent_token WHERE created_by_user_id=$1 LIMIT 1`, adminID).Scan(&tokenID); err != nil {
		t.Fatal(err)
	}
	_, otherCookie := agentTestAdmin(t, b)
	if w := authRequest(t, b, "POST", "/api/admin/agent-tokens/"+tokenID+"/revoke", "{}", otherCookie); w.Code != 403 {
		t.Fatalf("foreign revoke accepted: %d", w.Code)
	}
	var created int
	if err := b.db.QueryRow(ctx, `SELECT count(*) FROM admin_audit_log WHERE admin_user_id=$1 AND action='admin_agent_token.create'`, adminID).Scan(&created); err != nil {
		t.Fatal(err)
	}
	if created != adminAgentTokenMaxActive {
		t.Fatalf("token creation not audited: %d", created)
	}
}

func TestPoolAdapterSessionRollbackPreservesCredentials(t *testing.T) {
	b := integrationBackend(t)
	ctx := context.Background()
	adminID, cookie := agentTestAdmin(t, b)
	t.Cleanup(func() { _, _ = b.db.Exec(ctx, `DELETE FROM admin_audit_log WHERE admin_user_id=$1`, adminID) })
	group := poolTestGroup(t, b)
	in := poolTestMember(group)
	memberID, err := poolTestSaveMember(t, b, in)
	if err != nil {
		t.Fatal(err)
	}
	v1, _, _, _ := agentTestCurrent(t, b, memberID)
	in["id"] = memberID
	cfg := in["config"].(map[string]any)
	cfg["expectedCurrentVersionId"] = v1
	cfg["baseUrl"] = "https://provider.example/v9"
	cfg["authentication"] = map[string]any{"mode": "raw_authorization"}
	cfg["apiKey"] = "new-secret"
	if _, err := poolTestSaveMember(t, b, in); err != nil {
		t.Fatal(err)
	}
	v2, _, _, _ := agentTestCurrent(t, b, memberID)
	w := authRequest(t, b, "GET", "/api/admin/image-backend/members/"+memberID+"/adapter-versions", "", cookie)
	if w.Code != 200 || !strings.Contains(w.Body.String(), v1) {
		t.Fatalf("session versions failed: %d %s", w.Code, w.Body.String())
	}
	w = authRequest(t, b, "POST", "/api/admin/image-backend/members/"+memberID+"/adapter-rollback", mustJSON(map[string]any{"versionId": v1, "expectedCurrentVersionId": v2, "reason": "revert"}), cookie)
	if w.Code != 200 {
		t.Fatalf("session rollback failed: %d %s", w.Code, w.Body.String())
	}
	_, revision, key, current := agentTestCurrent(t, b, memberID)
	auth := current["authentication"].(map[string]any)
	if revision != 3 || key != "new-secret" || auth["mode"] != "raw_authorization" || current["baseUrl"] != "https://provider.example/v1" {
		t.Fatalf("rollback must restore adapter but keep credentials: rev=%d key=%q cfg=%v", revision, key, current)
	}
	var count int
	if err := b.db.QueryRow(ctx, `SELECT count(*) FROM admin_audit_log WHERE admin_user_id=$1 AND action='pool.member.adapter_rollback'`, adminID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("rollback not audited: %d %v", count, err)
	}
}
