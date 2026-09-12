package main

// First-party image/video history and gallery endpoints. These handlers keep
// the browser contract small while enforcing ownership from the Better Auth
// session and querying PostgreSQL directly.

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func (b *backend) registerImageHistoryRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/image-generation/recent", b.endpoint(b.handleRecentGenerations))
	mux.HandleFunc("GET /api/image-generation/{id}", b.endpoint(b.handleGenerationByID))
	mux.HandleFunc("GET /api/image-generation/list", b.endpoint(b.handleGenerationList))
	mux.HandleFunc("GET /api/image-generation/count", b.endpoint(b.handleGenerationCount))
	mux.HandleFunc("POST /api/image-generation/delete", b.endpoint(b.handleGenerationDelete))
	mux.HandleFunc("POST /api/image-generation/batch-delete", b.endpoint(b.handleGenerationBatchDelete))
	mux.HandleFunc("POST /api/image-generation/gallery", b.endpoint(b.handleGallery))
	mux.HandleFunc("POST /api/image-generation/history", b.endpoint(b.handleHistory))
	mux.HandleFunc("POST /api/image-generation/video-inputs", b.endpoint(b.handleVideoInputs))
	mux.HandleFunc("POST /api/admin/image-generation/history", b.endpoint(b.handleAdminHistory))
	mux.HandleFunc("POST /api/admin/image-generation/request-snapshot", b.endpoint(b.handleAdminRequestSnapshot))
}

type generationDTO struct {
	ID              string     `json:"id"`
	UserID          string     `json:"userId"`
	Prompt          string     `json:"prompt"`
	RevisedPrompt   *string    `json:"revisedPrompt"`
	Model           string     `json:"model"`
	Size            string     `json:"size"`
	Status          string     `json:"status"`
	StorageKey      *string    `json:"storageKey"`
	StorageBucket   *string    `json:"storageBucket"`
	CreditsConsumed float64    `json:"creditsConsumed"`
	Error           *string    `json:"error"`
	Metadata        any        `json:"metadata"`
	CreatedAt       time.Time  `json:"createdAt"`
	CompletedAt     *time.Time `json:"completedAt"`
}

func scanGeneration(row pgx.Row) (generationDTO, error) {
	var v generationDTO
	err := row.Scan(&v.ID, &v.UserID, &v.Prompt, &v.RevisedPrompt, &v.Model, &v.Size, &v.Status, &v.StorageKey, &v.StorageBucket, &v.CreditsConsumed, &v.Error, &v.Metadata, &v.CreatedAt, &v.CompletedAt)
	return v, err
}
func generationURL(key, bucket *string) *string {
	if key == nil || *key == "" {
		return nil
	}
	b := "generations"
	if bucket != nil && *bucket != "" {
		b = *bucket
	}
	u := "/api/storage/" + b + "/" + *key
	// Storage routes require HMAC signatures for private buckets. Keep the URL
	// usable by the browser and thumbnail loader while preserving public bucket
	// paths when no signing secret is configured in a test process.
	if b != "avatars" {
		secret := os.Getenv("BETTER_AUTH_SECRET")
		if secret != "" {
			exp := time.Now().Add(time.Hour).Unix()
			mac := hmac.New(sha256.New, []byte(secret))
			_, _ = mac.Write([]byte(b + "/" + *key + ":" + strconv.FormatInt(exp, 10)))
			u += "?sig=" + url.QueryEscape(hex.EncodeToString(mac.Sum(nil))) + "&exp=" + strconv.FormatInt(exp, 10)
		}
	}
	return &u
}
func publicGeneration(v generationDTO) map[string]any {
	return map[string]any{"id": v.ID, "userId": v.UserID, "prompt": v.Prompt, "revisedPrompt": v.RevisedPrompt, "model": v.Model, "size": v.Size, "status": v.Status, "storageKey": v.StorageKey, "storageBucket": v.StorageBucket, "imageUrl": generationURL(v.StorageKey, v.StorageBucket), "creditsConsumed": v.CreditsConsumed, "error": v.Error, "metadata": v.Metadata, "createdAt": v.CreatedAt.UTC().Format(time.RFC3339Nano), "completedAt": func() any {
		if v.CompletedAt == nil {
			return nil
		}
		return v.CompletedAt.UTC().Format(time.RFC3339Nano)
	}()}
}

