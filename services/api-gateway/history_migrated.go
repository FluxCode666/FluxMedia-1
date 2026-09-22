package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/mail"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// The query contract is shared by personal and administrator history. Scope
// always comes from authentication; callers can only supply filters and paging.
type migratedHistoryInput struct {
	Cursor      *string `json:"cursor"`
	Page        int     `json:"page"`
	PageSize    int     `json:"pageSize"`
	CreatedFrom *string `json:"createdFrom"`
	CreatedTo   *string `json:"createdTo"`
	Model       *string `json:"model"`
	Status      *string `json:"status"`
	Type        *string `json:"type"`
	UserEmail   *string `json:"userEmail"`
}

func readHistoryInput(r *http.Request, admin bool) (migratedHistoryInput, error) {
	in := migratedHistoryInput{Page: 1, PageSize: 20}
	var raw map[string]json.RawMessage
	if err := decodeBody(r, &raw); err != nil {
		return in, err
	}
	if raw == nil {
		return in, invalid("历史查询必须是对象")
	}
	allowed := map[string]bool{"cursor": true, "page": true, "pageSize": true, "limit": true, "createdFrom": true, "createdTo": true, "model": true, "status": true, "type": true}
	if admin {
		allowed["userEmail"] = true
	}
	for key := range raw {
		if !allowed[key] {
			return in, invalid("历史查询包含未知字段")
		}
	}
	for key, target := range map[string]**string{"cursor": &in.Cursor, "createdFrom": &in.CreatedFrom, "createdTo": &in.CreatedTo, "model": &in.Model, "status": &in.Status, "type": &in.Type, "userEmail": &in.UserEmail} {
		if value, ok := raw[key]; ok && json.Unmarshal(value, target) != nil {
			return in, invalid("历史筛选无效")
		}
	}
	for key, target := range map[string]*int{"page": &in.Page, "pageSize": &in.PageSize} {
		if v, ok := raw[key]; ok {
			if string(v) == "null" || json.Unmarshal(v, target) != nil {
				return in, invalid("历史分页无效")
			}
		}
	}
	if v, ok := raw["limit"]; ok {
		var limit int
		if string(v) == "null" || json.Unmarshal(v, &limit) != nil || limit < 1 || limit > 50 {
			return in, invalid("limit 无效")
		}
		if _, exists := raw["pageSize"]; exists && in.PageSize != limit {
			return in, invalid("limit 与 pageSize 必须一致")
		}
		in.PageSize = limit
	}
	if in.Page < 1 || int64(in.Page) > 9007199254740991 || in.PageSize < 1 || in.PageSize > 50 {
		return in, invalid("历史分页无效")
	}
	if in.Cursor != nil && (*in.Cursor == "" || len(*in.Cursor) > 4096) {
		return in, invalid("历史游标无效")
	}
	if in.Model != nil {
		v := strings.TrimSpace(*in.Model)
		if v == "" || len([]rune(v)) > 240 {
			return in, invalid("历史模型无效")
		}
		v = historyRequestedModel(v)
		in.Model = &v
	}
	if in.Type != nil && *in.Type != "image" && *in.Type != "video" {
		return in, invalid("历史类型无效")
	}
	if in.Status != nil {
		switch *in.Status {
		case "processing", "queued", "in_progress", "completed", "failed":
		default:
			return in, invalid("历史状态无效")
		}
	}
	if in.UserEmail != nil {
		v := strings.TrimSpace(*in.UserEmail)
		addr, e := mail.ParseAddress(v)
		if e != nil || addr.Address != v || len(v) > 320 || !strings.Contains(v, ".") {
			return in, invalid("用户邮箱无效")
		}
		in.UserEmail = &v
	}
	for _, v := range []*string{in.CreatedFrom, in.CreatedTo} {
		if v != nil {
			d, e := time.Parse("2006-01-02", *v)
			if e != nil || d.Year() < 100 || d.Format("2006-01-02") != *v {
				return in, invalid("历史日期无效")
			}
		}
	}
	if in.CreatedFrom != nil && in.CreatedTo != nil && *in.CreatedFrom > *in.CreatedTo {
		return in, invalid("历史日期范围无效")
	}
	return in, nil
}

func historyDisplayModel(model string) string {
	v := strings.TrimSpace(model)
	if v == "" || len([]rune(v)) > 120 {
		return model
	}
	if strings.HasPrefix(strings.ToLower(v), "firefly-") {
		v = v[len("firefly-"):]
	}
	return v
}
func historyRequestedModel(model string) string {
	if len([]rune(model)) > 120 {
		return model
	}
	v := strings.ToLower(model)
	if _, ok := goVideoCapabilities[v]; ok {
		return v
	}
	base := strings.TrimPrefix(v, "firefly-")
	for id := range goVideoCapabilities {
		if strings.HasPrefix(base, id+"-") || base == id {
			return model
		}
	}
	return historyDisplayModel(model)
}

type historySortKey struct {
	CreatedAt time.Time `json:"createdAt"`
	KindRank  int       `json:"kindRank"`
	ID        string    `json:"id"`
}
type migratedCursor struct {
	V         int            `json:"v"`
	Sub       string         `json:"sub"`
	Filter    string         `json:"filter"`
	Direction string         `json:"direction"`
	Page      int            `json:"page"`
	PageSize  int            `json:"pageSize"`
	AsOf      time.Time      `json:"asOf"`
	SortKey   historySortKey `json:"sortKey"`
}

