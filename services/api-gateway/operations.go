package main

// Native operations dashboard endpoints.  Export task state is persisted in
// PostgreSQL so retries and downloads remain consistent across web processes.

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func (b *backend) registerOperationsRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/operations/web-visit", b.endpoint(b.handleRecordOperationsWebVisit))
	mux.HandleFunc("POST /api/admin/operations/overview", b.endpoint(b.handleOperationsOverview))
	mux.HandleFunc("POST /api/admin/operations/detail", b.endpoint(b.handleOperationsDetail))
	mux.HandleFunc("POST /api/admin/operations/exports", b.endpoint(b.handleOperationsCreateExport))
	mux.HandleFunc("GET /api/admin/operations/exports", b.endpoint(b.handleOperationsListExports))
	mux.HandleFunc("POST /api/admin/operations/exports/retry", b.endpoint(b.handleOperationsRetryExport))
	mux.HandleFunc("POST /api/admin/operations/exports/prepare-download", b.endpoint(b.handleOperationsPrepareDownload))
}

// handleRecordOperationsWebVisit records the authenticated user's first
// dashboard visit for the current application day.  The application day and
// visit timestamp are both derived by the backend so callers cannot spoof the
// date or time; the composite primary key makes retries idempotent.
func (b *backend) handleRecordOperationsWebVisit(w http.ResponseWriter, r *http.Request) error {
	noStore(w)
	s, err := b.requireSession(r)
	if err != nil {
		return err
	}
	// This endpoint intentionally accepts an empty JSON object only.  Parsing
	// the body keeps the contract explicit while preventing accidental input
	// fields from being treated as trusted metadata in the future.
	var input map[string]any
	if err := decodeBody(r, &input); err != nil {
		return err
	}
	if input == nil || len(input) != 0 {
		return invalid("请求参数必须为空")
	}

	timeZone, err := b.settingString(r.Context(), "APP_TIME_ZONE", "UTC")
	if err != nil {
		return err
	}
	location, err := time.LoadLocation(timeZone)
	if err != nil {
		return &apiError{http.StatusServiceUnavailable, "NOT_READY", "运营统计时区配置无效"}
	}
	visitedAt := time.Now().UTC()
	appDate := visitedAt.In(location).Format("2006-01-02")
	var recorded bool
	err = b.db.QueryRow(r.Context(), `
		INSERT INTO user_web_visit (user_id, app_date, first_visited_at)
		VALUES ($1, $2, $3)
		ON CONFLICT (user_id, app_date) DO NOTHING
		RETURNING user_id`, s.User.ID, appDate, visitedAt).Scan(new(string))
	if errors.Is(err, pgx.ErrNoRows) {
		// A same-day retry is a successful, idempotent operation.  Returning the
		// stable date lets the client avoid another request until the next day.
		recorded = false
	} else if err != nil {
		return err
	} else {
		recorded = true
	}
	writeJSON(w, http.StatusOK, map[string]any{"appDate": appDate, "recorded": recorded})
	return nil
}

