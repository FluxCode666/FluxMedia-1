package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const operationsExportColumns = `id,export_type,status,query,created_at,completed_at,expires_at,row_count,byte_count,error_code,retry_of_task_id`
const operationsExportCursorDomain = "fluxmedia:operations-export:list:v1"

type operationsExportSummary struct {
	ID            string          `json:"id"`
	ExportType    string          `json:"exportType"`
	Status        string          `json:"status"`
	Query         json.RawMessage `json:"query"`
	CreatedAt     time.Time       `json:"createdAt"`
	CompletedAt   *time.Time      `json:"completedAt"`
	ExpiresAt     *time.Time      `json:"expiresAt"`
	RowCount      *int64          `json:"rowCount"`
	ByteCount     *int64          `json:"byteCount"`
	ErrorCode     *string         `json:"errorCode"`
	RetryOfTaskID *string         `json:"retryOfTaskId"`
}

func scanOperationsExport(row interface{ Scan(...any) error }) (operationsExportSummary, error) {
	var task operationsExportSummary
	err := row.Scan(&task.ID, &task.ExportType, &task.Status, &task.Query, &task.CreatedAt, &task.CompletedAt, &task.ExpiresAt, &task.RowCount, &task.ByteCount, &task.ErrorCode, &task.RetryOfTaskID)
	return task, err
}

type operationsExportAuditDB interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

func operationsExportAudit(ctx context.Context, db operationsExportAuditDB, owner, action, task string, metadata map[string]any) error {
	_, err := db.Exec(ctx, `INSERT INTO admin_audit_log(id,admin_user_id,action,reason,after,metadata,created_at) VALUES($1,$2,$3,'运营数据导出',$4,$5,clock_timestamp())`, newRequestID(), nullableSettingActor(owner), action, map[string]any{"taskId": task}, metadata)
	return err
}

func operationsExportTypeValid(value string) bool {
	return value == "user_growth" || value == "commercialization" || value == "content_production"
}
func operationsExportIDValid(value string) bool { return value != "" && len(value) <= 255 }

func (b *backend) handleOperationsCreateExport(w http.ResponseWriter, r *http.Request) error {
	noStore(w)
	s, err := b.requireAdmin(r, false)
	if err != nil {
		return err
	}
	var in operationsExportInput
	if err = decodeBody(r, &in); err != nil {
		return err
	}
	in.ClientRequestID = strings.TrimSpace(in.ClientRequestID)
	if !operationsExportTypeValid(in.ExportType) || !operationsExportIDValid(in.ClientRequestID) {
		return invalid("运营导出参数无效")
	}
	in.Query, err = validateOperationsQuery(in.Query)
	if err != nil {
		return err
	}
	task, err := b.createOperationsExport(r.Context(), s.User.ID, in, "")
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"task": task})
	return nil
}