func historyDomain(admin bool, kind string) string {
	if admin {
		return "fluxmedia:admin-generation-history:" + kind + ":v1"
	}
	return "fluxmedia:generation-history:" + kind + ":v1"
}
func historyMAC(secret, domain, payload string) []byte {
	m := hmac.New(sha256.New, []byte(secret))
	_, _ = m.Write([]byte(domain + "\x00" + payload))
	return m.Sum(nil)
}
func historyFilter(in migratedHistoryInput, tz, secret string, admin bool) string {
	norm := map[string]any{"createdFrom": in.CreatedFrom, "createdTo": in.CreatedTo, "model": in.Model, "status": in.Status, "type": in.Type, "timeZone": tz}
	if admin {
		norm["userEmail"] = in.UserEmail
	}
	raw, _ := json.Marshal(norm)
	return base64.RawURLEncoding.EncodeToString(historyMAC(secret, historyDomain(admin, "filters"), string(raw)))
}
func signHistoryCursor(c migratedCursor, secret string, admin bool) string {
	raw, _ := json.Marshal(c)
	payload := base64.RawURLEncoding.EncodeToString(raw)
	return payload + "." + base64.RawURLEncoding.EncodeToString(historyMAC(secret, historyDomain(admin, "cursor"), payload))
}
func parseHistoryCursor(token, actor, filter, secret string, admin bool, page, pageSize int, now time.Time) (*migratedCursor, error) {
	bad := func() (*migratedCursor, error) { return nil, invalid("历史游标无效") }
	if len(token) > 4096 || strings.TrimSpace(secret) == "" {
		return bad()
	}
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return bad()
	}
	payload, e := base64.RawURLEncoding.Strict().DecodeString(parts[0])
	if e != nil || base64.RawURLEncoding.EncodeToString(payload) != parts[0] {
		return bad()
	}
	signature, e := base64.RawURLEncoding.Strict().DecodeString(parts[1])
	if e != nil || base64.RawURLEncoding.EncodeToString(signature) != parts[1] || !hmac.Equal(signature, historyMAC(secret, historyDomain(admin, "cursor"), parts[0])) {
		return bad()
	}
	var c migratedCursor
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&c) != nil {
		return bad()
	}
	var extra any
	if !errors.Is(decoder.Decode(&extra), io.EOF) {
		return bad()
	}
	if c.V != 1 || c.Sub != actor || len(c.Sub) > 512 || !hmac.Equal([]byte(c.Filter), []byte(filter)) || c.Page != page || c.PageSize != pageSize || c.Page < 1 || c.PageSize < 1 || c.PageSize > 50 || (c.Direction != "next" && c.Direction != "previous") || c.AsOf.IsZero() || c.AsOf.After(now) || c.SortKey.CreatedAt.IsZero() || c.SortKey.CreatedAt.After(c.AsOf) || c.SortKey.KindRank < 0 || c.SortKey.KindRank > 1 || c.SortKey.ID == "" || len(c.SortKey.ID) > 512 {
		return bad()
	}
	return &c, nil
}

func historyDateRange(in migratedHistoryInput, loc *time.Location) (start, end *time.Time) {
	if in.CreatedFrom != nil {
		d, _ := time.ParseInLocation("2006-01-02", *in.CreatedFrom, loc)
		v := d.UTC()
		start = &v
	}
	if in.CreatedTo != nil {
		d, _ := time.ParseInLocation("2006-01-02", *in.CreatedTo, loc)
		v := d.AddDate(0, 0, 1).UTC()
		end = &v
	}
	return
}

type historySQL struct{ args []any }

func (q *historySQL) bind(value any) string {
	q.args = append(q.args, value)
	return "$" + strconv.Itoa(len(q.args))
}

const historyVideoStatusSQL = `CASE WHEN v.status='completed' OR v.stage='completed' THEN 'completed' WHEN v.status='failed' OR v.stage IN ('failed','refunding') THEN 'failed' WHEN v.stage='created' AND v.capacity_wait_deadline_at IS NOT NULL THEN 'in_progress' WHEN v.stage IN ('created','charged') THEN 'queued' ELSE 'in_progress' END`
const historyImageStatusSQL = `CASE WHEN g.status='pending' THEN 'processing' ELSE g.status::text END`

// Both facts use the same predicates for their exact count and selected page.
// Keysets are added only to the list, never to its count or filter options.
func historyPredicates(q *historySQL, in migratedHistoryInput, actor string, admin bool, start, end *time.Time, asOf time.Time) (string, string) {
	img, vid := []string{}, []string{}
	both := func(suffix string) { img = append(img, "g."+suffix); vid = append(vid, "v."+suffix) }
	both("created_at <= " + q.bind(asOf))
	if !admin {
		both("user_id = " + q.bind(actor))
	}
	if start != nil {
		both("created_at >= " + q.bind(*start))
	}
	if end != nil {
		both("created_at < " + q.bind(*end))
	}
	if in.Model != nil {
		both("model = " + q.bind(*in.Model))
	}
	if admin && in.UserEmail != nil {
		v := "u.email = " + q.bind(*in.UserEmail)
		img = append(img, v)
		vid = append(vid, v)
	}
	if in.Type != nil {
		if *in.Type == "image" {
			vid = append(vid, "false")
		} else {
			img = append(img, "false")
		}
	}
	if in.Status != nil {
		s := q.bind(*in.Status)
		img = append(img, "("+historyImageStatusSQL+") = "+s)
		vid = append(vid, "("+historyVideoStatusSQL+") = "+s)
	}
	return strings.Join(img, " AND "), strings.Join(vid, " AND ")
}