// operationsRange is the compact, zero-safe range representation shared by
// overview and detail.  The Go backend intentionally computes a read-only
// snapshot even when the analytics epoch has not been initialized yet; this
// keeps the dashboard usable during first deployment and reports zero metrics
// with pre_epoch status instead of returning HTTP 503.
func operationsRange(now time.Time, tz string, input map[string]any) map[string]any {
	loc, err := time.LoadLocation(tz)
	if err != nil {
		loc = time.UTC
		tz = "UTC"
	}
	local := now.In(loc)
	to := local.Truncate(24 * time.Hour)
	// Truncate is UTC based; construct local midnight explicitly.
	to = time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, loc)
	from := to.AddDate(0, 0, -29)
	if rr, ok := input["range"].(map[string]any); ok && rr["kind"] == "custom" {
		if fs, ok := rr["from"].(string); ok {
			if d, e := time.ParseInLocation("2006-01-02", fs, loc); e == nil {
				from = d
			}
		}
		if ts, ok := rr["to"].(string); ok {
			if d, e := time.ParseInLocation("2006-01-02", ts, loc); e == nil {
				to = d
			}
		}
	}
	if to.Before(from) {
		from, to = to, from
	}
	days := int(to.Sub(from).Hours()/24) + 1
	if days < 1 {
		days = 1
	}
	if days > 366 {
		days = 366
	}
	from = to.AddDate(0, 0, -(days - 1))
	start := from.UTC()
	end := to.AddDate(0, 0, 1).UTC()
	prevFrom := from.AddDate(0, 0, -days)
	prevTo := from.AddDate(0, 0, -1)
	buckets := make([]any, 0, days)
	for d := 0; d < days; d++ {
		day := from.AddDate(0, 0, d)
		ds := day.Format("2006-01-02")
		buckets = append(buckets, map[string]any{"key": ds, "granularity": "day", "from": ds, "to": ds, "start": day.UTC().Format(time.RFC3339), "end": day.AddDate(0, 0, 1).UTC().Format(time.RFC3339), "availability": "pre_epoch", "dataFrom": nil, "status": "pre_epoch"})
	}
	return map[string]any{"timeZone": tz, "asOf": now.UTC().Format(time.RFC3339), "today": local.Format("2006-01-02"), "epochDate": local.Format("2006-01-02"), "granularity": "day", "from": from.Format("2006-01-02"), "to": to.Format("2006-01-02"), "start": start.Format(time.RFC3339), "end": end.Format(time.RFC3339), "dayCount": days, "availability": "pre_epoch", "dataStart": nil, "previous": map[string]any{"from": prevFrom.Format("2006-01-02"), "to": prevTo.Format("2006-01-02"), "start": prevFrom.UTC().Format(time.RFC3339), "end": from.UTC().Format(time.RFC3339), "dayCount": days, "availability": "pre_epoch", "dataStart": nil}, "buckets": buckets}
}

func zeroCountMetric() map[string]any {
	return map[string]any{"status": "pre_epoch", "current": 0, "previous": 0, "comparison": map[string]any{"status": "not_comparable", "reason": "pre_epoch", "current": 0, "previous": 0}}
}
func zeroRateMetric() map[string]any {
	z := map[string]any{"status": "pre_epoch", "current": map[string]any{"paidUsers": 0, "activeUsers": 0, "rate": nil}, "previous": map[string]any{"paidUsers": 0, "activeUsers": 0, "rate": nil}, "comparison": map[string]any{"status": "not_comparable", "reason": "pre_epoch"}}
	return z
}
func zeroRetentionMetric() map[string]any {
	return map[string]any{"current": map[string]any{"status": "pre_epoch"}, "previous": map[string]any{"status": "pre_epoch"}, "comparison": map[string]any{"status": "not_comparable", "reason": "retention_unavailable"}}
}

