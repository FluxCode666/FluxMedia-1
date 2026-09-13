package main

// Native operations dashboard endpoints.  Export task state is persisted in
// PostgreSQL so retries and downloads remain consistent across web processes.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
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
	granularity := "day"
	if g, ok := input["granularity"].(string); ok && (g == "day" || g == "week" || g == "month") {
		granularity = g
	}
	start := from.UTC()
	end := to.AddDate(0, 0, 1).UTC()
	prevFrom := from.AddDate(0, 0, -days)
	prevTo := from.AddDate(0, 0, -1)
	buckets := make([]any, 0, days)
	for d := 0; d < days; d++ {
		day := from.AddDate(0, 0, d)
		ds := day.Format("2006-01-02")
		buckets = append(buckets, map[string]any{"key": ds, "granularity": "day", "from": ds, "to": ds, "start": day.UTC().Format(time.RFC3339), "end": day.AddDate(0, 0, 1).UTC().Format(time.RFC3339), "availability": "pre_epoch", "dataFrom": nil})
	}
	return map[string]any{"timeZone": tz, "asOf": now.UTC().Format(time.RFC3339), "today": local.Format("2006-01-02"), "epochDate": local.Format("2006-01-02"), "granularity": granularity, "from": from.Format("2006-01-02"), "to": to.Format("2006-01-02"), "start": start.Format(time.RFC3339), "end": end.Format(time.RFC3339), "dayCount": days, "availability": "pre_epoch", "dataStart": nil, "previous": map[string]any{"from": prevFrom.Format("2006-01-02"), "to": prevTo.Format("2006-01-02"), "start": prevFrom.UTC().Format(time.RFC3339), "end": from.UTC().Format(time.RFC3339), "dayCount": days, "availability": "pre_epoch", "dataStart": nil}, "buckets": buckets}
}

// applyOperationsEpoch overlays the immutable analytics epoch on a resolved
// range.  This keeps all overview modules on the same availability semantics
// and avoids reporting real values for dates that predate the migration.
func (b *backend) applyOperationsEpoch(ctx context.Context, rng map[string]any) error {
	var epochDate string
	var epochStart time.Time
	if err := b.db.QueryRow(ctx, `SELECT app_date,starts_at FROM operations_analytics_epoch WHERE id=1`).Scan(&epochDate, &epochStart); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	}
	rng["epochDate"] = epochDate
	rng["epochStartsAt"] = epochStart.Format(time.RFC3339)
	start, _ := time.Parse(time.RFC3339, fmt.Sprint(rng["start"]))
	end, _ := time.Parse(time.RFC3339, fmt.Sprint(rng["end"]))
	prev, _ := rng["previous"].(map[string]any)
	prevStart, _ := time.Parse(time.RFC3339, fmt.Sprint(prev["start"]))
	availableStart := epochStart
	if start.After(availableStart) {
		availableStart = start
	}
	if !availableStart.Before(end) {
		rng["availability"] = "pre_epoch"
		rng["dataStart"] = nil
	} else if start.Before(epochStart) {
		rng["availability"] = "partial_epoch"
		rng["dataStart"] = epochStart.Format(time.RFC3339)
	} else {
		rng["availability"] = "available"
		rng["dataStart"] = start.Format(time.RFC3339)
	}
	if prev != nil {
		if prevStart.Before(epochStart) {
			prev["availability"] = "pre_epoch"
			prev["dataStart"] = nil
		} else {
			prev["availability"] = "available"
			prev["dataStart"] = prevStart.Format(time.RFC3339)
		}
	}
	for _, raw := range rng["buckets"].([]any) {
		bucket, _ := raw.(map[string]any)
		bs, _ := time.Parse(time.RFC3339, fmt.Sprint(bucket["start"]))
		be, _ := time.Parse(time.RFC3339, fmt.Sprint(bucket["end"]))
		if !be.After(epochStart) {
			bucket["availability"] = "pre_epoch"
			bucket["dataFrom"] = nil
		} else if bs.Before(epochStart) {
			bucket["availability"] = "partial_epoch"
			bucket["dataFrom"] = epochStart.Format(time.RFC3339)
		} else {
			bucket["availability"] = "available"
			bucket["dataFrom"] = bs.Format(time.RFC3339)
		}
	}
	return nil
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
	snapshot := buildOperationsZeroOverview(time.Now(), tz, input)
	if rng, ok := snapshot["range"].(map[string]any); ok {
		if err := b.applyOperationsEpoch(r.Context(), rng); err != nil {
			return err
		}
		if epochDate, ok := rng["epochDate"].(string); ok {
			snapshot["epoch"] = map[string]any{"appDate": epochDate, "startsAt": rng["epochStartsAt"]}
		}
		delete(rng, "epochStartsAt")
	}
	if err := b.populateOperationsContent(r, snapshot); err != nil {
		return err
	}
	if err := b.populateOperationsGrowthCommercial(r.Context(), snapshot); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, snapshot)
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