type migratedHistRow struct {
	kind, id, userID, email, prompt, model, status                                  string
	revised, size, resolution, ratio, key, bucket, rawError, backendID, backendName *string
	duration                                                                        *int
	credits                                                                         float64
	audio                                                                           bool
	metadata, manifest                                                              []byte
	created                                                                         time.Time
	completed                                                                       *time.Time
}

func (x migratedHistRow) sortKey() historySortKey {
	rank := 0
	if x.kind == "image" {
		rank = 1
	}
	return historySortKey{CreatedAt: x.created.UTC(), KindRank: rank, ID: x.id}
}

// Select only metadata needed by the public projection. Credentials, request
// snapshots, private configuration and upstream response bodies stay in PG.
const historyImageMetadataSQL = `CASE WHEN g.metadata IS NULL THEN NULL ELSE jsonb_build_object(
 'billingGroupId',g.metadata::jsonb->'billingGroupId','mode',g.metadata::jsonb->'mode',
 'backend',jsonb_build_object('billingGroupId',g.metadata::jsonb#>'{backend,billingGroupId}'),
 'creditCost',g.metadata::jsonb->'creditCost','chatTextOnlyCharge',g.metadata::jsonb->'chatTextOnlyCharge',
 'outputImage',g.metadata::jsonb->'outputImage','moderationPromptRepair',g.metadata::jsonb->'moderationPromptRepair','inputImages',g.metadata::jsonb->'inputImages') END`
const historyVideoMetadataSQL = `jsonb_strip_nulls(jsonb_build_object('videoCapabilitySnapshot',v.metadata::jsonb->'videoCapabilitySnapshot','videoBillingSnapshot',v.metadata::jsonb->'videoBillingSnapshot'))`

func historyListSQL(q *historySQL, imgWhere, vidWhere string, cursor *migratedCursor, offset, pageSize int, admin bool) string {
	dir := "DESC"
	if cursor != nil {
		op := "<"
		if cursor.Direction == "previous" {
			op = ">"
			dir = "ASC"
		}
		ts, rank, id := q.bind(cursor.SortKey.CreatedAt), q.bind(cursor.SortKey.KindRank), q.bind(cursor.SortKey.ID)
		imgWhere += " AND (g.created_at,1,g.id) " + op + " (" + ts + "," + rank + "," + id + ")"
		vidWhere += " AND (v.created_at,0,v.id) " + op + " (" + ts + "," + rank + "," + id + ")"
	}
	imgID, imgName, vidID, vidName, imgJoin, vidJoin := "NULL::text", "NULL::text", "NULL::text", "NULL::text", "", ""
	if admin {
		imgID = `COALESCE(NULLIF(btrim(g.api_adapter_member_id),''),NULLIF(btrim(g.metadata::jsonb#>>'{backend,id}'),''))`
		vidID = `COALESCE(NULLIF(btrim(v.backend_member_id),''),NULLIF(btrim(v.api_adapter_member_id),''),NULLIF(btrim(v.metadata::jsonb#>>'{backend,id}'),''))`
		imgName = `COALESCE(NULLIF(btrim(g.metadata::jsonb#>>'{backend,name}'),''),a.name)`
		vidName = `COALESCE(NULLIF(btrim(v.metadata::jsonb#>>'{backend,name}'),''),a.name)`
		imgJoin = ` LEFT JOIN image_backend_member a ON a.id=` + imgID
		vidJoin = ` LEFT JOIN image_backend_member a ON a.id=` + vidID
	}
	branchLimit, limit, off := q.bind(offset+pageSize+1), q.bind(pageSize+1), q.bind(offset)
	return `WITH image_rows AS (SELECT 'image'::text kind,g.id,g.user_id,u.email,g.prompt,g.model,` + historyImageStatusSQL + ` status,g.credits_consumed,g.error,g.created_at,g.completed_at,g.revised_prompt,g.size,NULL::text resolution,NULL::int duration_seconds,NULL::text aspect_ratio,false generate_audio,g.storage_key,g.storage_bucket,` + historyImageMetadataSQL + ` metadata,NULL::jsonb input_manifest,` + imgID + ` backend_id,` + imgName + ` backend_name,1 kind_rank FROM generation g JOIN "user" u ON u.id=g.user_id` + imgJoin + ` WHERE ` + imgWhere + ` ORDER BY g.created_at ` + dir + `,g.id ` + dir + ` LIMIT ` + branchLimit + `), video_rows AS (SELECT 'video'::text,v.id,v.user_id,u.email,v.prompt,v.model,` + historyVideoStatusSQL + `,v.credits_consumed,v.error,v.created_at,v.completed_at,NULL::text,NULL::text,v.resolution,v.duration_seconds,v.aspect_ratio,CASE WHEN jsonb_typeof(v.metadata::jsonb->'generateAudio')='boolean' THEN (v.metadata::jsonb->>'generateAudio')::boolean ELSE false END,v.storage_key,v.storage_bucket,` + historyVideoMetadataSQL + `,v.input_manifest::jsonb,` + vidID + `,` + vidName + `,0 FROM video_generation v JOIN "user" u ON u.id=v.user_id` + vidJoin + ` WHERE ` + vidWhere + ` ORDER BY v.created_at ` + dir + `,v.id ` + dir + ` LIMIT ` + branchLimit + `) SELECT kind,id,user_id,email,prompt,model,status,credits_consumed,error,created_at,completed_at,revised_prompt,size,resolution,duration_seconds,aspect_ratio,generate_audio,storage_key,storage_bucket,metadata,input_manifest,backend_id,backend_name FROM (SELECT * FROM image_rows UNION ALL SELECT * FROM video_rows) records ORDER BY created_at ` + dir + `,kind_rank ` + dir + `,id ` + dir + ` LIMIT ` + limit + ` OFFSET ` + off
}