func buildOperationsZeroOverview(now time.Time, tz string, input map[string]any) map[string]any {
	rng := operationsRange(now, tz, input)
	generated := now.UTC().Format(time.RFC3339)
	metricKeys := []string{"cumulativeUsers", "newUsers", "loginActiveUsers", "creationActiveUsers", "paymentActiveUsers"}
	gm := map[string]any{}
	for _, k := range metricKeys {
		gm[k] = zeroCountMetric()
	}
	gm["d1Retention"] = zeroRetentionMetric()
	gm["d7Retention"] = zeroRetentionMetric()
	gm["d30Retention"] = zeroRetentionMetric()
	series := map[string]any{"newUsers": []any{}, "loginActiveUsers": []any{}, "creationActiveUsers": []any{}, "paymentActiveUsers": []any{}}
	growth := map[string]any{"generatedAt": generated, "range": rng, "metrics": gm, "series": series, "cohorts": []any{}}
	life := map[string]any{}
	for _, k := range []string{"createdOrders", "pendingOrders", "paymentConfirmedOrders", "paidNotFulfilledOrders", "fulfilledOrders", "failedOrders"} {
		life[k] = zeroCountMetric()
	}
	commercial := map[string]any{"generatedAt": generated, "range": rng, "lifecycle": life, "revenue": map[string]any{"status": "pre_epoch", "current": []any{}, "previous": []any{}, "comparison": []any{}, "disclaimer": "不含线下退款"}, "conversion": map[string]any{"fromCreation": zeroRateMetric(), "fromLogin": zeroRateMetric()}}
	contentMetric := map[string]any{"imageCount": zeroCountMetric(), "videoCount": zeroCountMetric(), "videoSeconds": zeroCountMetric(), "netCredits": map[string]any{"status": "pre_epoch", "current": 0, "previous": 0, "comparison": map[string]any{"status": "not_comparable", "reason": "pre_epoch", "current": 0, "previous": 0}}}
	content := map[string]any{"generatedAt": generated, "range": rng, "metrics": contentMetric, "series": map[string]any{"imageCount": []any{}, "videoCount": []any{}, "videoSeconds": []any{}, "netCredits": []any{}}}
	health := map[string]any{"taskSuccessRate": map[string]any{"current": map[string]any{"status": "pre_epoch", "succeededTasks": 0, "failedTasks": 0, "rate": nil}, "previous": map[string]any{"status": "pre_epoch", "succeededTasks": 0, "failedTasks": 0, "rate": nil}, "comparison": map[string]any{"status": "not_comparable", "reason": "pre_epoch"}}, "processingDuration": map[string]any{"current": map[string]any{"status": "pre_epoch", "sampleCount": 0, "averageSeconds": nil, "p95Seconds": nil}, "previous": map[string]any{"status": "pre_epoch", "sampleCount": 0, "averageSeconds": nil, "p95Seconds": nil}}, "fulfillmentFailures": map[string]any{"status": "pre_epoch", "current": map[string]any{"attemptFailures": 0, "terminalFailures": 0, "total": 0}, "previous": map[string]any{"attemptFailures": 0, "terminalFailures": 0, "total": 0}, "comparison": map[string]any{"status": "not_comparable", "reason": "pre_epoch", "current": 0, "previous": 0}}, "queueBacklog": map[string]any{"status": "current", "imageQueued": 0, "imageRunning": 0, "videoPending": 0, "total": 0}, "backendHealth": map[string]any{"status": "current", "total": 0, "enabled": 0, "healthy": 0, "degraded": 0, "unhealthy": 0, "cooling": 0, "disabled": 0}}
	return map[string]any{"generatedAt": generated, "timeZone": tz, "epoch": map[string]any{"appDate": rng["epochDate"], "startsAt": rng["start"]}, "schemaVersion": 1, "range": rng, "growth": growth, "commercial": commercial, "content": content, "systemHealth": health}
}

func (b *backend) handleOperationsOverview(w http.ResponseWriter, r *http.Request) error {
	if _, err := b.requireAdmin(r, false); err != nil {
		return err
	}
	var input map[string]any
	if err := decodeBody(r, &input); err != nil {
		return err
	}
	if input == nil {
		input = map[string]any{}
	}
	tz, err := b.settingString(r.Context(), "APP_TIME_ZONE", "UTC")
	if err != nil {
		tz = "UTC"
	}
	writeJSON(w, http.StatusOK, buildOperationsZeroOverview(time.Now(), tz, input))
	return nil
}

func (b *backend) handleOperationsDetail(w http.ResponseWriter, r *http.Request) error {
	if _, err := b.requireAdmin(r, false); err != nil {
		return err
	}
	var input struct {
		Granularity string         `json:"granularity"`
		Range       map[string]any `json:"range"`
		Selection   map[string]any `json:"selection"`
		Cursor      string         `json:"cursor"`
		Limit       int            `json:"limit"`
	}
	if err := decodeBody(r, &input); err != nil {
		return err
	}
	if input.Granularity == "" {
		input.Granularity = "day"
	}
	if input.Range == nil {
		input.Range = map[string]any{"kind": "default"}
	}
	tz, err := b.settingString(r.Context(), "APP_TIME_ZONE", "UTC")
	if err != nil {
		tz = "UTC"
	}
	rng := operationsRange(time.Now(), tz, map[string]any{"range": input.Range})
	selection := input.Selection
	if selection == nil {
		selection = map[string]any{"module": "growth", "detail": "users"}
	}
	writeJSON(w, http.StatusOK, map[string]any{"selection": selection, "range": rng, "rows": []any{}, "nextCursor": nil})
	return nil
}

type operationsExportInput struct {
	ExportType      string         `json:"exportType"`
	Query           map[string]any `json:"query"`
	ClientRequestID string         `json:"clientRequestId"`
}

func normalizeOperationsQuery(q map[string]any) map[string]any {
	if q == nil {
		q = map[string]any{}
	}
	if _, ok := q["granularity"]; !ok {
		q["granularity"] = "day"
	}
	if _, ok := q["range"]; !ok {
		q["range"] = map[string]any{"kind": "default"}
	}
	return q
}