func (b *backend) handleRecentGenerations(w http.ResponseWriter, r *http.Request) error {
	s, e := b.requireSession(r)
	if e != nil {
		return e
	}
	n := 12
	if x := r.URL.Query().Get("limit"); x != "" {
		if i, err := strconv.Atoi(x); err == nil && i > 0 && i <= 50 {
			n = i
		}
	}
	rows, err := b.db.Query(r.Context(), `SELECT id,user_id,prompt,revised_prompt,model,size,status,storage_key,storage_bucket,credits_consumed,error,metadata,created_at,completed_at FROM generation WHERE user_id=$1 AND ((status='completed' AND storage_key IS NOT NULL) OR status='pending') ORDER BY created_at DESC LIMIT $2`, s.User.ID, n)
	if err != nil {
		return err
	}
	defer rows.Close()
	out := []any{}
	for rows.Next() {
		v := generationDTO{}
		if err := rows.Scan(&v.ID, &v.UserID, &v.Prompt, &v.RevisedPrompt, &v.Model, &v.Size, &v.Status, &v.StorageKey, &v.StorageBucket, &v.CreditsConsumed, &v.Error, &v.Metadata, &v.CreatedAt, &v.CompletedAt); err != nil {
			return err
		}
		out = append(out, publicGeneration(v))
	}
	writeJSON(w, 200, out)
	return rows.Err()
}

func (b *backend) handleGenerationByID(w http.ResponseWriter, r *http.Request) error {
	s, e := b.requireSession(r)
	if e != nil {
		return e
	}
	id := r.PathValue("id")
	v, err := scanGeneration(b.db.QueryRow(r.Context(), `SELECT id,user_id,prompt,revised_prompt,model,size,status,storage_key,storage_bucket,credits_consumed,error,metadata,created_at,completed_at FROM generation WHERE id=$1 AND user_id=$2`, id, s.User.ID))
	if err == pgx.ErrNoRows {
		writeJSON(w, 404, nil)
		return nil
	}
	if err != nil {
		return err
	}
	writeJSON(w, 200, publicGeneration(v))
	return nil
}