func readHistoryOptions(ctx context.Context, tx pgx.Tx, in migratedHistoryInput, actor string, admin bool) ([]string, []map[string]any, error) {
	q := &historySQL{}
	img, vid := "true", "true"
	if !admin {
		bind := q.bind(actor)
		img += " AND g.user_id=" + bind
		vid += " AND v.user_id=" + bind
	}
	if admin && in.UserEmail != nil {
		bind := q.bind(*in.UserEmail)
		img += " AND u.email=" + bind
		vid += " AND u.email=" + bind
	}
	if in.Type != nil {
		if *in.Type == "image" {
			vid = "false"
		} else {
			img = "false"
		}
	}
	rows, e := tx.Query(ctx, `SELECT model FROM (SELECT g.model FROM generation g JOIN "user" u ON u.id=g.user_id WHERE `+img+` AND NULLIF(btrim(g.model),'') IS NOT NULL UNION SELECT v.model FROM video_generation v JOIN "user" u ON u.id=v.user_id WHERE `+vid+` AND NULLIF(btrim(v.model),'') IS NOT NULL) models ORDER BY model LIMIT 200`, q.args...)
	if e != nil {
		return nil, nil, e
	}
	models := []string{}
	seen := map[string]bool{}
	for rows.Next() {
		var raw string
		if e = rows.Scan(&raw); e != nil {
			rows.Close()
			return nil, nil, e
		}
		m := historyDisplayModel(raw)
		if m != "" && !seen[m] {
			seen[m] = true
			models = append(models, m)
		}
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, nil, e
	}
	sort.Strings(models)
	users := []map[string]any{}
	if !admin {
		return models, users, nil
	}
	img, vid = `EXISTS(SELECT 1 FROM generation g WHERE g.user_id=u.id)`, `EXISTS(SELECT 1 FROM video_generation v WHERE v.user_id=u.id)`
	if in.Type != nil {
		if *in.Type == "image" {
			vid = "false"
		} else {
			img = "false"
		}
	}
	rows, e = tx.Query(ctx, `SELECT id,email FROM "user" u WHERE `+img+` OR `+vid+` ORDER BY email,id LIMIT 200`)
	if e != nil {
		return nil, nil, e
	}
	defer rows.Close()
	for rows.Next() {
		var id, email string
		if e = rows.Scan(&id, &email); e != nil {
			return nil, nil, e
		}
		users = append(users, map[string]any{"id": id, "email": strings.TrimSpace(email)})
	}
	return models, users, rows.Err()
}