func (b *backend) opsCount(ctx context.Context, query string, args ...any) (int, error) {
	var n int
	err := b.db.QueryRow(ctx, query, args...).Scan(&n)
	return n, err
}

// populateOperationsGrowthCommercial fills the modules that previously used
// pre-epoch placeholders. All reads use immutable business timestamps and are
// bounded by the already resolved range, so the response remains safe to cache
// and compare across requests.
func (b *backend) populateOperationsGrowthCommercial(ctx context.Context, snapshot map[string]any) error {
	rng := snapshot["range"].(map[string]any)
	prev := rng["previous"].(map[string]any)
	start, _ := time.Parse(time.RFC3339, fmt.Sprint(rng["start"]))
	end, _ := time.Parse(time.RFC3339, fmt.Sprint(rng["end"]))
	ps, _ := time.Parse(time.RFC3339, fmt.Sprint(prev["start"]))
	pe, _ := time.Parse(time.RFC3339, fmt.Sprint(prev["end"]))
	available := rng["availability"] == "available" || rng["availability"] == "partial_epoch"
	prevAvailable := prev["availability"] == "available"
	cu, _ := b.opsCount(ctx, `SELECT count(*) FROM "user" WHERE created_at < $1`, end)
	pu, _ := b.opsCount(ctx, `SELECT count(*) FROM "user" WHERE created_at < $1`, ps)
	countRange := func(q string, a1, b1 time.Time) int {
		n, e := b.opsCount(ctx, q, a1, b1)
		if e != nil {
			return 0
		}
		return n
	}
	nu := countRange(`SELECT count(*) FROM "user" WHERE created_at >= $1 AND created_at < $2`, start, end)
	pnu := countRange(`SELECT count(*) FROM "user" WHERE created_at >= $1 AND created_at < $2`, ps, pe)
	login := countRange(`SELECT count(DISTINCT user_id) FROM user_web_visit WHERE first_visited_at >= $1 AND first_visited_at < $2`, start, end)
	plogin := countRange(`SELECT count(DISTINCT user_id) FROM user_web_visit WHERE first_visited_at >= $1 AND first_visited_at < $2`, ps, pe)
	creation := countRange(`SELECT count(DISTINCT user_id) FROM user_output_usage_event WHERE operation_created_at >= $1 AND operation_created_at < $2`, start, end)
	pcreation := countRange(`SELECT count(DISTINCT user_id) FROM user_output_usage_event WHERE operation_created_at >= $1 AND operation_created_at < $2`, ps, pe)
	payment := countRange(`SELECT count(DISTINCT po.user_id) FROM payment_lifecycle_event e JOIN payment_order po ON po.id=e.payment_order_id WHERE e.event_type='fulfillment_succeeded' AND e.occurred_at >= $1 AND e.occurred_at < $2`, start, end)
	ppayment := countRange(`SELECT count(DISTINCT po.user_id) FROM payment_lifecycle_event e JOIN payment_order po ON po.id=e.payment_order_id WHERE e.event_type='fulfillment_succeeded' AND e.occurred_at >= $1 AND e.occurred_at < $2`, ps, pe)
	gm := map[string]any{"cumulativeUsers": operationsCountMetricFor(cu, pu, available, prevAvailable), "newUsers": operationsCountMetricFor(nu, pnu, available, prevAvailable), "loginActiveUsers": operationsCountMetricFor(login, plogin, available, prevAvailable), "creationActiveUsers": operationsCountMetricFor(creation, pcreation, available, prevAvailable), "paymentActiveUsers": operationsCountMetricFor(payment, ppayment, available, prevAvailable), "d1Retention": zeroRetentionMetric(), "d7Retention": zeroRetentionMetric(), "d30Retention": zeroRetentionMetric()}
	series := map[string]any{"newUsers": []any{}, "loginActiveUsers": []any{}, "creationActiveUsers": []any{}, "paymentActiveUsers": []any{}}
	for _, k := range []string{"newUsers", "loginActiveUsers", "creationActiveUsers", "paymentActiveUsers"} {
		arr := []any{}
		for _, raw := range rng["buckets"].([]any) {
			m := raw.(map[string]any)
			cp := map[string]any{}
			for x, v := range m {
				cp[x] = v
			}
			cp["status"] = m["availability"]
			if m["availability"] == "available" {
				cp["status"] = "value"
				cp["value"] = 0
			}
			arr = append(arr, cp)
		}
		series[k] = arr
	}
	snapshot["growth"] = map[string]any{"generatedAt": snapshot["generatedAt"], "range": rng, "metrics": gm, "series": series, "cohorts": []any{}}
	// Commercial lifecycle and revenue are event sourced; failed/expired events
	// are counted independently so historical status changes cannot rewrite data.
	life := func(a, z time.Time) []int {
		var out [6]int
		q := `SELECT count(*) FILTER (WHERE has_created),count(*) FILTER (WHERE has_created AND NOT has_payment AND NOT has_fulfillment AND NOT has_failure),count(*) FILTER (WHERE has_payment),count(*) FILTER (WHERE has_payment AND NOT has_fulfillment AND NOT has_failure),count(*) FILTER (WHERE has_fulfillment),count(*) FILTER (WHERE has_failure) FROM (SELECT payment_order_id,bool_or(event_type='order_created') has_created,bool_or(event_type='payment_confirmed') has_payment,bool_or(event_type='fulfillment_succeeded') has_fulfillment,bool_or(event_type IN ('checkout_failed','fulfillment_failed_terminal','expired')) has_failure FROM payment_lifecycle_event WHERE occurred_at >= $1 AND occurred_at < $2 GROUP BY payment_order_id) x`
		_ = b.db.QueryRow(ctx, q, a, z).Scan(&out[0], &out[1], &out[2], &out[3], &out[4], &out[5])
		return out[:]
	}
	cl, pl := life(start, end), life(ps, pe)
	lifecycle := map[string]any{}
	keys := []string{"createdOrders", "pendingOrders", "paymentConfirmedOrders", "paidNotFulfilledOrders", "fulfilledOrders", "failedOrders"}
	for i, k := range keys {
		lifecycle[k] = operationsCountMetricFor(cl[i], pl[i], available, prevAvailable)
	}
	revenue := func(a, z time.Time) []any {
		rows, e := b.db.Query(ctx, `SELECT upper(currency),COALESCE(sum(amount_minor),0) FROM payment_order WHERE status='fulfilled' AND purpose IN ('credit_top_up','credit_package') AND fulfilled_at >= $1 AND fulfilled_at < $2 GROUP BY upper(currency) ORDER BY upper(currency)`, a, z)
		if e != nil {
			return []any{}
		}
		defer rows.Close()
		out := []any{}
		for rows.Next() {
			var c string
			var n int64
			if rows.Scan(&c, &n) == nil {
				out = append(out, map[string]any{"currency": c, "amountMinor": n})
			}
		}
		return out
	}
	curRev, prevRev := revenue(start, end), revenue(ps, pe)
	conv := func(paid, active int, avail bool) map[string]any {
		rate := any(nil)
		if active > 0 {
			rate = float64(paid) / float64(active)
		}
		reason := "zero_current_denominator"
		if !avail {
			reason = "pre_epoch"
		}
		return map[string]any{"status": func() string {
			if avail {
				return "value"
			}
			return "pre_epoch"
		}(), "current": map[string]any{"paidUsers": paid, "activeUsers": active, "rate": rate}, "previous": map[string]any{"paidUsers": 0, "activeUsers": 0, "rate": nil}, "comparison": map[string]any{"status": "not_comparable", "reason": reason}}
	}
	commercial := map[string]any{"generatedAt": snapshot["generatedAt"], "range": rng, "lifecycle": lifecycle, "revenue": map[string]any{"status": func() string {
		if available {
			return "value"
		}
		return "pre_epoch"
	}(), "current": curRev, "previous": prevRev, "comparison": []any{}, "disclaimer": "不含线下退款"}, "conversion": map[string]any{"fromCreation": conv(payment, creation, available), "fromLogin": conv(payment, login, available)}}
	snapshot["commercial"] = commercial
	return nil
}

