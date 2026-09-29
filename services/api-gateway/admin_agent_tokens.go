package main

// 管理员 agent 令牌：签发、列出、撤销与请求鉴权。
//
// 外部 agent（如 Claude Code、Codex）使用 Bearer 令牌调用 /api/admin-agent/v1/*。
// 令牌是全局管理员凭据，不绑定具体功能；能力由签发时勾选的 scope 决定，见
// admin_agent_scopes.go。明文令牌只在签发时返回一次，数据库仅保存 SHA-256 哈希。令牌继承签发管理员
// 的身份：签发人失去 admin/super_admin 角色或被封禁后，令牌立即失效。

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	adminAgentTokenPrefix        = "fmat_"
	adminAgentTokenRandomBytes   = 32
	adminAgentTokenMaxActive     = 10
	adminAgentTokenDefaultDays   = 30
	adminAgentTokenMaxDays       = 90
	adminAgentTokenTouchInterval = time.Minute
)

// adminAgentPrincipal 是通过 agent 令牌鉴权后的调用方身份。
type adminAgentPrincipal struct {
	TokenID   string
	TokenName string
	UserID    string
	Role      string
	Scopes    []string
}

// registerAdminAgentTokenRoutes 注册后台会话使用的令牌管理接口。
func (b *backend) registerAdminAgentTokenRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/admin/agent-tokens", b.endpoint(b.handleListAdminAgentTokens))
	mux.HandleFunc("POST /api/admin/agent-tokens", b.endpoint(b.handleCreateAdminAgentToken))
	mux.HandleFunc("POST /api/admin/agent-tokens/{id}/revoke", b.endpoint(b.handleRevokeAdminAgentToken))
}

// hashAdminAgentToken 计算明文令牌的 SHA-256 十六进制摘要。
func hashAdminAgentToken(plaintext string) string {
	sum := sha256.Sum256([]byte(plaintext))
	return hex.EncodeToString(sum[:])
}

// validAdminAgentTokenFormat 检查明文令牌格式，避免无意义的数据库查询。
func validAdminAgentTokenFormat(plaintext string) bool {
	body, ok := strings.CutPrefix(plaintext, adminAgentTokenPrefix)
	if !ok || len(body) != adminAgentTokenRandomBytes*2 {
		return false
	}
	_, err := hex.DecodeString(body)
	return err == nil
}

// handleListAdminAgentTokens 列出令牌：super_admin 可见全部，admin 仅见自己签发的。
func (b *backend) handleListAdminAgentTokens(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireAdmin(r, false)
	if err != nil {
		return err
	}
	all := s.User.Role == "super_admin"
	rows, err := b.db.Query(r.Context(), `SELECT t.id,t.name,t.token_prefix,t.last_four,t.scopes,t.created_by_user_id,COALESCE(u.name,''),COALESCE(u.email,''),t.expires_at,t.last_used_at,t.revoked_at,t.created_at FROM admin_agent_token t LEFT JOIN "user" u ON u.id=t.created_by_user_id WHERE $1 OR t.created_by_user_id=$2 ORDER BY t.created_at DESC LIMIT 200`, all, s.User.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	now := time.Now()
	tokens := make([]map[string]any, 0)
	for rows.Next() {
		var id, name, prefix, lastFour, creatorID, creatorName, creatorEmail string
		var scopes []string
		var expires, created time.Time
		var lastUsed, revoked *time.Time
		if err := rows.Scan(&id, &name, &prefix, &lastFour, &scopes, &creatorID, &creatorName, &creatorEmail, &expires, &lastUsed, &revoked, &created); err != nil {
			return err
		}
		status := "active"
		if revoked != nil {
			status = "revoked"
		} else if !expires.After(now) {
			status = "expired"
		}
		tokens = append(tokens, map[string]any{
			"id": id, "name": name, "tokenPrefix": prefix, "lastFour": lastFour, "scopes": nonNilStrings(scopes),
			"createdBy": map[string]any{"id": creatorID, "name": creatorName, "email": creatorEmail},
			"isOwn":     creatorID == s.User.ID, "status": status,
			"expiresAt": expires.UTC().Format(time.RFC3339Nano), "lastUsedAt": timeValue(lastUsed),
			"revokedAt": timeValue(revoked), "createdAt": created.UTC().Format(time.RFC3339Nano),
		})
	}
	if err := rows.Err(); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"tokens": tokens, "availableScopes": adminAgentScopeRegistry})
	return nil
}

