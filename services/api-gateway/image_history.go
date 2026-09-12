package main

// First-party image/video history and gallery endpoints. These handlers keep
// the browser contract small while enforcing ownership from the Better Auth
// session and querying PostgreSQL directly.

import (
	"encoding/json"
	"net/http"
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
	if s.User.Role != "admin" && s.User.Role != "owner" {
		return forbidden()
	}
	var in struct {
		Limit int `json:"limit"`
	}
	_ = json.NewDecoder(r.Body).Decode(&in)
	if in.Limit <= 0 || in.Limit > 100 {
		in.Limit = 50
	}
	rows, err := b.db.Query(r.Context(), `SELECT g.id,g.user_id,g.prompt,g.revised_prompt,g.model,g.size,g.status,g.storage_key,g.storage_bucket,g.credits_consumed,g.error,g.metadata,g.created_at,g.completed_at FROM generation g ORDER BY g.created_at DESC LIMIT $1`, in.Limit)
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
	// Global history includes video tasks as well. Project the shared fields into
	// the same browser DTO so the admin page does not silently omit all videos.
	videoRows, videoErr := b.db.Query(r.Context(), `SELECT id,user_id,prompt,model,resolution,status,storage_key,storage_bucket,credits_consumed,error,metadata,created_at,completed_at FROM video_generation ORDER BY created_at DESC LIMIT $1`, in.Limit)
	if videoErr != nil {
		return videoErr
	}
	defer videoRows.Close()
	for videoRows.Next() {
		var v generationDTO
		var resolution string
		if err := videoRows.Scan(&v.ID, &v.UserID, &v.Prompt, &v.Model, &resolution, &v.Status, &v.StorageKey, &v.StorageBucket, &v.CreditsConsumed, &v.Error, &v.Metadata, &v.CreatedAt, &v.CompletedAt); err != nil {
			return err
		}
		v.Size = resolution
		out = append(out, publicGeneration(v))
	}
	writeJSON(w, 200, map[string]any{"records": out, "items": out, "nextCursor": nil, "totalCount": len(out)})
	return rows.Err()
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
	if s.User.Role != "admin" && s.User.Role != "owner" {
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
