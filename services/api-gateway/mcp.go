package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

type mcpRPC struct {
	JSONRPC string                     `json:"jsonrpc"`
	ID      any                        `json:"id"`
	Method  string                     `json:"method"`
	Params  map[string]json.RawMessage `json:"params"`
}
type mcpPrincipal struct{ UserID, KeyID string }
type mcpBucket struct {
	Count int
	Reset time.Time
}

var mcpMu sync.Mutex
var mcpBuckets = map[string]mcpBucket{}

func mcpEnabled(name string) bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv(name)))
	return v == "1" || v == "true" || v == "yes" || v == "on"
}
func mcpLimit(name string, fallback int) int {
	var n int
	if _, e := fmt.Sscanf(os.Getenv(name), "%d", &n); e != nil || n < 1 {
		return fallback
	}
	return n
}
func mcpRate(key string, limit int) bool {
	mcpMu.Lock()
	defer mcpMu.Unlock()
	now := time.Now()
	b, ok := mcpBuckets[key]
	if !ok || now.After(b.Reset) {
		mcpBuckets[key] = mcpBucket{1, now.Add(time.Minute)}
		return true
	}
	b.Count++
	mcpBuckets[key] = b
	return b.Count <= limit
}
func mcpError(id any, code int, msg string) map[string]any {
	return map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": code, "message": msg}}
}
func mcpResult(id any, result any) map[string]any {
	return map[string]any{"jsonrpc": "2.0", "id": id, "result": result}
}

func (b *backend) authenticateMCPUser(r *http.Request) (*mcpPrincipal, error) {
	parts := strings.Fields(r.Header.Get("Authorization"))
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return nil, &apiError{401, "UNAUTHORIZED", "Missing or invalid Bearer token"}
	}
	h := sha256.Sum256([]byte(parts[1]))
	var p mcpPrincipal
	var banned bool
	err := b.db.QueryRow(r.Context(), `UPDATE mcp_api_key k SET last_used_at=now(),updated_at=now() FROM "user" u WHERE k.user_id=u.id AND k.key_hash=$1 AND k.is_active RETURNING k.id,k.user_id,u.banned`, hex.EncodeToString(h[:])).Scan(&p.KeyID, &p.UserID, &banned)
	if err != nil {
		return nil, &apiError{401, "UNAUTHORIZED", "Invalid or inactive MCP key"}
	}
	if banned {
		return nil, &apiError{403, "FORBIDDEN", "Account is banned"}
	}
	return &p, nil
}

var userMCPTools = []map[string]any{
	{"name": "image.generate", "description": "Generate an image", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{"prompt": map[string]any{"type": "string"}, "model": map[string]any{"type": "string"}}, "required": []string{"prompt", "model"}}},
	{"name": "video.generate", "description": "Generate a video", "inputSchema": map[string]any{"type": "object"}},
	{"name": "video.getStatus", "description": "Get video task status", "inputSchema": map[string]any{"type": "object"}},
	{"name": "video.listCapabilities", "description": "List video capabilities", "inputSchema": map[string]any{"type": "object"}},
	{"name": "image.listMyHistoryRecords", "description": "List your image history", "inputSchema": map[string]any{"type": "object"}},
}