// handleCreateAdminAgentToken 签发新令牌，明文只在本次响应中返回。
func (b *backend) handleCreateAdminAgentToken(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireAdmin(r, false)
	if err != nil {
		return err
	}
	var in struct {
		Name          string   `json:"name"`
		Scopes        []string `json:"scopes"`
		ExpiresInDays *int     `json:"expiresInDays"`
	}
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	name := strings.TrimSpace(in.Name)
	if name == "" || len([]rune(name)) > 120 || strings.ContainsAny(name, "\r\n") {
		return invalid("令牌名称必须为 1-120 个字符")
	}
	days := adminAgentTokenDefaultDays
	if in.ExpiresInDays != nil {
		days = *in.ExpiresInDays
	}
	if days < 1 || days > adminAgentTokenMaxDays {
		return invalid("令牌有效期必须为 1-" + strconv.Itoa(adminAgentTokenMaxDays) + " 天")
	}
	scopes, err := normalizeAdminAgentScopes(in.Scopes)
	if err != nil {
		return err
	}
	randomPart := make([]byte, adminAgentTokenRandomBytes)
	if _, err := rand.Read(randomPart); err != nil {
		return err
	}
	plaintext := adminAgentTokenPrefix + hex.EncodeToString(randomPart)
	lastFour := plaintext[len(plaintext)-4:]
	id := newRequestID()
	tx, err := b.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer rollback(tx)
	if _, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "admin-agent-token:"+s.User.ID); err != nil {
		return err
	}
	var active int
	if err = tx.QueryRow(r.Context(), `SELECT count(*) FROM admin_agent_token WHERE created_by_user_id=$1 AND revoked_at IS NULL AND expires_at>now()`, s.User.ID).Scan(&active); err != nil {
		return err
	}
	if active >= adminAgentTokenMaxActive {
		return &apiError{http.StatusConflict, "TOKEN_LIMIT_REACHED", "有效令牌数量已达上限，请先撤销不再使用的令牌"}
	}
	var expires, created time.Time
	if err = tx.QueryRow(r.Context(), `INSERT INTO admin_agent_token(id,name,token_prefix,token_hash,last_four,scopes,created_by_user_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+make_interval(days=>$8)) RETURNING expires_at,created_at`, id, name, adminAgentTokenPrefix, hashAdminAgentToken(plaintext), lastFour, scopes, s.User.ID, days).Scan(&expires, &created); err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	b.auditAdminWithMetadata(r.Context(), s.User.ID, "admin_agent_token.create", "", nil,
		map[string]any{"tokenId": id, "name": name, "scopes": scopes, "expiresAt": expires.UTC().Format(time.RFC3339Nano)},
		map[string]any{"tokenId": id, "lastFour": lastFour})
	writeJSON(w, http.StatusOK, map[string]any{
		"id": id, "token": plaintext, "name": name, "tokenPrefix": adminAgentTokenPrefix, "lastFour": lastFour,
		"scopes": scopes, "expiresAt": expires.UTC().Format(time.RFC3339Nano), "createdAt": created.UTC().Format(time.RFC3339Nano),
	})
	return nil
}