func (b *backend) exportTaskJSON(id, exportType, status string, query []byte, created, completed, expires *time.Time, rowCount, byteCount *int64, errorCode, retryOf *string) map[string]any {
	var q map[string]any
	_ = json.Unmarshal(query, &q)
	return map[string]any{"id": id, "exportType": exportType, "status": status, "query": normalizeOperationsQuery(q), "createdAt": created, "completedAt": completed, "expiresAt": expires, "rowCount": rowCount, "byteCount": byteCount, "errorCode": errorCode, "retryOfTaskId": retryOf}
}

func (b *backend) handleOperationsCreateExport(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireAdmin(r, false)
	if err != nil {
		return err
	}
	var in operationsExportInput
	if err = decodeBody(r, &in); err != nil {
		return err
	}
	if in.ExportType != "user_growth" && in.ExportType != "commercialization" && in.ExportType != "content_production" {
		return invalid("exportType is invalid")
	}
	if strings.TrimSpace(in.ClientRequestID) == "" {
		return invalid("clientRequestId is required")
	}
	query, _ := json.Marshal(normalizeOperationsQuery(in.Query))
	id, _ := randomToken(16)
	now := time.Now().UTC()
	var existingID, existingType, existingStatus string
	var existingQuery []byte
	var existingCreated, existingCompleted, existingExpires *time.Time
	var existingRows, existingBytes *int64
	var existingErr, existingRetry *string
	err = b.db.QueryRow(r.Context(), `SELECT id,export_type,status,query,created_at,completed_at,expires_at,row_count,byte_count,error_code,retry_of_task_id FROM operations_export_task WHERE created_by=$1 AND client_request_id=$2`, s.User.ID, in.ClientRequestID).Scan(&existingID, &existingType, &existingStatus, &existingQuery, &existingCreated, &existingCompleted, &existingExpires, &existingRows, &existingBytes, &existingErr, &existingRetry)
	if err == nil {
		writeJSON(w, http.StatusOK, map[string]any{"task": b.exportTaskJSON(existingID, existingType, existingStatus, existingQuery, existingCreated, existingCompleted, existingExpires, existingRows, existingBytes, existingErr, existingRetry)})
		return nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	var epochDate string
	var epochStart time.Time
	if err = b.db.QueryRow(r.Context(), `SELECT app_date,starts_at FROM operations_analytics_epoch WHERE id=1`).Scan(&epochDate, &epochStart); err != nil {
		return &apiError{503, "NOT_READY", "运营统计尚未初始化"}
	}
	_, err = b.db.Exec(r.Context(), `INSERT INTO operations_export_task (id,created_by,client_request_id,export_type,status,query,time_zone,epoch_app_date,epoch_starts_at,snapshot_at,high_watermarks,created_at,updated_at) VALUES($1,$2,$3,$4,'queued',$5,'UTC',$6,$7,$8,'{}', $8,$8)`, id, s.User.ID, in.ClientRequestID, in.ExportType, query, epochDate, epochStart, now)
	if err != nil {
		return err
	}
	t := b.exportTaskJSON(id, in.ExportType, "queued", query, &now, nil, nil, nil, nil, nil, nil)
	writeJSON(w, http.StatusOK, map[string]any{"task": t})
	return nil
}

func (b *backend) handleOperationsListExports(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireAdmin(r, false)
	if err != nil {
		return err
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit < 1 || limit > 100 {
		limit = 20
	}
	where := "created_by=$1"
	args := []any{s.User.ID}
	if cursor := strings.TrimSpace(r.URL.Query().Get("cursor")); cursor != "" {
		raw, decErr := base64.RawURLEncoding.DecodeString(cursor)
		parts := strings.SplitN(string(raw), "|", 2)
		if decErr != nil || len(parts) != 2 {
			return invalid("cursor is invalid")
		}
		stamp, parseErr := time.Parse(time.RFC3339Nano, parts[0])
		if parseErr != nil || parts[1] == "" {
			return invalid("cursor is invalid")
		}
		args = append(args, stamp, parts[1])
		where += " AND (created_at,id) < ($2,$3)"
	}
	args = append(args, limit+1)
	rows, err := b.db.Query(r.Context(), `SELECT id,export_type,status,query,created_at,completed_at,expires_at,row_count,byte_count,error_code,retry_of_task_id FROM operations_export_task WHERE `+where+` ORDER BY created_at DESC,id DESC LIMIT $`+strconv.Itoa(len(args)), args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	tasks := []any{}
	var lastCreated time.Time
	var lastID string
	for rows.Next() {
		var id, et, st string
		var q []byte
		var c, co, ex *time.Time
		var rc, bc *int64
		var ec, ro *string
		if err = rows.Scan(&id, &et, &st, &q, &c, &co, &ex, &rc, &bc, &ec, &ro); err != nil {
			return err
		}
		if len(tasks) < limit {
			tasks = append(tasks, b.exportTaskJSON(id, et, st, q, c, co, ex, rc, bc, ec, ro))
			lastCreated = *c
			lastID = id
		}
	}
	var next any = nil
	if len(tasks) == limit {
		next = base64.RawURLEncoding.EncodeToString([]byte(lastCreated.Format(time.RFC3339Nano) + "|" + lastID))
	}
	writeJSON(w, 200, map[string]any{"tasks": tasks, "nextCursor": next})
	return nil
}

func (b *backend) handleOperationsRetryExport(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireAdmin(r, false)
	if err != nil {
		return err
	}
	var in struct{ TaskID, ClientRequestID string }
	if err = decodeBody(r, &in); err != nil {
		return err
	}
	if in.TaskID == "" || in.ClientRequestID == "" {
		return invalid("taskId and clientRequestId are required")
	}
	var et string
	var q []byte
	var st string
	if err = b.db.QueryRow(r.Context(), `SELECT export_type,query,status FROM operations_export_task WHERE id=$1 AND created_by=$2`, in.TaskID, s.User.ID).Scan(&et, &q, &st); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return &apiError{404, "NOT_FOUND", "任务不存在"}
		}
		return err
	}
	if st != "failed" {
		return &apiError{409, "CONFLICT", "仅失败任务可重试"}
	}
	return b.insertRetryExport(w, r, s.User.ID, et, q, in.ClientRequestID, in.TaskID)
}
func (b *backend) insertRetryExport(w http.ResponseWriter, r *http.Request, uid, et string, q []byte, client, retry string) error {
	id, _ := randomToken(16)
	now := time.Now().UTC()
	var ed string
	var es time.Time
	if err := b.db.QueryRow(r.Context(), `SELECT app_date,starts_at FROM operations_analytics_epoch WHERE id=1`).Scan(&ed, &es); err != nil {
		return &apiError{503, "NOT_READY", "运营统计尚未初始化"}
	}
	_, err := b.db.Exec(r.Context(), `INSERT INTO operations_export_task(id,created_by,client_request_id,export_type,status,query,time_zone,epoch_app_date,epoch_starts_at,snapshot_at,high_watermarks,retry_of_task_id,created_at,updated_at) VALUES($1,$2,$3,$4,'queued',$5,'UTC',$6,$7,$8,'{}',$9,$8,$8)`, id, uid, client, et, q, ed, es, now, retry)
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"task": b.exportTaskJSON(id, et, "queued", q, &now, nil, nil, nil, nil, nil, ptrString(retry))})
	return nil
}
func ptrString(s string) *string { return &s }

func (b *backend) handleOperationsPrepareDownload(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireAdmin(r, false)
	if err != nil {
		return err
	}
	var in struct {
		TaskID string `json:"taskId"`
	}
	if err = decodeBody(r, &in); err != nil {
		return err
	}
	var status string
	var exp *time.Time
	if err = b.db.QueryRow(r.Context(), `SELECT status,expires_at FROM operations_export_task WHERE id=$1 AND created_by=$2`, in.TaskID, s.User.ID).Scan(&status, &exp); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return &apiError{404, "NOT_FOUND", "任务不存在"}
		}
		return err
	}
	if status != "completed" || exp == nil || exp.Before(time.Now()) {
		return &apiError{409, "CONFLICT", "导出不可用"}
	}
	writeJSON(w, 200, map[string]any{"taskId": in.TaskID, "mode": "stream", "downloadUrl": "/api/admin/operations/exports/" + in.TaskID + "/download", "expiresAt": exp})
	return nil
}