func (b *backend) loadMigratedHistory(r *http.Request, in migratedHistoryInput, actor string, admin bool) (map[string]any, error) {
	secret := b.config.authSecret
	if strings.TrimSpace(secret) == "" {
		return nil, errors.New("history cursor signing secret is missing")
	}
	ctx := r.Context()
	tx, e := b.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if e != nil {
		return nil, e
	}
	defer rollback(tx)
	var userZone *string
	var appZone []byte
	if e = tx.QueryRow(ctx, `SELECT time_zone,(SELECT value FROM system_setting WHERE key='APP_TIME_ZONE') FROM "user" WHERE id=$1`, actor).Scan(&userZone, &appZone); e != nil {
		return nil, e
	}
	zone := "UTC"
	if fallback := strings.TrimSpace(os.Getenv("APP_TIME_ZONE")); fallback != "" {
		zone = fallback
	}
	if len(appZone) > 0 {
		var v string
		if json.Unmarshal(appZone, &v) != nil {
			return nil, errors.New("history application time zone is invalid")
		}
		zone = strings.TrimSpace(v)
	}
	if userZone != nil && strings.TrimSpace(*userZone) != "" {
		zone = strings.TrimSpace(*userZone)
	}
	loc, e := time.LoadLocation(zone)
	if e != nil {
		return nil, errors.New("history time zone is invalid")
	}
	start, end := historyDateRange(in, loc)
	asOf := time.Now().UTC()
	filter := historyFilter(in, zone, secret, admin)
	var cursor *migratedCursor
	if in.Cursor != nil {
		cursor, e = parseHistoryCursor(*in.Cursor, actor, filter, secret, admin, in.Page, in.PageSize, asOf)
		if e != nil {
			return nil, e
		}
		asOf = cursor.AsOf
		if start != nil && cursor.SortKey.CreatedAt.Before(*start) || end != nil && !cursor.SortKey.CreatedAt.Before(*end) {
			return nil, invalid("历史游标范围无效")
		}
	}
	q := &historySQL{}
	img, vid := historyPredicates(q, in, actor, admin, start, end, asOf)
	var total int
	if e = tx.QueryRow(ctx, `SELECT (SELECT count(*) FROM generation g JOIN "user" u ON u.id=g.user_id WHERE `+img+`)+(SELECT count(*) FROM video_generation v JOIN "user" u ON u.id=v.user_id WHERE `+vid+`)`, q.args...).Scan(&total); e != nil {
		return nil, e
	}
	page := in.Page
	offset := 0
	if cursor == nil {
		pages := (total + in.PageSize - 1) / in.PageSize
		if pages < 1 {
			pages = 1
		}
		if page > pages {
			page = pages
		}
		offset = (page - 1) * in.PageSize
	}
	query := historyListSQL(q, img, vid, cursor, offset, in.PageSize, admin)
	rows, e := tx.Query(ctx, query, q.args...)
	if e != nil {
		return nil, e
	}
	selected := []migratedHistRow{}
	for rows.Next() {
		var x migratedHistRow
		if e = rows.Scan(&x.kind, &x.id, &x.userID, &x.email, &x.prompt, &x.model, &x.status, &x.credits, &x.rawError, &x.created, &x.completed, &x.revised, &x.size, &x.resolution, &x.duration, &x.ratio, &x.audio, &x.key, &x.bucket, &x.metadata, &x.manifest, &x.backendID, &x.backendName); e != nil {
			rows.Close()
			return nil, e
		}
		selected = append(selected, x)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	hasExtra := len(selected) > in.PageSize
	if hasExtra {
		selected = selected[:in.PageSize]
	}
	previous := cursor != nil && cursor.Direction == "previous"
	if previous {
		for i, j := 0, len(selected)-1; i < j; i, j = i+1, j-1 {
			selected[i], selected[j] = selected[j], selected[i]
		}
	}
	records := make([]map[string]any, 0, len(selected))
	for _, x := range selected {
		record, e := projectMigratedHistory(x, admin)
		if e != nil {
			return nil, e
		}
		records = append(records, record)
	}
	if admin {
		if e = historySubmissionAttempts(ctx, tx, records); e != nil {
			return nil, e
		}
	}
	models, users, e := readHistoryOptions(ctx, tx, in, actor, admin)
	if e != nil {
		return nil, e
	}
	if e = tx.Commit(ctx); e != nil {
		return nil, e
	}
	out := map[string]any{"asOf": asOf.UTC().Format(time.RFC3339Nano), "page": page, "pageSize": in.PageSize, "totalCount": total, "records": records, "modelOptions": models, "nextCursor": nil, "previousCursor": nil}
	if admin {
		out["userOptions"] = users
	}
	canNext, canPrevious := hasExtra, cursor != nil || page > 1
	if previous {
		canNext = cursor != nil
		canPrevious = hasExtra
	}
	makeCursor := func(x migratedHistRow, direction string, targetPage int) string {
		return signHistoryCursor(migratedCursor{V: 1, Sub: actor, Filter: filter, Direction: direction, Page: targetPage, PageSize: in.PageSize, AsOf: asOf, SortKey: x.sortKey()}, secret, admin)
	}
	if len(selected) > 0 {
		if canNext {
			out["nextCursor"] = makeCursor(selected[len(selected)-1], "next", page+1)
		}
		if canPrevious && page > 1 {
			out["previousCursor"] = makeCursor(selected[0], "previous", page-1)
		}
	}
	return out, nil
}

func (b *backend) handleHistoryMigrated(w http.ResponseWriter, r *http.Request) error {
	noStore(w)
	s, e := b.requireSession(r)
	if e != nil {
		return e
	}
	actor := s.User.ID
	in, e := readHistoryInput(r, false)
	if e != nil {
		return e
	}
	out, e := b.loadMigratedHistory(r, in, actor, false)
	if e != nil {
		return e
	}
	writeJSON(w, 200, out)
	return nil
}
func (b *backend) handleAdminHistoryMigrated(w http.ResponseWriter, r *http.Request) error {
	noStore(w)
	s, e := b.requireSession(r)
	if e != nil {
		return e
	}
	switch s.User.Role {
	case "observer_admin", "admin", "super_admin":
	default:
		return forbidden()
	}
	in, e := readHistoryInput(r, true)
	if e != nil {
		return e
	}
	out, e := b.loadMigratedHistory(r, in, s.User.ID, true)
	if e != nil {
		return e
	}
	writeJSON(w, 200, out)
	return nil
}

func historySubmissionAttempts(ctx context.Context, tx pgx.Tx, records []map[string]any) error {
	ids := []string{}
	byID := map[string]map[string]any{}
	for _, record := range records {
		if record["kind"] == "video" {
			id := record["id"].(string)
			ids = append(ids, id)
			record["submissionAttempts"] = []map[string]any{}
			byID[id] = record
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, e := tx.Query(ctx, `SELECT video_generation_id,global_attempt_number,supplier_name_snapshot,failure_code,failure_reason,operations_reason,failed_at FROM video_generation_submission_attempt WHERE video_generation_id=ANY($1) AND failure_code IS NOT NULL ORDER BY video_generation_id,global_attempt_number`, ids)
	if e != nil {
		return e
	}
	defer rows.Close()
	for rows.Next() {
		var id, supplier, code, reason, ops string
		var number int
		var at time.Time
		if e = rows.Scan(&id, &number, &supplier, &code, &reason, &ops, &at); e != nil {
			return e
		}
		record := byID[id]
		attempts := record["submissionAttempts"].([]map[string]any)
		if len(attempts) >= 100 {
			return errors.New("history submission attempt limit exceeded")
		}
		record["submissionAttempts"] = append(attempts, map[string]any{"attemptNumber": number, "supplierName": strings.TrimSpace(supplier), "failureCode": code, "failureReason": reason, "operationsReason": ops, "failedAt": at.UTC().Format(time.RFC3339Nano)})
	}
	return rows.Err()
}

func projectMigratedHistory(x migratedHistRow, admin bool) (map[string]any, error) {
	if x.credits < 0 || math.IsNaN(x.credits) || math.IsInf(x.credits, 0) {
		return nil, errors.New("invalid history credits")
	}
	meta := map[string]any{}
	if len(x.metadata) > 0 && string(x.metadata) != "null" {
		if e := json.Unmarshal(x.metadata, &meta); e != nil {
			return nil, e
		}
	}
	record := map[string]any{"kind": x.kind, "id": x.id, "prompt": x.prompt, "model": historyDisplayModel(x.model), "status": x.status, "creditsConsumed": x.credits, "error": x.rawError, "createdAt": x.created.UTC().Format(time.RFC3339Nano), "completedAt": nil, "processingDurationSeconds": nil}
	if x.completed != nil {
		record["completedAt"] = x.completed.UTC().Format(time.RFC3339Nano)
		record["processingDurationSeconds"] = int(math.Max(0, math.Round(x.completed.Sub(x.created).Seconds())))
	}
	if admin {
		record["userId"] = x.userID
		record["userEmail"] = strings.TrimSpace(x.email)
		record["backendAccount"] = nil
		if x.backendID != nil && *x.backendID != "" {
			record["backendAccount"] = map[string]any{"id": *x.backendID, "name": historyTrimmed(x.backendName, 240)}
		}
	}
	if x.kind == "image" {
		if x.size == nil || *x.size == "" {
			return nil, errors.New("history image size is missing")
		}
		record["size"] = *x.size
		record["revisedPrompt"] = x.revised
		record["imageUrl"] = generationURL(x.key, x.bucket)
		record["creditDetails"] = nil
		if len(x.metadata) > 0 && string(x.metadata) != "null" {
			record["creditDetails"] = historyCreditDetails(meta, x.credits)
		}
		record["referenceImages"] = historyReferenceImages(meta)
		record["promptRepairNotice"] = nil
		repair := metadataMap(meta["moderationPromptRepair"])
		if repair["succeeded"] == true {
			notice := historyString(repair["notice"])
			if notice == nil {
				v := "The original prompt was rejected by safety checks, so this request was generated after additional prompt adjustments."
				notice = &v
			}
			record["promptRepairNotice"] = notice
		}
		return record, nil
	}
	if x.resolution == nil || *x.resolution == "" || x.ratio == nil || *x.ratio == "" || x.duration == nil || *x.duration < 1 {
		return nil, errors.New("history video details are incomplete")
	}
	manifest := map[string]any{}
	if len(x.manifest) > 0 && string(x.manifest) != "null" {
		if e := json.Unmarshal(x.manifest, &manifest); e != nil {
			return nil, e
		}
	}
	input, e := historyVideoInputSummary(manifest)
	if e != nil {
		return nil, e
	}
	billing, e := historyVideoBilling(meta, x.credits)
	if e != nil {
		return nil, e
	}
	record["resolution"] = *x.resolution
	record["duration"] = *x.duration
	record["aspectRatio"] = *x.ratio
	record["generateAudio"] = x.audio
	record["input"] = input
	record["billing"] = billing
	record["videoUrl"] = generationURL(x.key, x.bucket)
	return record, nil
}

func historyTrimmed(value *string, limit int) *string {
	if value == nil {
		return nil
	}
	v := strings.TrimSpace(*value)
	if v == "" {
		return nil
	}
	r := []rune(v)
	if len(r) > limit {
		v = string(r[:limit])
	}
	return &v
}
func historyString(value any) *string {
	v, ok := value.(string)
	if !ok || strings.TrimSpace(v) == "" {
		return nil
	}
	v = strings.TrimSpace(v)
	return &v
}
func historyNumber(value any) *float64 {
	var n float64
	switch v := value.(type) {
	case float64:
		n = v
	case string:
		var e error
		n, e = strconv.ParseFloat(strings.TrimSpace(v), 64)
		if e != nil {
			return nil
		}
	default:
		return nil
	}
	if math.IsNaN(n) || math.IsInf(n, 0) {
		return nil
	}
	return &n
}
func historyFirstNumber(values ...*float64) *float64 {
	for _, v := range values {
		if v != nil {
			return v
		}
	}
	return nil
}
func historySumCosts(value any, key string) *float64 {
	values, ok := value.([]any)
	if !ok {
		return nil
	}
	total := 0.0
	found := false
	for _, v := range values {
		n := historyNumber(metadataMap(v)[key])
		if n != nil {
			total += *n
			found = true
		}
	}
	if !found {
		return nil
	}
	total = math.Round(total*100) / 100
	return &total
}
func historyCreditDetails(meta map[string]any, actual float64) map[string]any {
	backend, output, cost, chat := metadataMap(meta["backend"]), metadataMap(meta["outputImage"]), metadataMap(meta["creditCost"]), metadataMap(meta["chatTextOnlyCharge"])
	requested, settled := metadataMap(output["requestedCreditCost"]), metadataMap(output["actualCreditCost"])
	perOutput := output["perOutputCreditCosts"]
	rounds, roundPrice := historyFirstNumber(historyNumber(output["chatRoundCount"]), historyNumber(chat["chatRoundCount"])), historyFirstNumber(historyNumber(output["chatRoundCredits"]), historyNumber(chat["chatRoundCredits"]))
	chatCredits := historyNumber(chat["credits"])
	if chatCredits == nil && rounds != nil && roundPrice != nil {
		n := math.Round(*rounds**roundPrice*100) / 100
		chatCredits = &n
	}
	group := historyString(meta["billingGroupId"])
	if group == nil {
		group = historyString(backend["billingGroupId"])
	}
	out := map[string]any{"actualImageCredits": historyFirstNumber(historySumCosts(perOutput, "totalCredits"), historyNumber(settled["totalCredits"])), "actualSize": historyString(output["actualSize"]), "billingGroupId": group, "chatCredits": chatCredits, "chatRoundCount": rounds, "chatRoundCredits": roundPrice, "mode": historyString(meta["mode"]), "requestedResolution": historyString(output["requestedResolution"]), "requestedSize": historyString(output["requestedSize"]), "requestedTotalCredits": historyFirstNumber(historyNumber(requested["totalCredits"]), historyNumber(cost["totalCredits"])), "totalCredits": actual, "settledResolution": historyString(output["settledResolution"]), "billableImageOutputCount": historyNumber(output["billableImageOutputCount"]), "upstreamImageOutputCount": historyNumber(output["upstreamImageOutputCount"])}
	for _, key := range []string{"baseCredits", "moderationCredits", "imageModerationCount", "textModerationCount"} {
		out[key] = historyFirstNumber(historySumCosts(perOutput, key), historyNumber(settled[key]), historyNumber(cost[key]))
	}
	return out
}
func historyReferenceImages(meta map[string]any) []map[string]any {
	result := []map[string]any{}
	input := metadataMap(meta["inputImages"])
	images, _ := input["images"].([]any)
	for fallback, value := range images {
		item, ok := value.(map[string]any)
		if !ok {
			continue
		}
		key, bucket := historyString(item["storageKey"]), historyString(item["storageBucket"])
		imageURL := generationURL(key, bucket)
		if imageURL == nil {
			imageURL = historyString(item["imageUrl"])
		}
		if imageURL == nil {
			continue
		}
		index := fallback
		if n, ok := item["index"].(float64); ok && n >= 0 && math.Trunc(n) == n {
			index = int(n)
		}
		id := historyString(item["id"])
		if id == nil {
			v := fmt.Sprintf("input-%d", index+1)
			id = &v
		}
		source, role := "upload", "reference"
		if v := historyString(item["source"]); v != nil {
			source = *v
		}
		if v := historyString(item["role"]); v != nil {
			role = *v
		}
		var size *float64
		if n, ok := item["sizeBytes"].(float64); ok && n >= 0 && !math.IsInf(n, 0) && !math.IsNaN(n) {
			size = &n
		}
		result = append(result, map[string]any{"id": *id, "imageUrl": *imageURL, "name": historyString(item["name"]), "type": historyString(item["type"]), "sizeBytes": size, "source": source, "role": role, "index": index})
		if len(result) == 50 {
			break
		}
	}
	return result
}

func historyVideoInputSummary(manifest map[string]any) (map[string]any, error) {
	counts := map[string]int{}
	total := 0
	totalBytes := 0.0
	validate := func(value any, key string) error {
		ref, ok := value.(map[string]any)
		if !ok {
			return errors.New("invalid history video reference")
		}
		for field := range ref {
			switch field {
			case "source", "mimeType", "storageKey", "storageBucket", "byteLength":
			default:
				return errors.New("unknown history video reference field")
			}
		}
		storageKey, bucket, mime := stringValue(ref["storageKey"]), stringValue(ref["storageBucket"]), stringValue(ref["mimeType"])
		n, ok := ref["byteLength"].(float64)
		if ref["source"] != "storage" || storageKey == "" || len(storageKey) > 1024 || strings.HasPrefix(storageKey, "/") || bucket == "" || len(bucket) > 128 || !ok || n < 1 || math.Trunc(n) != n || n > 200*1024*1024 {
			return errors.New("invalid history persisted video reference")
		}
		for _, segment := range strings.Split(storageKey, "/") {
			if segment == ".." {
				return errors.New("invalid history storage key")
			}
		}
		valid := mime == "image/png" || mime == "image/jpeg" || mime == "image/webp"
		if key == "referenceVideos" {
			valid = mime == "video/mp4" || mime == "video/quicktime"
		}
		if key == "referenceAudios" {
			valid = (mime == "audio/mpeg" || mime == "audio/wav" || mime == "audio/x-wav") && n <= 15*1024*1024
		}
		if !valid {
			return errors.New("invalid history video reference MIME")
		}
		totalBytes += n
		return nil
	}
	for key, value := range manifest {
		switch key {
		case "firstFrame", "lastFrame":
			if e := validate(value, key); e != nil {
				return nil, e
			}
			counts[key] = 1
		case "referenceImages", "referenceVideos", "referenceAudios":
			values, ok := value.([]any)
			if !ok || len(values) == 0 {
				return nil, errors.New("invalid history video references")
			}
			counts[key] = len(values)
			for _, ref := range values {
				if e := validate(ref, key); e != nil {
					return nil, e
				}
			}
		default:
			return nil, errors.New("unknown history video input")
		}
		total += counts[key]
	}
	if total > 256 {
		return nil, errors.New("history input count exceeds limit")
	}
	frames := counts["firstFrame"] + counts["lastFrame"]
	if totalBytes > 512*1024*1024 || counts["referenceVideos"] > 3 || counts["referenceAudios"] > 1 || counts["lastFrame"] > 0 && counts["firstFrame"] == 0 || frames > 0 && frames < total {
		return nil, errors.New("invalid history video input combination")
	}
	mode := "mixed"
	switch {
	case total == 0:
		mode = "none"
	case counts["referenceVideos"] == total:
		mode = "reference-videos"
	case counts["referenceAudios"] == total:
		mode = "reference-audio"
	case counts["referenceImages"] == total:
		mode = "references"
	case frames == 2 && total == 2:
		mode = "first-last-frames"
	case frames == 1 && total == 1:
		mode = "first-frame"
	}
	return map[string]any{"mode": mode, "count": total}, nil
}

var historyCanonicalModel = regexp.MustCompile(`^[a-z0-9][a-z0-9._:-]*$`)

func historyVideoBilling(meta map[string]any, actual float64) (map[string]any, error) {
	capValue, capPresent := meta["videoCapabilitySnapshot"]
	snapshot, snapshotPresent := meta["videoBillingSnapshot"]
	cap := metadataMap(capValue)
	if !capPresent && !snapshotPresent || cap["version"] == float64(1) && (!snapshotPresent || snapshot == nil) {
		return videoUOLBilling(actual), nil
	}
	bad := func() (map[string]any, error) {
		return nil, errors.New("invalid persisted history video billing snapshot")
	}
	if cap["version"] != float64(2) {
		return bad()
	}
	s, ok := snapshot.(map[string]any)
	if !ok {
		return bad()
	}
	model, resolution, mode, unit, group, digest := stringValue(s["modelId"]), stringValue(s["resolution"]), stringValue(s["mode"]), stringValue(s["unit"]), stringValue(s["billingGroupId"]), stringValue(s["digest"])
	price, pok := s["unitPrice"].(float64)
	duration, dok := s["durationSeconds"].(float64)
	quoted, qok := s["quotedCredits"].(float64)
	if s["version"] != float64(1) || !historyCanonicalModel.MatchString(model) || resolution == "" || group == "" || !pok || !dok || !qok || price <= 0 || price > 100000 || duration < 1 || math.Trunc(duration) != duration || quoted <= 0 {
		return bad()
	}
	expected := price
	if mode == "per_second" && unit == "second" {
		expected = price * duration
	} else if mode != "per_item" || unit != "item" {
		return bad()
	}
	expected = math.Ceil(math.Round(expected*1000000)/10000-1e-9) / 100
	if math.Abs(quoted-expected) > 1e-9 {
		return bad()
	}
	// Ordered JSON exactly matches the immutable snapshot contract in TS.
	payload := struct {
		Version         int     `json:"version"`
		ModelID         string  `json:"modelId"`
		Resolution      string  `json:"resolution"`
		Mode            string  `json:"mode"`
		Unit            string  `json:"unit"`
		UnitPrice       float64 `json:"unitPrice"`
		DurationSeconds float64 `json:"durationSeconds"`
		QuotedCredits   float64 `json:"quotedCredits"`
		BillingGroupID  string  `json:"billingGroupId"`
	}{1, model, resolution, mode, unit, price, duration, quoted, group}
	var encoded bytes.Buffer
	encoder := json.NewEncoder(&encoded)
	encoder.SetEscapeHTML(false)
	if encoder.Encode(payload) != nil {
		return bad()
	}
	sum := sha256.Sum256(bytes.TrimSuffix(encoded.Bytes(), []byte("\n")))
	if digest != "" {
		if len(s) != 10 || fmt.Sprintf("%x", sum) != digest {
			return bad()
		}
	} else {
		// Early Go tasks stored this explicit format before the canonical
		// digest field was restored. Validate its pinned pricing facts without
		// relabeling them legacy or looking up mutable current prices.
		revision, ok := s["modelConfigurationRevision"].(float64)
		source := stringValue(s["priceSource"])
		if len(s) != 11 || !ok || revision < 0 || math.Trunc(revision) != revision || (source != "group_model" && source != "group_resolution" && source != "global_resolution") {
			return bad()
		}
	}
	result := map[string]any{"kind": "snapshot", "mode": mode, "unit": unit, "unitPrice": price, "durationSeconds": duration, "quotedCredits": quoted, "actualCredits": actual}
	if mode == "per_second" {
		result["creditsPerSecond"] = price
	}
	return result, nil
}