// handleRevokeAdminAgentToken 撤销令牌：admin 只能撤销自己签发的，super_admin 可撤销任意令牌。
func (b *backend) handleRevokeAdminAgentToken(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireAdmin(r, false)
	if err != nil {
		return err
	}
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" || len(id) > 128 {
		return invalid("令牌 ID 无效")
	}
	var creatorID string
	var revoked *time.Time
	if err := b.db.QueryRow(r.Context(), `SELECT created_by_user_id,revoked_at FROM admin_agent_token WHERE id=$1`, id).Scan(&creatorID, &revoked); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return &apiError{http.StatusNotFound, "NOT_FOUND", "令牌不存在"}
		}
		return err
	}
	if creatorID != s.User.ID && s.User.Role != "super_admin" {
		return forbidden()
	}
	tag, err := b.db.Exec(r.Context(), `UPDATE admin_agent_token SET revoked_at=now(),revoked_by_user_id=$2 WHERE id=$1 AND revoked_at IS NULL`, id, s.User.ID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() > 0 {
		b.auditAdminWithMetadata(r.Context(), s.User.ID, "admin_agent_token.revoke", "", map[string]any{"tokenId": id}, map[string]any{"tokenId": id, "revoked": true}, map[string]any{"tokenId": id, "createdByUserId": creatorID})
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "revoked": true})
	return nil
}

// adminAgentUnauthorized 是令牌缺失、格式错误、过期或撤销时的统一错误。
func adminAgentUnauthorized() error {
	return &apiError{http.StatusUnauthorized, "UNAUTHORIZED", "agent 令牌无效、已过期或已撤销"}
}

// authenticateAdminAgent 校验 Bearer agent 令牌并返回调用方身份。
// 先按来源 IP 限流再查库，令牌通过后再按令牌限流。
func (b *backend) authenticateAdminAgent(r *http.Request) (*adminAgentPrincipal, error) {
	if err := b.limitAdminAgent(r.Context(), "admin-agent-ip:"+backendRateClientIP(r)); err != nil {
		return nil, err
	}
	header := strings.TrimSpace(r.Header.Get("Authorization"))
	plaintext, ok := strings.CutPrefix(header, "Bearer ")
	plaintext = strings.TrimSpace(plaintext)
	if !ok || !validAdminAgentTokenFormat(plaintext) {
		return nil, adminAgentUnauthorized()
	}
	var principal adminAgentPrincipal
	var banned bool
	var lastUsed *time.Time
	err := b.db.QueryRow(r.Context(), `SELECT t.id,t.name,t.scopes,t.last_used_at,u.id,u.role,u.banned FROM admin_agent_token t JOIN "user" u ON u.id=t.created_by_user_id WHERE t.token_hash=$1 AND t.revoked_at IS NULL AND t.expires_at>now()`, hashAdminAgentToken(plaintext)).Scan(&principal.TokenID, &principal.TokenName, &principal.Scopes, &lastUsed, &principal.UserID, &principal.Role, &banned)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, adminAgentUnauthorized()
	}
	if err != nil {
		return nil, err
	}
	if banned || (principal.Role != "admin" && principal.Role != "super_admin") {
		return nil, &apiError{http.StatusForbidden, "FORBIDDEN", "令牌签发人已不再具有管理员权限"}
	}
	if err := b.limitAdminAgent(r.Context(), "admin-agent-token:"+principal.TokenID); err != nil {
		return nil, err
	}
	if lastUsed == nil || time.Since(*lastUsed) >= adminAgentTokenTouchInterval {
		_, _ = b.db.Exec(r.Context(), `UPDATE admin_agent_token SET last_used_at=now() WHERE id=$1`, principal.TokenID)
	}
	return &principal, nil
}

// limitAdminAgent 使用全局限流档位约束 agent 请求频率。
func (b *backend) limitAdminAgent(ctx context.Context, identifier string) error {
	result, err := b.checkBackendRateLimit(ctx, identifier, "global")
	if err != nil {
		return &apiError{http.StatusServiceUnavailable, "NOT_READY", "请求限流服务暂不可用"}
	}
	if !result.Success {
		return &apiError{http.StatusTooManyRequests, "RATE_LIMITED", "请求过于频繁，请稍后再试"}
	}
	return nil
}