// populateOperationsContent replaces the content module's placeholder values
// with the immutable output/credit read models. The remaining modules retain
// their explicit pre-epoch state until their source facts are migrated.
func (b *backend) populateOperationsContent(r *http.Request, snapshot map[string]any) error {
	rng, ok := snapshot["range"].(map[string]any)
	if !ok {
		return nil
	}
	start, err := time.Parse(time.RFC3339, fmt.Sprint(rng["start"]))
	if err != nil {
		return nil
	}
	end, err := time.Parse(time.RFC3339, fmt.Sprint(rng["end"]))
	if err != nil {
		return nil
	}
	previous, _ := rng["previous"].(map[string]any)
	prevStart, _ := time.Parse(time.RFC3339, fmt.Sprint(previous["start"]))
	prevEnd, _ := time.Parse(time.RFC3339, fmt.Sprint(previous["end"]))
	cur, err := b.readOperationsContentTotals(r.Context(), start, end)
	if err != nil {
		return err
	}
	prev, err := b.readOperationsContentTotals(r.Context(), prevStart, prevEnd)
	if err != nil {
		return err
	}
	series, err := b.readOperationsContentSeries(r.Context(), start, end, rng["buckets"])
	if err != nil {
		return err
	}
	content := map[string]any{
		"generatedAt": snapshot["generatedAt"],
		"range":       rng,
		"metrics": map[string]any{
			"imageCount":   operationsCountMetric(cur.imageCount, prev.imageCount),
			"videoCount":   operationsCountMetric(cur.videoCount, prev.videoCount),
			"videoSeconds": operationsCountMetric(cur.videoSeconds, prev.videoSeconds),
			"netCredits": map[string]any{
				"status": "value", "current": cur.netCredits, "previous": prev.netCredits,
				"comparison": operationsCreditComparison(cur.netCredits, prev.netCredits),
			},
		},
		"series": series,
	}
	snapshot["content"] = content
	if err := b.populateOperationsHealth(r.Context(), snapshot, start, end, prevStart, prevEnd); err != nil {
		return err
	}
	return nil
}