// Acquire session locks before beginning the repeatable-read transaction. A
// transaction snapshot acquired while waiting on an xact lock would miss the
// preceding creator and could exceed capacity or race its idempotency key.
func (b *backend) createOperationsExport(ctx context.Context, owner string, in operationsExportInput, retry string) (task operationsExportSummary, resultErr error) {
	id := newRequestID()
	defer func() {
		var e *apiError
		if errors.As(resultErr, &e) && (e.status == 429 || e.status == 409 || e.code == "NOT_READY") {
			action := "operations.rejectCreateExport"
			if retry != "" {
				action = "operations.rejectRetryExport"
			}
			code := e.code
			switch {
			case e.status == 429:
				code = "operations_export_rate_limited"
			case e.code == "NOT_READY":
				code = "operations_export_not_ready"
			case e.code == "CAPACITY_EXCEEDED":
				code = "operations_export_capacity_exceeded"
			}
			c, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			defer cancel()
			_ = operationsExportAudit(c, b.db, owner, action, id, map[string]any{"exportType": in.ExportType, "retryOfTaskId": nullableSettingActor(retry), "result": code})
		}
	}()
	conn, err := b.db.Acquire(ctx)
	if err != nil {
		return task, err
	}
	defer conn.Release()
	locks := []string{"operations-export:storage-config", "operations-export:global", "operations-export:" + owner}
	locked := 0
	defer func() {
		c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		for i := locked - 1; i >= 0; i-- {
			if _, e := conn.Exec(c, `SELECT pg_advisory_unlock(hashtext($1))`, locks[i]); e != nil {
				_ = conn.Conn().Close(c)
				break
			}
		}
	}()
	for _, key := range locks {
		if _, err = conn.Exec(ctx, `SELECT pg_advisory_lock(hashtext($1))`, key); err != nil {
			return task, err
		}
		locked++
	}
	tx, err := conn.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return task, err
	}
	defer rollback(tx)
	task, err = scanOperationsExport(tx.QueryRow(ctx, `SELECT `+operationsExportColumns+` FROM operations_export_task WHERE created_by=$1 AND client_request_id=$2`, owner, in.ClientRequestID))
	if err == nil {
		return task, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return task, err
	}
	zoneOverride := ""
	if retry != "" {
		var status string
		var raw []byte
		err = tx.QueryRow(ctx, `SELECT export_type,query,status,time_zone FROM operations_export_task WHERE id=$1 AND created_by=$2`, retry, owner).Scan(&in.ExportType, &raw, &status, &zoneOverride)
		if errors.Is(err, pgx.ErrNoRows) {
			return task, &apiError{404, "NOT_FOUND", "任务不存在"}
		}
		if err != nil {
			return task, err
		}
		if status != "failed" {
			return task, &apiError{409, "CONFLICT", "仅失败任务可重试"}
		}
		if err = json.Unmarshal(raw, &in.Query); err != nil {
			return task, err
		}
	}
	var mine, total int
	var limited bool
	err = tx.QueryRow(ctx, `SELECT count(*) FILTER(WHERE created_by=$1)::int,count(*)::int,(SELECT COALESCE(max(created_at)>transaction_timestamp()-interval '2 seconds',false) FROM operations_export_task WHERE created_by=$1) FROM operations_export_task WHERE status IN ('queued','running')`, owner).Scan(&mine, &total, &limited)
	if err != nil {
		return task, err
	}
	if mine >= 3 || total >= 100 {
		return task, &apiError{409, "CAPACITY_EXCEEDED", "运营导出队列已满，请稍后重试"}
	}
	if limited {
		return task, &apiError{429, "RATE_LIMITED", "运营导出创建过于频繁"}
	}
	now, epochDate, epochStart, zone, err := operationsSnapshotHeader(ctx, tx)
	if err != nil {
		return task, err
	}
	if zoneOverride != "" {
		zone = zoneOverride
	}
	rng, err := resolveOperationsRange(now, zone, epochDate, in.Query)
	if err != nil {
		return task, err
	}
	frozen := map[string]any{"granularity": rng["granularity"], "range": map[string]any{"kind": "custom", "from": rng["from"], "to": rng["to"]}}
	var watermarks []byte
	err = tx.QueryRow(ctx, operationsExportWatermarkSQL).Scan(&watermarks)
	if err != nil {
		return task, err
	}
	task, err = scanOperationsExport(tx.QueryRow(ctx, `INSERT INTO operations_export_task(id,created_by,client_request_id,export_type,status,query,time_zone,epoch_app_date,epoch_starts_at,snapshot_at,high_watermarks,retry_of_task_id,schema_version,created_at,updated_at) VALUES($1,$2,$3,$4,'queued',$5,$6,$7,$8,$9,$10,$11,1,$9,$9) RETURNING `+operationsExportColumns, id, owner, in.ClientRequestID, in.ExportType, frozen, zone, epochDate, epochStart, now, watermarks, nullableSettingActor(retry)))
	if err != nil {
		return task, err
	}
	action := "operations.createExport"
	if retry != "" {
		action = "operations.retryExport"
	}
	if err = operationsExportAudit(ctx, tx, owner, action, id, map[string]any{"exportType": in.ExportType, "query": frozen, "retryOfTaskId": nullableSettingActor(retry), "snapshotAt": operationsISO(now)}); err != nil {
		return task, err
	}
	return task, tx.Commit(ctx)
}

const operationsExportWatermarkSQL = `SELECT json_build_object(
'users',(SELECT json_build_object('createdAt',to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'id',id) FROM "user" ORDER BY created_at DESC,id DESC LIMIT 1),
'webVisits',(SELECT json_build_object('createdAt',to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'userId',user_id,'appDate',app_date) FROM user_web_visit ORDER BY created_at DESC,user_id DESC,app_date DESC LIMIT 1),
'outputs',(SELECT json_build_object('createdAt',to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'outputKind',output_kind,'sourceTaskId',source_task_id) FROM user_output_usage_event ORDER BY created_at DESC,output_kind DESC,source_task_id DESC LIMIT 1),
'paymentOrders',(SELECT json_build_object('createdAt',to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'id',id) FROM payment_order ORDER BY created_at DESC,id DESC LIMIT 1),
'paymentLifecycle',(SELECT json_build_object('recordedAt',to_char(recorded_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'id',id) FROM payment_lifecycle_event ORDER BY recorded_at DESC,id DESC LIMIT 1),
'creditContributions',(SELECT json_build_object('projectedAt',to_char(projected_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'transactionId',transaction_id) FROM credit_usage_projection_entry ORDER BY projected_at DESC,transaction_id DESC LIMIT 1))`

