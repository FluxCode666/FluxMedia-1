package main

// Native operations dashboard endpoints.  Export task state is persisted in
// PostgreSQL so retries and downloads remain consistent across web processes.

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func (b *backend) registerOperationsRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/operations/web-visit", b.endpoint(b.handleRecordOperationsWebVisit))
	mux.HandleFunc("POST /api/operations/ensure-epoch", b.endpoint(b.handleEnsureOperationsEpoch))
	mux.HandleFunc("POST /api/admin/operations/overview", b.endpoint(b.handleOperationsOverviewMigrated))
	mux.HandleFunc("POST /api/admin/operations/detail", b.endpoint(b.handleOperationsDetailMigrated))
	mux.HandleFunc("POST /api/admin/operations/exports", b.endpoint(b.handleOperationsCreateExport))
	mux.HandleFunc("GET /api/admin/operations/exports", b.endpoint(b.handleOperationsListExports))
	mux.HandleFunc("POST /api/admin/operations/exports/retry", b.endpoint(b.handleOperationsRetryExport))
	mux.HandleFunc("POST /api/admin/operations/exports/prepare-download", b.endpoint(b.handleOperationsPrepareDownload))
	mux.HandleFunc("POST /api/jobs/operations/exports/process", b.endpoint(b.handleOperationsProcessExportsJob))
	mux.HandleFunc("POST /api/jobs/operations/exports/expire", b.endpoint(b.handleOperationsExpireExportsJob))
}

// handleEnsureOperationsEpoch is the Go-owned deployment gate for the
// immutable operations analytics epoch.  It is cron-secret protected because
// deployment runs outside a browser session; the supplied identity is only
// audit metadata and never controls the derived date or timestamp.
func (b *backend) handleEnsureOperationsEpoch(w http.ResponseWriter, r *http.Request) error {
	if !b.cronAuthorized(r) {
		return &apiError{http.StatusUnauthorized, "UNAUTHORIZED", "Unauthorized"}
	}
	var input struct {
		InitializedBy string `json:"initializedBy"`
	}
	if err := decodeBody(r, &input); err != nil {
		return err
	}
	initializedBy := strings.TrimSpace(input.InitializedBy)
	if initializedBy == "" || len(initializedBy) > 200 {
		return invalid("initializedBy is required")
	}
	tx, err := b.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer rollback(tx)
	if _, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock($1)`, int64(6799527419)); err != nil {
		return err
	}
	var appDate string
	var startsAt time.Time
	initialized := false
	err = tx.QueryRow(r.Context(), `SELECT app_date,starts_at FROM operations_analytics_epoch WHERE id=1`).Scan(&appDate, &startsAt)
	if errors.Is(err, pgx.ErrNoRows) {
		tz, tzErr := b.settingString(r.Context(), "APP_TIME_ZONE", "UTC")
		if tzErr != nil {
			return tzErr
		}
		loc, tzErr := time.LoadLocation(tz)
		if tzErr != nil {
			return &apiError{http.StatusServiceUnavailable, "NOT_READY", "运营统计时区配置无效"}
		}
		now := time.Now().UTC()
		local := now.In(loc)
		appDate = local.Format("2006-01-02")
		startsAt = time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, loc).UTC()
		requestID := "operations-epoch-" + appDate
		if _, err = tx.Exec(r.Context(), `INSERT INTO operations_analytics_epoch(id,app_date,starts_at,initialized_by,initialization_request_id,created_at) VALUES(1,$1,$2,$3,$4,$5)`, appDate, startsAt, initializedBy, requestID, now); err != nil {
			return err
		}
		if _, err = tx.Exec(r.Context(), `INSERT INTO admin_audit_log(id,admin_user_id,target_user_id,action,reason,before,after,metadata,created_at) VALUES($1,NULL,NULL,'operations.ensureCurrentEpoch','自动初始化运营总览生产统计起点',NULL,$2,$3,$4)`, newRequestID(), map[string]any{"appDate": appDate, "startsAt": startsAt.Format(time.RFC3339)}, map[string]any{"initializedBy": initializedBy, "requestId": requestID}, now); err != nil {
			return err
		}
		initialized = true
	} else if err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"appDate": appDate, "startsAt": startsAt.Format(time.RFC3339), "initialized": initialized})
	return nil
}

// handleOperationsProcessExportsJob is the Go-owned scheduler boundary. The
// durable worker is intentionally idempotent; when no claimable task exists
// this returns zero without involving the Next.js process.
func (b *backend) handleOperationsProcessExportsJob(w http.ResponseWriter, r *http.Request) error {
	if !b.cronAuthorized(r) {
		return &apiError{http.StatusUnauthorized, "UNAUTHORIZED", "Unauthorized"}
	}
	var input struct {
		Limit int `json:"limit"`
	}
	if err := decodeBody(r, &input); err != nil {
		return err
	}
	if input.Limit < 1 || input.Limit > 100 {
		input.Limit = 10
	}
	processed, err := b.processOperationsExports(r.Context(), input.Limit)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"processed": processed})
	return nil
}

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

func operationsCountMetricFor(current, previous int, available, previousAvailable bool) map[string]any {
	status := "value"
	if !available {
		status = "pre_epoch"
	}
	comparison := map[string]any{"status": "not_comparable", "reason": "pre_epoch", "current": current, "previous": previous}
	if available && previousAvailable {
		if previous > 0 {
			comparison = map[string]any{"status": "value", "current": current, "previous": previous, "changePercent": (float64(current-previous) / float64(previous)) * 100}
		} else {
			comparison["reason"] = "zero_previous"
		}
	}
	return map[string]any{"status": status, "current": current, "previous": previous, "comparison": comparison}
}

type operationsExportInput struct {
	ExportType      string         `json:"exportType"`
	Query           map[string]any `json:"query"`
	ClientRequestID string         `json:"clientRequestId"`
}