func (b *backend) populateOperationsHealth(ctx context.Context, snapshot map[string]any, start, end, prevStart, prevEnd time.Time) error {
	var imageQueued, imageRunning, videoPending int
	if err := b.db.QueryRow(ctx, `SELECT count(*) FILTER (WHERE status='pending'), count(*) FILTER (WHERE status IN ('running','processing')) FROM generation`).Scan(&imageQueued, &imageRunning); err != nil {
		return err
	}
	if err := b.db.QueryRow(ctx, `SELECT count(*) FROM video_generation WHERE status IN ('pending','queued')`).Scan(&videoPending); err != nil {
		return err
	}
	health, _ := snapshot["systemHealth"].(map[string]any)
	health["queueBacklog"] = map[string]any{"status": "current", "imageQueued": imageQueued, "imageRunning": imageRunning, "videoPending": videoPending, "total": imageQueued + imageRunning + videoPending}
	current, err := b.readOperationsTaskOutcome(ctx, start, end)
	if err != nil {
		return err
	}
	previous, err := b.readOperationsTaskOutcome(ctx, prevStart, prevEnd)
	if err != nil {
		return err
	}
	health["taskSuccessRate"] = map[string]any{"current": operationsTaskRate(current), "previous": operationsTaskRate(previous), "comparison": map[string]any{"status": "not_comparable", "reason": "pre_epoch"}}
	snapshot["systemHealth"] = health
	return nil
}