func (b *backend) handleOperationsRetryExport(w http.ResponseWriter, r *http.Request) error {
	noStore(w)
	s, err := b.requireAdmin(r, false)
	if err != nil {
		return err
	}
	var in struct {
		TaskID          string `json:"taskId"`
		ClientRequestID string `json:"clientRequestId"`
	}
	if err = decodeBody(r, &in); err != nil {
		return err
	}
	in.TaskID = strings.TrimSpace(in.TaskID)
	in.ClientRequestID = strings.TrimSpace(in.ClientRequestID)
	if !operationsExportIDValid(in.TaskID) || !operationsExportIDValid(in.ClientRequestID) {
		return invalid("运营导出重试参数无效")
	}
	task, err := b.createOperationsExport(r.Context(), s.User.ID, operationsExportInput{ClientRequestID: in.ClientRequestID}, in.TaskID)
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"task": task})
	return nil
}

type operationsExportCursor struct {
	Sub       string `json:"sub"`
	CreatedAt string `json:"createdAt"`
	ID        string `json:"id"`
}

func encodeOperationsExportCursor(c operationsExportCursor, secret string) string {
	raw, _ := json.Marshal(c)
	body := base64.RawURLEncoding.EncodeToString(raw)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(operationsExportCursorDomain + "\x00" + body))
	return body + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
func decodeOperationsExportCursor(token, owner, secret string) (operationsExportCursor, error) {
	var out operationsExportCursor
	p := strings.Split(token, ".")
	bad := invalid("运营导出列表游标无效")
	if len(p) != 2 || len(token) > 4096 || strings.TrimSpace(secret) == "" {
		return out, bad
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(operationsExportCursorDomain + "\x00" + p[0]))
	sig, e := base64.RawURLEncoding.DecodeString(p[1])
	if e != nil || !hmac.Equal(sig, mac.Sum(nil)) {
		return out, bad
	}
	raw, e := base64.RawURLEncoding.DecodeString(p[0])
	if e != nil {
		return out, bad
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if dec.Decode(&out) != nil || out.Sub != owner || out.ID == "" {
		return out, bad
	}
	if _, e = time.Parse(time.RFC3339Nano, out.CreatedAt); e != nil {
		return out, bad
	}
	return out, nil
}
func (b *backend) handleOperationsListExports(w http.ResponseWriter, r *http.Request) error {
	noStore(w)
	s, err := b.requireAdmin(r, false)
	if err != nil {
		return err
	}
	limit := 20
	for k := range r.URL.Query() {
		if k != "limit" && k != "cursor" {
			return invalid("运营导出列表参数无效")
		}
	}
	if raw := r.URL.Query().Get("limit"); raw != "" {
		limit, err = strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > 100 {
			return invalid("运营导出列表数量无效")
		}
	}
	where := "created_by=$1"
	args := []any{s.User.ID}
	if token := strings.TrimSpace(r.URL.Query().Get("cursor")); token != "" {
		c, e := decodeOperationsExportCursor(token, s.User.ID, b.config.authSecret)
		if e != nil {
			return e
		}
		stamp, _ := time.Parse(time.RFC3339Nano, c.CreatedAt)
		args = append(args, stamp, c.ID)
		where += " AND (created_at,id)<($2,$3)"
	}
	args = append(args, limit+1)
	rows, err := b.db.Query(r.Context(), `SELECT `+operationsExportColumns+` FROM operations_export_task WHERE `+where+` ORDER BY created_at DESC,id DESC LIMIT $`+strconv.Itoa(len(args)), args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	tasks := []operationsExportSummary{}
	extra := false
	for rows.Next() {
		task, e := scanOperationsExport(rows)
		if e != nil {
			return e
		}
		if len(tasks) == limit {
			extra = true
			break
		}
		tasks = append(tasks, task)
	}
	if err = rows.Err(); err != nil {
		return err
	}
	var next any
	if extra {
		last := tasks[len(tasks)-1]
		next = encodeOperationsExportCursor(operationsExportCursor{s.User.ID, operationsISO(last.CreatedAt), last.ID}, b.config.authSecret)
	}
	writeJSON(w, 200, map[string]any{"tasks": tasks, "nextCursor": next})
	return nil
}
