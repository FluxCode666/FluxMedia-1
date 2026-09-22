package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
	"time"
)

const mcpKeyPrefix = "mcp_"

// handleMCPKeys serves the browser-facing MCP key management API. MCP keys
// are authenticated with the Better Auth session, while the keys themselves
// are only stored as SHA-256 hashes and can never be read back.
func (b *backend) handleMCPKeys(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireSession(r)
	if err != nil {
		return err
	}
	keyID := strings.TrimPrefix(r.URL.Path, "/api/mcp/keys/")
	if keyID == r.URL.Path {
		keyID = ""
	}
	switch {
	case r.Method == http.MethodGet && keyID == "":
		return b.listMCPKeys(w, r, s.User.ID)
	case r.Method == http.MethodPost && keyID == "":
		return b.createMCPKey(w, r, s.User.ID)
	case r.Method == http.MethodPost && strings.HasSuffix(keyID, "/revoke"):
		return b.revokeMCPKey(w, r, s.User.ID, strings.TrimSuffix(keyID, "/revoke"))
	case r.Method == http.MethodDelete && keyID != "":
		return b.deleteMCPKey(w, r, s.User.ID, keyID)
	default:
		return invalid("未知的 MCP 密钥操作")
	}
}

func (b *backend) listMCPKeys(w http.ResponseWriter, r *http.Request, userID string) error {
	rows, err := b.db.Query(r.Context(), `SELECT id,name,key_prefix,last_four,is_active,last_used_at,revoked_at,created_at FROM mcp_api_key WHERE user_id=$1 ORDER BY created_at`, userID)
	if err != nil {
		return err
	}
	defer rows.Close()
	keys := make([]map[string]any, 0)
	for rows.Next() {
		var id, name, prefix, lastFour string
		var active bool
		var lastUsed, revoked *time.Time
		var created time.Time
		if err := rows.Scan(&id, &name, &prefix, &lastFour, &active, &lastUsed, &revoked, &created); err != nil {
			return err
		}
		keys = append(keys, map[string]any{
			"id": id, "name": name, "keyPrefix": prefix, "lastFour": lastFour,
			"isActive": active, "lastUsedAt": lastUsed, "revokedAt": revoked, "createdAt": created,
		})
	}
	if err := rows.Err(); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, keys)
	return nil
}

func (b *backend) createMCPKey(w http.ResponseWriter, r *http.Request, userID string) error {
	var in struct {
		Name string `json:"name"`
	}
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		name = "Default MCP key"
	}
	if len(name) > 120 {
		return invalid("MCP 密钥名称不能超过 120 个字符")
	}
	randomPart := make([]byte, 48)
	if _, err := rand.Read(randomPart); err != nil {
		return err
	}
	plaintext := mcpKeyPrefix + hex.EncodeToString(randomPart)
	hash := sha256.Sum256([]byte(plaintext))
	keyHash := hex.EncodeToString(hash[:])
	lastFour := plaintext[len(plaintext)-4:]
	id := newRequestID()
	var created time.Time
	if err := b.db.QueryRow(r.Context(), `INSERT INTO mcp_api_key(id,user_id,name,key_prefix,key_hash,last_four,is_active) VALUES($1,$2,$3,$4,$5,$6,true) RETURNING created_at`, id, userID, name, mcpKeyPrefix, keyHash, lastFour).Scan(&created); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "key": plaintext, "name": name, "keyPrefix": mcpKeyPrefix, "lastFour": lastFour, "createdAt": created})
	return nil
}

func (b *backend) revokeMCPKey(w http.ResponseWriter, r *http.Request, userID, keyID string) error {
	keyID = strings.TrimSpace(keyID)
	if keyID == "" {
		return invalid("MCP 密钥 ID 不能为空")
	}
	result, err := b.db.Exec(r.Context(), `UPDATE mcp_api_key SET is_active=false,revoked_at=now(),updated_at=now() WHERE id=$1 AND user_id=$2 AND is_active=true`, keyID, userID)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]bool{"success": result.RowsAffected() > 0})
	return nil
}

func (b *backend) deleteMCPKey(w http.ResponseWriter, r *http.Request, userID, keyID string) error {
	keyID = strings.TrimSpace(keyID)
	if keyID == "" {
		return invalid("MCP 密钥 ID 不能为空")
	}
	result, err := b.db.Exec(r.Context(), `DELETE FROM mcp_api_key WHERE id=$1 AND user_id=$2 AND is_active=false`, keyID, userID)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": result.RowsAffected() > 0, "id": keyID})
	return nil
}

func (b *backend) registerMCPKeyRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/mcp/keys", b.endpoint(b.handleRetiredMCP))
	mux.HandleFunc("POST /api/mcp/keys", b.endpoint(b.handleRetiredMCP))
	mux.HandleFunc("POST /api/mcp/keys/{id}/revoke", b.endpoint(b.handleRetiredMCP))
	mux.HandleFunc("DELETE /api/mcp/keys/{id}", b.endpoint(b.handleRetiredMCP))
}