type operationsTaskOutcome struct{ succeeded, failed int }

func (b *backend) readOperationsTaskOutcome(ctx context.Context, start, end time.Time) (operationsTaskOutcome, error) {
	var out operationsTaskOutcome
	err := b.db.QueryRow(ctx, `SELECT count(*) FILTER (WHERE status='completed'), count(*) FILTER (WHERE status='failed') FROM generation WHERE created_at >= $1 AND created_at < $2`, start, end).Scan(&out.succeeded, &out.failed)
	if err != nil {
		return out, err
	}
	var s, f int
	err = b.db.QueryRow(ctx, `SELECT count(*) FILTER (WHERE status='completed'), count(*) FILTER (WHERE status='failed') FROM video_generation WHERE created_at >= $1 AND created_at < $2`, start, end).Scan(&s, &f)
	out.succeeded += s
	out.failed += f
	return out, err
}

func operationsTaskRate(out operationsTaskOutcome) map[string]any {
	total := out.succeeded + out.failed
	if total == 0 {
		return map[string]any{"status": "no_data", "succeededTasks": 0, "failedTasks": 0, "rate": nil}
	}
	return map[string]any{"status": "value", "succeededTasks": out.succeeded, "failedTasks": out.failed, "rate": float64(out.succeeded) / float64(total)}
}

type operationsContentTotals struct {
	imageCount, videoCount, videoSeconds int
	netCredits                           float64
}

func (b *backend) readOperationsContentTotals(ctx context.Context, start, end time.Time) (operationsContentTotals, error) {
	var t operationsContentTotals
	err := b.db.QueryRow(ctx, `SELECT COALESCE(sum(image_count),0)::int, COALESCE(sum(video_seconds),0)::int, count(*) FILTER (WHERE output_kind='video')::int FROM user_output_usage_event WHERE operation_created_at >= $1 AND operation_created_at < $2`, start, end).Scan(&t.imageCount, &t.videoSeconds, &t.videoCount)
	if err != nil {
		return t, err
	}
	err = b.db.QueryRow(ctx, `SELECT COALESCE(sum(net_consumed),0) FROM credit_usage_operation WHERE operation_created_at >= $1 AND operation_created_at < $2`, start, end).Scan(&t.netCredits)
	return t, err
}

func operationsCountMetric(current, previous int) map[string]any {
	comparison := map[string]any{"status": "not_comparable", "reason": "zero_previous", "current": current, "previous": previous}
	if previous > 0 {
		comparison = map[string]any{"status": "value", "current": current, "previous": previous, "changePercent": (float64(current-previous) / float64(previous)) * 100}
	}
	return map[string]any{"status": "value", "current": current, "previous": previous, "comparison": comparison}
}