func (b *backend) handleGenerationList(w http.ResponseWriter, r *http.Request) error {
	s, e := b.requireSession(r)
	if e != nil {
		return e
	}
	q := r.URL.Query()
	lim := 20
	if i, _ := strconv.Atoi(q.Get("limit")); i > 0 && i <= 100 {
		lim = i
	}
	off := 0
	if i, _ := strconv.Atoi(q.Get("offset")); i >= 0 {
		off = i
	}
	status := q.Get("status")
	args := []any{s.User.ID, lim, off}
	where := `user_id=$1`
	if status != "" {
		where += ` AND status=$4`
		args = append(args, status)
	}
	rows, err := b.db.Query(r.Context(), `SELECT id,user_id,prompt,revised_prompt,model,size,status,storage_key,storage_bucket,credits_consumed,error,metadata,created_at,completed_at FROM generation WHERE `+where+` ORDER BY created_at DESC LIMIT $2 OFFSET $3`, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	out := []any{}
	for rows.Next() {
		v := generationDTO{}
		if err := rows.Scan(&v.ID, &v.UserID, &v.Prompt, &v.RevisedPrompt, &v.Model, &v.Size, &v.Status, &v.StorageKey, &v.StorageBucket, &v.CreditsConsumed, &v.Error, &v.Metadata, &v.CreatedAt, &v.CompletedAt); err != nil {
			return err
		}
		out = append(out, publicGeneration(v))
	}
	writeJSON(w, 200, out)
	return rows.Err()
}
func (b *backend) handleGenerationCount(w http.ResponseWriter, r *http.Request) error {
	s, e := b.requireSession(r)
	if e != nil {
		return e
	}
	status := r.URL.Query().Get("status")
	var n int64
	if status == "" {
		e = b.db.QueryRow(r.Context(), `SELECT count(*) FROM generation WHERE user_id=$1`, s.User.ID).Scan(&n)
	} else {
		e = b.db.QueryRow(r.Context(), `SELECT count(*) FROM generation WHERE user_id=$1 AND status=$2`, s.User.ID, status).Scan(&n)
	}
	if e != nil {
		return e
	}
	writeJSON(w, 200, map[string]any{"count": n})
	return nil
}

func (b *backend) handleGenerationDelete(w http.ResponseWriter, r *http.Request) error {
	s, e := b.requireSession(r)
	if e != nil {
		return e
	}
	var in struct {
		GenerationID string `json:"generationId"`
	}
	if e = decodeBody(r, &in); e != nil {
		return e
	}
	if strings.TrimSpace(in.GenerationID) == "" {
		return invalid("generationId required")
	}
	tag, e := b.db.Exec(r.Context(), `UPDATE generation SET storage_key=NULL,file_size=NULL WHERE id=$1 AND user_id=$2`, in.GenerationID, s.User.ID)
	if e != nil {
		return e
	}
	writeJSON(w, 200, map[string]any{"success": tag.RowsAffected() > 0, "deletedCount": tag.RowsAffected()})
	return nil
}
func (b *backend) handleGenerationBatchDelete(w http.ResponseWriter, r *http.Request) error {
	s, e := b.requireSession(r)
	if e != nil {
		return e
	}
	var in struct {
		GenerationIDs []string `json:"generationIds"`
	}
	if e = decodeBody(r, &in); e != nil {
		return e
	}
	if len(in.GenerationIDs) == 0 || len(in.GenerationIDs) > 100 {
		return invalid("generationIds must contain 1-100 ids")
	}
	var n int64
	for _, id := range in.GenerationIDs {
		tag, err := b.db.Exec(r.Context(), `UPDATE generation SET storage_key=NULL,file_size=NULL WHERE id=$1 AND user_id=$2`, id, s.User.ID)
		if err != nil {
			return err
		}
		n += tag.RowsAffected()
	}
	writeJSON(w, 200, map[string]any{"success": true, "deletedCount": n})
	return nil
}

func (b *backend) handleGallery(w http.ResponseWriter, r *http.Request) error {
	s, e := b.requireSession(r)
	if e != nil {
		return e
	}
	var in struct {
		Tab    string `json:"tab"`
		Limit  int    `json:"limit"`
		Offset int    `json:"offset"`
	}
	if e = decodeBody(r, &in); e != nil {
		return e
	}
	if in.Limit <= 0 || in.Limit > 50 {
		in.Limit = 20
	}
	if in.Tab == "videos" {
		rows, err := b.db.Query(r.Context(), `SELECT id,prompt,model,duration_seconds,aspect_ratio,resolution,credits_consumed,storage_key,storage_bucket,created_at FROM video_generation WHERE user_id=$1 AND status='completed' AND storage_key IS NOT NULL ORDER BY created_at DESC LIMIT $2 OFFSET $3`, s.User.ID, in.Limit, in.Offset)
		if err != nil {
			return err
		}
		defer rows.Close()
		out := []any{}
		for rows.Next() {
			var id, prompt, model, ratio, res string
			var dur int
			var credits float64
			var key, bucket *string
			var created time.Time
			if err := rows.Scan(&id, &prompt, &model, &dur, &ratio, &res, &credits, &key, &bucket, &created); err != nil {
				return err
			}
			out = append(out, map[string]any{"id": id, "parentId": id, "prompt": prompt, "model": model, "durationSeconds": dur, "aspectRatio": ratio, "resolution": res, "creditsConsumed": credits, "videoUrl": generationURL(key, bucket), "createdAt": created.UTC().Format(time.RFC3339Nano), "outputRole": "video", "status": "completed"})
		}
		writeJSON(w, 200, map[string]any{"items": out, "nextCursor": nil})
		return rows.Err()
	}
	rows, err := b.db.Query(r.Context(), `SELECT id,user_id,prompt,revised_prompt,model,size,status,storage_key,storage_bucket,credits_consumed,error,metadata,created_at,completed_at FROM generation WHERE user_id=$1 AND status='completed' AND storage_key IS NOT NULL ORDER BY created_at DESC LIMIT $2 OFFSET $3`, s.User.ID, in.Limit, in.Offset)
	if err != nil {
		return err
	}
	defer rows.Close()
	out := []any{}
	for rows.Next() {
		v := generationDTO{}
		if err := rows.Scan(&v.ID, &v.UserID, &v.Prompt, &v.RevisedPrompt, &v.Model, &v.Size, &v.Status, &v.StorageKey, &v.StorageBucket, &v.CreditsConsumed, &v.Error, &v.Metadata, &v.CreatedAt, &v.CompletedAt); err != nil {
			return err
		}
		p := publicGeneration(v)
		p["parentId"] = v.ID
		p["outputRole"] = "final"
		delete(p, "userId")
		out = append(out, p)
	}
	writeJSON(w, 200, map[string]any{"items": out, "nextCursor": nil})
	return rows.Err()
}

func (b *backend) handleHistory(w http.ResponseWriter, r *http.Request) error {
	s, e := b.requireSession(r)
	if e != nil {
		return e
	}
	q := r.URL.Query()
	lim := 20
	if i, _ := strconv.Atoi(q.Get("limit")); i > 0 && i <= 50 {
		lim = i
	}
	rows, err := b.db.Query(r.Context(), `SELECT id,user_id,prompt,revised_prompt,model,size,status,storage_key,storage_bucket,credits_consumed,error,metadata,created_at,completed_at FROM generation WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`, s.User.ID, lim)
	if err != nil {
		return err
	}
	defer rows.Close()
	out := []any{}
	for rows.Next() {
		v := generationDTO{}
		if err := rows.Scan(&v.ID, &v.UserID, &v.Prompt, &v.RevisedPrompt, &v.Model, &v.Size, &v.Status, &v.StorageKey, &v.StorageBucket, &v.CreditsConsumed, &v.Error, &v.Metadata, &v.CreatedAt, &v.CompletedAt); err != nil {
			return err
		}
		p := publicGeneration(v)
		p["type"] = "image"
		out = append(out, p)
	}
	writeJSON(w, 200, map[string]any{"records": out, "items": out, "nextCursor": nil, "totalCount": len(out)})
	return rows.Err()
}

func (b *backend) handleAdminHistory(w http.ResponseWriter, r *http.Request) error {
	s, e := b.requireSession(r)
	if e != nil {
		return e
	}
	if s.User.Role != "observer_admin" && s.User.Role != "admin" && s.User.Role != "super_admin" && s.User.Role != "owner" {
		return forbidden()
	}
	var in struct {
		Limit    int `json:"limit"`
		Page     int `json:"page"`
		PageSize int `json:"pageSize"`
	}
	_ = json.NewDecoder(r.Body).Decode(&in)
	if in.Limit <= 0 || in.Limit > 100 {
		in.Limit = 50
	}
	rows, err := b.db.Query(r.Context(), `SELECT g.id,g.user_id,u.email,g.prompt,g.revised_prompt,g.model,g.size,g.status,g.storage_key,g.storage_bucket,g.credits_consumed,g.error,g.metadata,g.created_at,g.completed_at FROM generation g INNER JOIN "user" u ON u.id=g.user_id ORDER BY g.created_at DESC LIMIT $1`, in.Limit)
	if err != nil {
		return err
	}
	defer rows.Close()
	out := []any{}
	for rows.Next() {
		v := generationDTO{}
		var userEmail string
		if err := rows.Scan(&v.ID, &v.UserID, &userEmail, &v.Prompt, &v.RevisedPrompt, &v.Model, &v.Size, &v.Status, &v.StorageKey, &v.StorageBucket, &v.CreditsConsumed, &v.Error, &v.Metadata, &v.CreatedAt, &v.CompletedAt); err != nil {
			return err
		}
		out = append(out, adminImageHistoryRecord(v, userEmail))
	}
	// Global history includes video tasks as well. Project the shared fields into
	// the same browser DTO so the admin page does not silently omit all videos.
	videoRows, videoErr := b.db.Query(r.Context(), `SELECT v.id,v.user_id,u.email,v.prompt,v.model,v.duration_seconds,v.aspect_ratio,v.resolution,v.status,v.storage_key,v.storage_bucket,v.credits_consumed,v.error,v.metadata,v.input_manifest,v.created_at,v.completed_at FROM video_generation v INNER JOIN "user" u ON u.id=v.user_id ORDER BY v.created_at DESC LIMIT $1`, in.Limit)
	if videoErr != nil {
		return videoErr
	}
	defer videoRows.Close()
	for videoRows.Next() {
		var v generationDTO
		var userEmail, resolution, aspectRatio string
		var duration int
		var inputManifest any
		if err := videoRows.Scan(&v.ID, &v.UserID, &userEmail, &v.Prompt, &v.Model, &duration, &aspectRatio, &resolution, &v.Status, &v.StorageKey, &v.StorageBucket, &v.CreditsConsumed, &v.Error, &v.Metadata, &inputManifest, &v.CreatedAt, &v.CompletedAt); err != nil {
			return err
		}
		out = append(out, adminVideoHistoryRecord(v, userEmail, duration, aspectRatio, resolution, inputManifest))
	}
	// Keep the merged media stream stable by creation time, then ID. The frontend
	// relies on this ordering for cursor/page transitions.
	sort.SliceStable(out, func(i, j int) bool {
		left, lok := out[i].(map[string]any)
		right, rok := out[j].(map[string]any)
		if !lok || !rok {
			return false
		}
		lt, _ := left["createdAt"].(string)
		rt, _ := right["createdAt"].(string)
		if lt == rt {
			li, _ := left["id"].(string)
			ri, _ := right["id"].(string)
			return li > ri
		}
		return lt > rt
	})
	page := in.Page
	if page <= 0 {
		page = 1
	}
	pageSize := in.PageSize
	if pageSize <= 0 {
		pageSize = in.Limit
	}
	if pageSize <= 0 || pageSize > 50 {
		pageSize = 50
	}
	if len(out) > pageSize {
		out = out[:pageSize]
	}
	modelOptions := make([]string, 0, len(out))
	users := make([]map[string]any, 0, len(out))
	seenModels := map[string]struct{}{}
	seenUsers := map[string]struct{}{}
	for _, item := range out {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if model, ok := row["model"].(string); ok && model != "" {
			if _, exists := seenModels[model]; !exists {
				seenModels[model] = struct{}{}
				modelOptions = append(modelOptions, model)
			}
		}
		uid, _ := row["userId"].(string)
		email, _ := row["userEmail"].(string)
		if uid != "" && email != "" {
			if _, exists := seenUsers[uid]; !exists {
				seenUsers[uid] = struct{}{}
				users = append(users, map[string]any{"id": uid, "email": email})
			}
		}
	}
	writeJSON(w, 200, map[string]any{
		"asOf": time.Now().UTC().Format(time.RFC3339Nano), "page": page, "pageSize": pageSize,
		"totalCount": len(out), "records": out, "modelOptions": modelOptions, "userOptions": users,
		"nextCursor": nil, "previousCursor": nil,
	})
	return rows.Err()
}

func historyStatusImage(status string) string {
	if status == "pending" {
		return "processing"
	}
	return status
}

func historyStatusVideo(status string) string {
	switch status {
	case "pending", "queued":
		return "queued"
	case "running", "in_progress", "processing":
		return "in_progress"
	default:
		return status
	}
}

func processingSeconds(created time.Time, completed *time.Time) any {
	if completed == nil || completed.Before(created) {
		return nil
	}
	return int(completed.Sub(created).Seconds())
}

func metadataMap(value any) map[string]any {
	switch v := value.(type) {
	case map[string]any:
		return v
	case []byte:
		var out map[string]any
		if json.Unmarshal(v, &out) == nil {
			return out
		}
	case json.RawMessage:
		var out map[string]any
		if json.Unmarshal(v, &out) == nil {
			return out
		}
	}
	return map[string]any{}
}

func metadataBool(value any, key string, fallback bool) bool {
	if v, ok := metadataMap(value)[key].(bool); ok {
		return v
	}
	return fallback
}

func videoInputSummary(manifest any) map[string]any {
	m := metadataMap(manifest)
	count := 0
	mode := "none"
	if _, ok := m["firstFrame"]; ok {
		count++
	}
	if _, ok := m["lastFrame"]; ok {
		count++
	}
	for _, key := range []string{"referenceImages", "referenceVideos", "referenceAudios"} {
		if values, ok := m[key].([]any); ok {
			count += len(values)
		}
	}
	if count == 1 {
		mode = "first-frame"
	} else if count == 2 && m["firstFrame"] != nil && m["lastFrame"] != nil {
		mode = "first-last-frames"
	} else if count > 0 {
		mode = "mixed"
	}
	return map[string]any{"mode": mode, "count": count}
}

func adminImageHistoryRecord(v generationDTO, userEmail string) map[string]any {
	return map[string]any{
		"kind": "image", "id": v.ID, "userId": v.UserID, "userEmail": userEmail,
		"prompt": v.Prompt, "model": v.Model, "status": historyStatusImage(v.Status),
		"creditsConsumed": v.CreditsConsumed, "error": v.Error, "createdAt": v.CreatedAt.UTC().Format(time.RFC3339Nano),
		"completedAt": func() any {
			if v.CompletedAt == nil {
				return nil
			}
			return v.CompletedAt.UTC().Format(time.RFC3339Nano)
		}(),
		"processingDurationSeconds": processingSeconds(v.CreatedAt, v.CompletedAt), "revisedPrompt": v.RevisedPrompt,
		"size": v.Size, "creditDetails": nil, "promptRepairNotice": nil, "referenceImages": []any{},
		"imageUrl": generationURL(v.StorageKey, v.StorageBucket), "backendAccount": nil,
	}
}

func adminVideoHistoryRecord(v generationDTO, userEmail string, duration int, aspectRatio, resolution string, inputManifest any) map[string]any {
	return map[string]any{
		"kind": "video", "id": v.ID, "userId": v.UserID, "userEmail": userEmail,
		"prompt": v.Prompt, "model": v.Model, "status": historyStatusVideo(v.Status),
		"creditsConsumed": v.CreditsConsumed, "error": v.Error, "createdAt": v.CreatedAt.UTC().Format(time.RFC3339Nano),
		"completedAt": func() any {
			if v.CompletedAt == nil {
				return nil
			}
			return v.CompletedAt.UTC().Format(time.RFC3339Nano)
		}(),
		"processingDurationSeconds": processingSeconds(v.CreatedAt, v.CompletedAt), "resolution": resolution,
		"duration": duration, "aspectRatio": aspectRatio, "generateAudio": metadataBool(v.Metadata, "generateAudio", false),
		"input": videoInputSummary(inputManifest), "billing": map[string]any{"kind": "legacy", "mode": "per_second", "unit": "second", "unitPrice": nil, "creditsPerSecond": nil, "quotedCredits": nil, "actualCredits": v.CreditsConsumed},
		"submissionAttempts": []any{}, "videoUrl": generationURL(v.StorageKey, v.StorageBucket), "backendAccount": nil,
	}
}

func (b *backend) handleVideoInputs(w http.ResponseWriter, r *http.Request) error {
	s, e := b.requireSession(r)
	if e != nil {
		return e
	}
	var in struct {
		TaskID string `json:"taskId"`
	}
	if e = decodeBody(r, &in); e != nil {
		return e
	}
	var manifest any
	err := b.db.QueryRow(r.Context(), `SELECT input_manifest FROM video_generation WHERE id=$1 AND user_id=$2`, in.TaskID, s.User.ID).Scan(&manifest)
	if err == pgx.ErrNoRows {
		return &apiError{404, "NOT_FOUND", "视频任务不存在"}
	}
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"taskId": in.TaskID, "inputs": manifest})
	return nil
}

func (b *backend) handleAdminRequestSnapshot(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireSession(r)
	if err != nil {
		return err
	}
	if s.User.Role != "observer_admin" && s.User.Role != "admin" && s.User.Role != "super_admin" && s.User.Role != "owner" {
		return forbidden()
	}
	var in struct {
		ID   string `json:"id"`
		Kind string `json:"kind"`
	}
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	if in.ID == "" || (in.Kind != "image" && in.Kind != "video") {
		return invalid("id and kind are required")
	}
	var snapshot any
	if in.Kind == "image" {
		err = b.db.QueryRow(r.Context(), `SELECT metadata::jsonb->'upstreamRequestSnapshot' FROM generation WHERE id=$1`, in.ID).Scan(&snapshot)
	} else {
		err = b.db.QueryRow(r.Context(), `SELECT metadata::jsonb->'upstreamRequestSnapshot' FROM video_generation WHERE id=$1`, in.ID).Scan(&snapshot)
	}
	if err == pgx.ErrNoRows {
		return &apiError{404, "NOT_FOUND", "记录不存在"}
	}
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"id": in.ID, "kind": in.Kind, "snapshot": snapshot})
	return nil
}