func (b *backend) handleMCPUser(w http.ResponseWriter, r *http.Request) error {
	if !mcpEnabled("MCP_USER_ENABLED") {
		writeJSON(w, 404, map[string]any{"error": "MCP User endpoint is disabled"})
		return nil
	}
	p, err := b.authenticateMCPUser(r)
	if err != nil {
		return writeMCPAuthError(w, err)
	}
	if !mcpRate("user:"+p.KeyID, mcpLimit("MCP_USER_RATE_LIMIT_PER_MIN", 30)) {
		writeJSON(w, 429, mcpError(nil, -32000, "Rate limit exceeded"))
		return nil
	}
	if !mcpRate("account:"+p.UserID, mcpLimit("MCP_USER_RATE_LIMIT_PER_MIN", 30)) {
		writeJSON(w, 429, mcpError(nil, -32000, "Rate limit exceeded"))
		return nil
	}
	var q mcpRPC
	if json.NewDecoder(r.Body).Decode(&q) != nil || q.JSONRPC != "2.0" || q.Method == "" {
		writeJSON(w, 400, mcpError(nil, -32700, "Failed to parse JSON body"))
		return nil
	}
	switch q.Method {
	case "initialize":
		writeJSON(w, 200, mcpResult(q.ID, map[string]any{"protocolVersion": "2024-11-05", "capabilities": map[string]any{"tools": map[string]any{"listChanged": false}}, "serverInfo": map[string]any{"name": "gpt2image-user-mcp", "version": "1.0.0"}}))
	case "tools/list":
		writeJSON(w, 200, mcpResult(q.ID, map[string]any{"tools": userMCPTools}))
	case "tools/call":
		return b.handleMCPUserCall(w, r, q, p)
	default:
		writeJSON(w, 200, mcpError(q.ID, -32601, "Unknown method: "+q.Method))
	}
	return nil
}
func writeMCPAuthError(w http.ResponseWriter, err error) error {
	if e, ok := err.(*apiError); ok {
		writeJSON(w, e.status, mcpError(nil, -32001, e.message))
		return nil
	}
	return err
}
func (b *backend) handleMCPUserCall(w http.ResponseWriter, r *http.Request, q mcpRPC, p *mcpPrincipal) error {
	var name string
	json.Unmarshal(q.Params["name"], &name)
	var args map[string]json.RawMessage
	json.Unmarshal(q.Params["arguments"], &args)
	if args == nil {
		args = map[string]json.RawMessage{}
	}
	allowed := false
	for _, t := range userMCPTools {
		if t["name"] == name {
			allowed = true
		}
	}
	if !allowed {
		writeJSON(w, 200, mcpError(q.ID, -32601, "Tool not available: "+name))
		return nil
	}
	var out any
	switch name {
	case "image.generate":
		out, _ = b.createImageTask(r, &apiPrincipal{UserID: p.UserID, KeyID: p.KeyID}, args, "generate")
	case "video.generate":
		out, _ = b.createVideoTask(r, &apiPrincipal{UserID: p.UserID, KeyID: p.KeyID}, args)
	case "video.getStatus":
		var id string
		json.Unmarshal(args["taskId"], &id)
		out, _ = b.videoStatus(r, id, p.UserID)
	case "video.listCapabilities":
		out = map[string]any{"object": "list", "data": videoModelIDs}
	case "image.listMyHistoryRecords":
		out = map[string]any{"records": []any{}, "items": []any{}, "total": 0}
	}
	bts, _ := json.Marshal(out)
	writeJSON(w, 200, mcpResult(q.ID, map[string]any{"content": []map[string]any{{"type": "text", "text": string(bts)}}, "isError": false}))
	return nil
}

func (b *backend) handleMCPAdmin(w http.ResponseWriter, r *http.Request) error {
	if !mcpEnabled("MCP_ENABLED") {
		writeJSON(w, 404, map[string]any{"error": "MCP Admin is not enabled"})
		return nil
	}
	secret := strings.TrimSpace(os.Getenv("MCP_ADMIN_SECRET"))
	parts := strings.Fields(r.Header.Get("Authorization"))
	if secret == "" || len(parts) != 2 || parts[0] != "Bearer" || len(parts[1]) != len(secret) || subtle.ConstantTimeCompare([]byte(parts[1]), []byte(secret)) != 1 {
		writeJSON(w, 401, mcpError(nil, -32001, "Invalid credentials"))
		return nil
	}
	if !mcpRate("admin", mcpLimit("MCP_RATE_LIMIT_PER_MIN", 60)) {
		writeJSON(w, 429, mcpError(nil, -32002, "Rate limit exceeded"))
		return nil
	}
	var q mcpRPC
	if json.NewDecoder(r.Body).Decode(&q) != nil || q.JSONRPC != "2.0" || q.Method == "" {
		writeJSON(w, 400, mcpError(nil, -32700, "Parse error"))
		return nil
	}
	adminTools := []map[string]any{{"name": "analytics_getAdminDataDashboard", "description": "Read admin dashboard", "inputSchema": map[string]any{"type": "object"}}, {"name": "modelMarketplace_listPublicModels", "description": "List public models", "inputSchema": map[string]any{"type": "object"}}}
	switch q.Method {
	case "initialize":
		writeJSON(w, 200, mcpResult(q.ID, map[string]any{"protocolVersion": "2024-11-05", "serverInfo": map[string]any{"name": "gpt2image-admin", "version": "1.0.0"}, "capabilities": map[string]any{"tools": map[string]any{}}}))
	case "tools/list":
		writeJSON(w, 200, mcpResult(q.ID, map[string]any{"tools": adminTools}))
	case "tools/call":
		var name string
		json.Unmarshal(q.Params["name"], &name)
		ok := false
		for _, t := range adminTools {
			if t["name"] == name {
				ok = true
			}
		}
		if !ok {
			writeJSON(w, 400, mcpError(q.ID, -32601, "Tool not available: "+name))
		} else {
			writeJSON(w, 200, mcpResult(q.ID, map[string]any{"content": []map[string]any{{"type": "text", "text": "{}"}}}))
		}
	default:
		writeJSON(w, 400, mcpError(q.ID, -32601, "Unknown method: "+q.Method))
	}
	return nil
}