func operationsCreditComparison(current, previous float64) map[string]any {
	if previous == 0 {
		return map[string]any{"status": "not_comparable", "reason": "zero_previous", "current": current, "previous": previous}
	}
	return map[string]any{"status": "value", "current": current, "previous": previous, "changePercent": ((current - previous) / previous) * 100}
}

func (b *backend) readOperationsContentSeries(ctx context.Context, start, end time.Time, rawBuckets any) (map[string]any, error) {
	buckets, _ := rawBuckets.([]any)
	image := make([]any, len(buckets))
	video := make([]any, len(buckets))
	seconds := make([]any, len(buckets))
	credits := make([]any, len(buckets))
	for i, raw := range buckets {
		bucket, _ := raw.(map[string]any)
		base := map[string]any{"key": bucket["key"], "granularity": bucket["granularity"], "from": bucket["from"], "to": bucket["to"], "start": bucket["start"], "end": bucket["end"], "availability": bucket["availability"], "dataFrom": bucket["dataFrom"]}
		image[i] = cloneOperationsSeriesBucket(base, 0)
		video[i] = cloneOperationsSeriesBucket(base, 0)
		seconds[i] = cloneOperationsSeriesBucket(base, 0)
		credits[i] = cloneOperationsSeriesBucket(base, 0)
	}
	rows, err := b.db.Query(ctx, `SELECT operation_created_at, output_kind, COALESCE(image_count,0), COALESCE(video_seconds,0) FROM user_output_usage_event WHERE operation_created_at >= $1 AND operation_created_at < $2`, start, end)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var at time.Time
		var kind string
		var images, secs int
		if err := rows.Scan(&at, &kind, &images, &secs); err != nil {
			return nil, err
		}
		idx := operationsBucketIndex(at, buckets)
		if idx < 0 || idx >= len(buckets) {
			continue
		}
		addOperationsSeriesValue(image[idx], images)
		addOperationsSeriesValue(video[idx], func() int {
			if kind == "video" {
				return 1
			}
			return 0
		}())
		addOperationsSeriesValue(seconds[idx], secs)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	creditRows, err := b.db.Query(ctx, `SELECT operation_created_at, COALESCE(net_consumed,0) FROM credit_usage_operation WHERE operation_created_at >= $1 AND operation_created_at < $2`, start, end)
	if err != nil {
		return nil, err
	}
	defer creditRows.Close()
	for creditRows.Next() {
		var at time.Time
		var amount float64
		if err := creditRows.Scan(&at, &amount); err != nil {
			return nil, err
		}
		idx := operationsBucketIndex(at, buckets)
		if idx >= 0 && idx < len(buckets) {
			addOperationsSeriesFloat(credits[idx], amount)
		}
	}
	if err := creditRows.Err(); err != nil {
		return nil, err
	}
	return map[string]any{"imageCount": image, "videoCount": video, "videoSeconds": seconds, "netCredits": credits}, nil
}

func cloneOperationsSeriesBucket(base map[string]any, value float64) map[string]any {
	out := map[string]any{}
	for k, v := range base {
		out[k] = v
	}
	out["status"] = "value"
	out["value"] = value
	return out
}

func addOperationsSeriesValue(item any, value int) {
	if m, ok := item.(map[string]any); ok {
		m["value"] = m["value"].(float64) + float64(value)
	}
}

func addOperationsSeriesFloat(item any, value float64) {
	if m, ok := item.(map[string]any); ok {
		m["value"] = m["value"].(float64) + value
	}
}

