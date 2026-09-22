package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type imageRetentionOptions struct {
	Mode           string     `json:"mode"`
	Now            *time.Time `json:"now,omitempty"`
	Limit          int        `json:"limit,omitempty"`
	RetentionHours *float64   `json:"retentionHours,omitempty"`
	MaxCount       *int       `json:"maxCount,omitempty"`
}
type imageRetentionDetail struct {
	GenerationID string `json:"generationId"`
	UserID       string `json:"userId"`
	Objects      int    `json:"storageObjectsDeleted"`
}
type imageRetentionResult struct {
	Enabled        bool                   `json:"enabled"`
	RetentionHours float64                `json:"retentionHours"`
	MaxCount       int                    `json:"maxCount"`
	Cutoff         *time.Time             `json:"cutoff"`
	Destroyed      int                    `json:"destroyed"`
	Failed         int                    `json:"failed"`
	Objects        int                    `json:"storageObjectsDeleted"`
	Details        []imageRetentionDetail `json:"details"`
}

func (b *backend) handleImageRetention(w http.ResponseWriter, r *http.Request) error {
	if !b.cronAuthorized(r) {
		return &apiError{403, "FORBIDDEN", "System authentication required"}
	}
	var input imageRetentionOptions
	if err := decodeBody(r, &input); err != nil {
		return err
	}
	result, err := b.runImageRetention(r.Context(), input)
	if err != nil {
		return err
	}
	writeJSON(w, 200, result)
	return nil
}
func (b *backend) runImageRetention(ctx context.Context, options imageRetentionOptions) (imageRetentionResult, error) {
	out := imageRetentionResult{Details: []imageRetentionDetail{}}
	r := (&http.Request{}).WithContext(ctx)
	mode := options.Mode
	if mode == "" {
		var err error
		mode, err = b.settingString(ctx, "GENERATION_IMAGE_RETENTION_MODE", "off")
		if err != nil {
			return out, err
		}
	}
	if mode == "off" {
		return out, nil
	}
	limit := options.Limit
	if limit == 0 {
		limit = 100
	}
	if limit < 1 || limit > 1000 {
		return out, invalid("Invalid retention batch limit")
	}
	now := time.Now().UTC()
	if options.Now != nil {
		now = options.Now.UTC()
	}
	var query string
	var argument any
	if mode == "time" {
		hours, err := b.settingNumber(r, "GENERATION_IMAGE_RETENTION_HOURS", 0)
		if err != nil {
			return out, err
		}
		if options.RetentionHours != nil {
			hours = *options.RetentionHours
		}
		out.RetentionHours = hours
		if hours <= 0 {
			return out, nil
		}
		if hours > 876000 {
			return out, invalid("Invalid retention hours")
		}
		cutoff := now.Add(-time.Duration(hours * float64(time.Hour)))
		out.Cutoff = &cutoff
		argument = cutoff
		query = `SELECT id,user_id FROM generation WHERE status='completed' AND storage_key IS NOT NULL AND COALESCE(completed_at,created_at)<$1 ORDER BY COALESCE(completed_at,created_at),id LIMIT $2`
	} else if mode == "count" {
		count, err := b.settingInt(r, "GENERATION_IMAGE_MAX_COUNT", 10000, 0, 10000000)
		if err != nil {
			return out, err
		}
		if options.MaxCount != nil {
			count = *options.MaxCount
		}
		out.MaxCount = count
		if count <= 0 {
			return out, nil
		}
		argument = count
		query = `WITH ranked AS (SELECT id,user_id,COALESCE(completed_at,created_at) AS produced_at,row_number() OVER(PARTITION BY user_id ORDER BY COALESCE(completed_at,created_at) DESC,id DESC) AS rank FROM generation WHERE status='completed' AND storage_key IS NOT NULL) SELECT id,user_id FROM ranked WHERE rank>$1 ORDER BY produced_at,id LIMIT $2`
	} else {
		return out, invalid("Invalid image retention mode")
	}
	out.Enabled = true
	rows, err := b.db.Query(ctx, query, argument, limit)
	if err != nil {
		return out, err
	}
	var candidates []imageRetentionDetail
	for rows.Next() {
		var v imageRetentionDetail
		if err := rows.Scan(&v.GenerationID, &v.UserID); err != nil {
			rows.Close()
			return out, err
		}
		candidates = append(candidates, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return out, err
	}
	for _, candidate := range candidates {
		n, changed, err := b.purgeGenerationPhotos(ctx, candidate.UserID, candidate.GenerationID, "retention", out.RetentionHours, out.MaxCount, now)
		if err != nil {
			out.Failed++
			continue
		}
		if !changed {
			continue
		}
		candidate.Objects = n
		out.Details = append(out.Details, candidate)
		out.Destroyed++
		out.Objects += n
	}
	return out, nil
}

type generationObject struct{ bucket, key string }

func generationObjects(bucket, key string, metadata map[string]any) []generationObject {
	if bucket == "" {
		bucket = "generations"
	}
	refs := map[string]generationObject{}
	add := func(bucket, key string) {
		if key != "" {
			refs[bucket+"\x00"+key] = generationObject{bucket, key}
		}
	}
	add(bucket, key)
	for _, section := range []struct{ container, list string }{{"outputImage", "imageOutputs"}, {"inputImages", "images"}} {
		container, _ := metadata[section.container].(map[string]any)
		items, _ := container[section.list].([]any)
		for _, item := range items {
			m, _ := item.(map[string]any)
			key, _ := m["storageKey"].(string)
			bk, _ := m["storageBucket"].(string)
			if bk == "" {
				bk = bucket
			}
			add(bk, key)
		}
	}
	out := make([]generationObject, 0, len(refs))
	for _, ref := range refs {
		out = append(out, ref)
	}
	return out
}
func stripGenerationStorage(value any) {
	switch v := value.(type) {
	case map[string]any:
		for key, child := range v {
			switch key {
			case "storageKey", "storageBucket", "imageUrl", "imageFileId":
				delete(v, key)
			default:
				stripGenerationStorage(child)
			}
		}
	case []any:
		for _, child := range v {
			stripGenerationStorage(child)
		}
	}
}

// Only erase the projection after every unshared object is successfully
// removed; a failed S3 delete stays retryable and does not report success.
func (b *backend) purgeGenerationPhotos(ctx context.Context, userID, id, reason string, hours float64, maxCount int, now time.Time) (int, bool, error) {
	tx, err := b.db.Begin(ctx)
	if err != nil {
		return 0, false, err
	}
	defer rollback(tx)
	var bucket, key string
	var raw []byte
	err = tx.QueryRow(ctx, `SELECT COALESCE(storage_bucket,'generations'),COALESCE(storage_key,''),COALESCE(metadata,'{}'::json) FROM generation WHERE user_id=$1 AND id=$2 FOR UPDATE`, userID, id).Scan(&bucket, &key, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	m := map[string]any{}
	if json.Unmarshal(raw, &m) != nil || m == nil {
		m = map[string]any{}
	}
	refs := generationObjects(bucket, key, m)
	if len(refs) == 0 {
		return 0, false, nil
	}
	deleted := 0
	for _, ref := range refs {
		if !validStorageObjectPath(ref.bucket, ref.key) {
			return 0, false, invalid("Invalid generation storage reference")
		}
		var shared bool
		// Metadata can reference an output as another task's input. Keep those
		// objects until the last visible generation releases its reference.
		escaped := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(ref.key)
		err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM generation WHERE id<>$1 AND (storage_key=$2 AND storage_bucket=$3 OR (storage_key IS NOT NULL OR status='pending') AND metadata::text LIKE '%'||$4||'%') UNION ALL SELECT 1 FROM video_generation WHERE storage_key=$2 AND storage_bucket=$3 OR input_manifest::text LIKE '%'||$4||'%')`, id, ref.key, ref.bucket, escaped).Scan(&shared)
		if err != nil {
			return deleted, false, err
		}
		if shared {
			continue
		}
		if err = b.deleteStorageObject(ctx, ref.bucket, ref.key); err != nil {
			return deleted, false, err
		}
		deleted++
	}
	stripGenerationStorage(m)
	retention := map[string]any{"destroyedAt": now.UTC().Format(time.RFC3339Nano), "retentionHours": hours, "maxCount": maxCount, "reason": reason, "storageObjectsDeleted": deleted}
	out, _ := m["outputImage"].(map[string]any)
	if out == nil {
		out = map[string]any{}
	}
	out["photoRetention"] = retention
	m["outputImage"] = out
	if inputs, ok := m["inputImages"].(map[string]any); ok {
		inputs["photoRetention"] = retention
		if reason == "user_deleted" {
			inputs["images"] = []any{}
		}
	}
	_, err = tx.Exec(ctx, `UPDATE generation SET storage_key=NULL,file_size=NULL,metadata=$3::json WHERE id=$1 AND user_id=$2`, id, userID, mustJSON(m))
	if err != nil {
		return deleted, false, err
	}
	err = tx.Commit(ctx)
	return deleted, err == nil, err
}
