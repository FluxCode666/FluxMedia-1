package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sort"
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
	var callErr error
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
		out, callErr = b.mcpUserHistory(r, p.UserID, args)
		if callErr != nil {
			writeJSON(w, 200, mcpResult(q.ID, map[string]any{"content": []map[string]any{{"type": "text", "text": `{"error":"internal_error","message":"Unable to read history"}`}}, "isError": true}))
			return nil
		}
	}
	bts, _ := json.Marshal(out)
	writeJSON(w, 200, mcpResult(q.ID, map[string]any{"content": []map[string]any{{"type": "text", "text": string(bts)}}, "isError": false}))
	return nil
}

// mcpUserHistory is the MCP-safe projection of a user's unified image/video
// history. It intentionally queries by the authenticated principal only and
// omits storage keys, metadata and other internal fields from the response.
func (b *backend) mcpUserHistory(r *http.Request, userID string, args map[string]json.RawMessage) (map[string]any, error) {
	limit := 20
	for _, key := range []string{"pageSize", "limit"} {
		var n int
		if raw, ok := args[key]; ok && json.Unmarshal(raw, &n) == nil && n > 0 {
			if n > 50 {
				n = 50
			}
			limit = n
			break
		}
	}
	var imageRows []map[string]any
	rows, err := b.db.Query(r.Context(), `SELECT id,user_id,prompt,revised_prompt,model,size,status,storage_key,storage_bucket,credits_consumed,error,metadata,created_at,completed_at FROM generation WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`, userID, limit)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		v := generationDTO{}
		if err := rows.Scan(&v.ID, &v.UserID, &v.Prompt, &v.RevisedPrompt, &v.Model, &v.Size, &v.Status, &v.StorageKey, &v.StorageBucket, &v.CreditsConsumed, &v.Error, &v.Metadata, &v.CreatedAt, &v.CompletedAt); err != nil {
			rows.Close()
			return nil, err
		}
		imageRows = append(imageRows, adminImageHistoryRecord(v, ""))
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	videoRows, err := b.db.Query(r.Context(), `SELECT id,user_id,prompt,model,duration_seconds,aspect_ratio,resolution,status,storage_key,storage_bucket,credits_consumed,error,metadata,input_manifest,created_at,completed_at FROM video_generation WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`, userID, limit)
	if err != nil {
		return nil, err
	}
	for videoRows.Next() {
		v := generationDTO{}
		var duration int
		var ratio, resolution string
		var manifest any
		if err := videoRows.Scan(&v.ID, &v.UserID, &v.Prompt, &v.Model, &duration, &ratio, &resolution, &v.Status, &v.StorageKey, &v.StorageBucket, &v.CreditsConsumed, &v.Error, &v.Metadata, &manifest, &v.CreatedAt, &v.CompletedAt); err != nil {
			videoRows.Close()
			return nil, err
		}
		imageRows = append(imageRows, adminVideoHistoryRecord(v, "", duration, ratio, resolution, manifest))
	}
	if err := videoRows.Err(); err != nil {
		videoRows.Close()
		return nil, err
	}
	videoRows.Close()
	sort.SliceStable(imageRows, func(i, j int) bool {
		li, _ := imageRows[i]["createdAt"].(string)
		lj, _ := imageRows[j]["createdAt"].(string)
		if li == lj {
			a, _ := imageRows[i]["id"].(string)
			b, _ := imageRows[j]["id"].(string)
			return a > b
		}
		return li > lj
	})
	if len(imageRows) > limit {
		imageRows = imageRows[:limit]
	}
	for _, row := range imageRows {
		delete(row, "userId")
		delete(row, "userEmail")
		delete(row, "backendAccount")
		delete(row, "submissionAttempts")
		delete(row, "storageKey")
		delete(row, "storageBucket")
		delete(row, "metadata")
	}
	models := make([]string, 0, len(imageRows))
	seen := map[string]bool{}
	for _, row := range imageRows {
		if model, ok := row["model"].(string); ok && model != "" && !seen[model] {
			seen[model] = true
			models = append(models, model)
		}
	}
	return map[string]any{"asOf": time.Now().UTC().Format(time.RFC3339Nano), "page": 1, "pageSize": limit, "totalCount": len(imageRows), "records": imageRows, "modelOptions": models, "nextCursor": nil, "previousCursor": nil}, nil
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