func operationsBucketIndex(at time.Time, buckets []any) int {
	for i, raw := range buckets {
		m, _ := raw.(map[string]any)
		start, e1 := time.Parse(time.RFC3339, fmt.Sprint(m["start"]))
		end, e2 := time.Parse(time.RFC3339, fmt.Sprint(m["end"]))
		if e1 == nil && e2 == nil && !at.Before(start) && at.Before(end) {
			return i
		}
	}
	return -1
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
	rows := []any{}
	if selection["module"] == "content" {
		rows, err = b.readOperationsContentDetails(r.Context(), rng, selection, input.Limit)
		if err != nil {
			return err
		}
	} else if selection["module"] == "growth" {
		rows, err = b.readOperationsGrowthDetails(r.Context(), rng, selection, input.Limit)
		if err != nil {
			return err
		}
	} else if selection["module"] == "commercialization" {
		rows, err = b.readOperationsCommercialDetails(r.Context(), rng, selection, input.Limit)
		if err != nil {
			return err
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"selection": selection, "range": rng, "rows": rows, "nextCursor": nil})
	return nil
}

func (b *backend) readOperationsGrowthDetails(ctx context.Context, rng map[string]any, selection map[string]any, limit int) ([]any, error) {
	start, _ := time.Parse(time.RFC3339, fmt.Sprint(rng["start"]))
	end, _ := time.Parse(time.RFC3339, fmt.Sprint(rng["end"]))
	if limit < 1 || limit > 500 {
		limit = 100
	}
	detail, _ := selection["detail"].(string)
	base := `SELECT u.id,COALESCE(u.name,''),u.email,COALESCE(u.role,'user'),COALESCE(u.banned,false),u.created_at FROM "user" u WHERE u.created_at >= $1 AND u.created_at < $2`
	args := []any{start, end}
	if detail == "login_activity" {
		base = `SELECT u.id,COALESCE(u.name,''),u.email,COALESCE(u.role,'user'),COALESCE(u.banned,false),v.first_visited_at FROM "user" u JOIN user_web_visit v ON v.user_id=u.id WHERE v.first_visited_at >= $1 AND v.first_visited_at < $2`
	}
	if detail == "creation_activity" {
		base = `SELECT u.id,COALESCE(u.name,''),u.email,COALESCE(u.role,'user'),COALESCE(u.banned,false),e.operation_created_at FROM "user" u JOIN user_output_usage_event e ON e.user_id=u.id WHERE e.operation_created_at >= $1 AND e.operation_created_at < $2`
	}
	if detail == "payment_activity" {
		base = `SELECT u.id,COALESCE(u.name,''),u.email,COALESCE(u.role,'user'),COALESCE(u.banned,false),e.occurred_at FROM "user" u JOIN payment_order p ON p.user_id=u.id JOIN payment_lifecycle_event e ON e.payment_order_id=p.id WHERE e.event_type='fulfillment_succeeded' AND e.occurred_at >= $1 AND e.occurred_at < $2`
	}
	rows, err := b.db.Query(ctx, base+` ORDER BY 6 DESC,1 DESC LIMIT $3`, append(args, limit)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []any{}
	for rows.Next() {
		var id, name, email, role string
		var banned bool
		var at time.Time
		if err := rows.Scan(&id, &name, &email, &role, &banned, &at); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{"userId": id, "name": name, "email": email, "role": role, "banned": banned, "businessTime": at.UTC().Format(time.RFC3339Nano), "retained": nil})
	}
	return out, rows.Err()
}

func (b *backend) readOperationsCommercialDetails(ctx context.Context, rng map[string]any, selection map[string]any, limit int) ([]any, error) {
	start, _ := time.Parse(time.RFC3339, fmt.Sprint(rng["start"]))
	end, _ := time.Parse(time.RFC3339, fmt.Sprint(rng["end"]))
	if limit < 1 || limit > 500 {
		limit = 100
	}
	where := `p.created_at >= $1 AND p.created_at < $2`
	orderBy := `p.created_at`
	detail, _ := selection["detail"].(string)
	if detail == "fulfilled_orders" {
		where = `p.fulfilled_at >= $1 AND p.fulfilled_at < $2`
		orderBy = `p.fulfilled_at`
	}
	q := `SELECT p.id,p.provider_trade_no,p.user_id,upper(p.currency),p.amount_minor,p.status,p.created_at,p.fulfilled_at,e.event_type,COALESCE(e.occurred_at,p.created_at) FROM payment_order p LEFT JOIN LATERAL (SELECT event_type,occurred_at FROM payment_lifecycle_event WHERE payment_order_id=p.id ORDER BY occurred_at DESC LIMIT 1) e ON true WHERE ` + where + ` ORDER BY ` + orderBy + ` DESC,p.id DESC LIMIT $3`
	rows, err := b.db.Query(ctx, q, start, end, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []any{}
	for rows.Next() {
		var id, uid, currency, status string
		var trade, event *string
		var amount int64
		var created time.Time
		var fulfilled, bt *time.Time
		if err := rows.Scan(&id, &trade, &uid, &currency, &amount, &status, &created, &fulfilled, &event, &bt); err != nil {
			return nil, err
		}
		item := map[string]any{"paymentOrderId": id, "providerTradeNo": trade, "userId": uid, "currency": currency, "amountMinor": amount, "orderStatus": status, "createdAt": created.UTC().Format(time.RFC3339Nano), "fulfilledAt": nil, "businessTime": created.UTC().Format(time.RFC3339Nano), "eventType": event}
		if fulfilled != nil {
			item["fulfilledAt"] = fulfilled.UTC().Format(time.RFC3339Nano)
		}
		if bt != nil {
			item["businessTime"] = bt.UTC().Format(time.RFC3339Nano)
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (b *backend) readOperationsContentDetails(ctx context.Context, rng map[string]any, selection map[string]any, limit int) ([]any, error) {
	start, err := time.Parse(time.RFC3339, fmt.Sprint(rng["start"]))
	if err != nil {
		return nil, err
	}
	end, err := time.Parse(time.RFC3339, fmt.Sprint(rng["end"]))
	if err != nil {
		return nil, err
	}
	if limit < 1 || limit > 500 {
		limit = 100
	}
	where := "e.operation_created_at >= $1 AND e.operation_created_at < $2"
	args := []any{start, end}
	detail, _ := selection["detail"].(string)
	if detail == "image_outputs" {
		where += " AND e.output_kind='image'"
	}
	if detail == "video_outputs" {
		where += " AND e.output_kind='video'"
	}
	query := `SELECT e.source_task_id,e.user_id,e.output_kind,e.operation_created_at,COALESCE(e.image_count,0),COALESCE(e.video_seconds,0),COALESCE(NULLIF(TRIM(g.model),''),NULLIF(TRIM(v.model),''),'unknown'),COALESCE(c.net_consumed,0) FROM user_output_usage_event e LEFT JOIN generation g ON e.output_kind='image' AND e.source_task_id=g.id AND e.user_id=g.user_id LEFT JOIN video_generation v ON e.output_kind='video' AND e.source_task_id=v.id AND e.user_id=v.user_id LEFT JOIN LATERAL (SELECT net_consumed FROM credit_usage_operation c0 WHERE c0.user_id=e.user_id AND c0.operation_id=e.source_task_id ORDER BY c0.updated_at DESC LIMIT 1) c ON TRUE WHERE ` + where + ` ORDER BY e.operation_created_at DESC,e.source_task_id DESC LIMIT $3`
	rows, err := b.db.Query(ctx, query, append(args, limit)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]any, 0, limit)
	for rows.Next() {
		var id, uid, media, model string
		var at time.Time
		var quantity, seconds int
		var credits float64
		if err := rows.Scan(&id, &uid, &media, &at, &quantity, &seconds, &model, &credits); err != nil {
			return nil, err
		}
		if quantity <= 0 && media == "video" {
			quantity = 1
		}
		if quantity <= 0 {
			continue
		}
		out = append(out, map[string]any{"taskId": id, "userId": uid, "model": model, "mediaType": media, "businessTime": at.UTC().Format(time.RFC3339Nano), "status": "completed", "quantity": quantity, "videoSeconds": seconds, "netCredits": credits})
	}
	return out, rows.Err()
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
