package main

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

func (b *backend) handleOperationsOverviewMigrated(w http.ResponseWriter, r *http.Request) error {
	noStore(w)
	if _, e := b.requireAdmin(r, false); e != nil {
		return e
	}
	var input map[string]any
	if e := decodeBody(r, &input); e != nil {
		return e
	}
	if _, e := validateOperationsQuery(input); e != nil {
		return e
	}
	ctx := r.Context()
	tx, e := b.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if e != nil {
		return e
	}
	defer rollback(tx)
	now, epochDate, epochStart, zone, e := operationsSnapshotHeader(ctx, tx)
	if e != nil {
		return e
	}
	rng, e := resolveOperationsRange(now, zone, epochDate, input)
	if e != nil {
		return e
	}
	growth, counts, e := readOperationsGrowthSnapshot(ctx, tx, rng, epochStart)
	if e != nil {
		return e
	}
	commercial, e := readOperationsCommercialSnapshot(ctx, tx, rng, counts)
	if e != nil {
		return e
	}
	content, e := readOperationsContentSnapshot(ctx, tx, rng)
	if e != nil {
		return e
	}
	health, e := readOperationsHealthSnapshot(ctx, tx, rng)
	if e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	writeJSON(w, 200, map[string]any{"generatedAt": operationsISO(now), "timeZone": zone, "epoch": map[string]any{"appDate": epochDate, "startsAt": operationsISO(epochStart)}, "schemaVersion": 1, "range": rng, "growth": growth, "commercial": commercial, "content": content, "systemHealth": health})
	return nil
}

type opsActivityCounts struct{ New, Login, Creation, Payment int }

func readOpsActivityCounts(ctx context.Context, db operationsDB, start, end time.Time) (v opsActivityCounts, e error) {
	if !start.Before(end) {
		return
	}
	e = db.QueryRow(ctx, `SELECT (SELECT count(*) FROM "user" WHERE created_at >= $1 AND created_at < $2),(SELECT count(DISTINCT user_id) FROM user_web_visit WHERE first_visited_at >= $1 AND first_visited_at < $2),(SELECT count(DISTINCT user_id) FROM user_output_usage_event WHERE operation_created_at >= $1 AND operation_created_at < $2),(SELECT count(DISTINCT user_id) FROM payment_order WHERE status='fulfilled' AND purpose IN ('credit_top_up','credit_package') AND fulfilled_at >= $1 AND fulfilled_at < $2)`, start, end).Scan(&v.New, &v.Login, &v.Creation, &v.Payment)
	return
}

func opsSeriesBucket(bucket map[string]any, value float64) map[string]any {
	out := map[string]any{}
	for k, v := range bucket {
		out[k] = v
	}
	out["status"] = "pre_epoch"
	if bucket["availability"] != "pre_epoch" {
		out["status"] = "value"
		out["value"] = value
	}
	return out
}

func readOperationsGrowthSnapshot(ctx context.Context, db operationsDB, rng map[string]any, epochStart time.Time) (map[string]any, [2]opsActivityCounts, error) {
	var counts [2]opsActivityCounts
	prev := rng["previous"].(map[string]any)
	start, end := operationsDataBounds(rng)
	ps, pe := operationsDataBounds(prev)
	var e error
	counts[0], e = readOpsActivityCounts(ctx, db, start, end)
	if e != nil {
		return nil, counts, e
	}
	counts[1], e = readOpsActivityCounts(ctx, db, ps, pe)
	if e != nil {
		return nil, counts, e
	}
	var cumulative, previousCumulative int
	if e = db.QueryRow(ctx, `SELECT (SELECT count(*) FROM "user" WHERE created_at<$1),(SELECT count(*) FROM "user" WHERE created_at<$2)`, operationsTime(rng["end"]), operationsTime(prev["end"])).Scan(&cumulative, &previousCumulative); e != nil {
		return nil, counts, e
	}
	available, comparable := rng["availability"] != "pre_epoch", prev["availability"] == "available"
	metrics := map[string]any{"cumulativeUsers": operationsCountMetricFor(cumulative, previousCumulative, true, true)}
	for key, pair := range map[string][2]int{"newUsers": {counts[0].New, counts[1].New}, "loginActiveUsers": {counts[0].Login, counts[1].Login}, "creationActiveUsers": {counts[0].Creation, counts[1].Creation}, "paymentActiveUsers": {counts[0].Payment, counts[1].Payment}} {
		metrics[key] = operationsCountMetricFor(pair[0], pair[1], available, comparable)
	}
	series, e := readOperationsSeries(ctx, db, rng, true)
	if e != nil {
		return nil, counts, e
	}
	cohorts, e := readOperationsCohorts(ctx, db, rng, rng, epochStart)
	if e != nil {
		return nil, counts, e
	}
	previousCohorts, e := readOperationsCohorts(ctx, db, prev, rng, epochStart)
	if e != nil {
		return nil, counts, e
	}
	for _, key := range []string{"d1", "d7", "d30"} {
		current, previous := opsWeightedRetention(cohorts, key), opsWeightedRetention(previousCohorts, key)
		comparison := map[string]any{"status": "not_comparable", "reason": "retention_unavailable"}
		if current["status"] == "value" && previous["status"] == "value" {
			comparison = opsRateComparison(current["rate"].(float64), previous["rate"].(float64), comparable)
		}
		metrics[key+"Retention"] = map[string]any{"current": current, "previous": previous, "comparison": comparison}
	}
	return map[string]any{"generatedAt": rng["asOf"], "range": rng, "metrics": metrics, "series": series, "cohorts": cohorts}, counts, nil
}

func opsRateComparison(current, previous float64, comparable bool) map[string]any {
	if !comparable {
		return map[string]any{"status": "not_comparable", "reason": "pre_epoch"}
	}
	return map[string]any{"status": "value", "currentRate": current, "previousRate": previous, "changePercentagePoints": (current - previous) * 100}
}

func readOperationsCohorts(ctx context.Context, db operationsDB, period, rng map[string]any, epochStart time.Time) ([]map[string]any, error) {
	start, end := operationsDataBounds(period)
	raw := map[string][4]int{}
	if start.Before(end) {
		rows, e := db.Query(ctx, `WITH cohorts AS(SELECT id,((created_at AT TIME ZONE 'UTC') AT TIME ZONE $3)::date cohort_date FROM "user" WHERE created_at >= $1 AND created_at < $2),activity AS(SELECT DISTINCT e.user_id,((e.operation_created_at AT TIME ZONE 'UTC') AT TIME ZONE $3)::date activity_date FROM user_output_usage_event e JOIN cohorts c ON c.id=e.user_id WHERE e.operation_created_at >= $4 AND e.operation_created_at < $5) SELECT c.cohort_date::text,count(DISTINCT c.id),count(DISTINCT c.id) FILTER(WHERE a.activity_date=c.cohort_date+1),count(DISTINCT c.id) FILTER(WHERE a.activity_date=c.cohort_date+7),count(DISTINCT c.id) FILTER(WHERE a.activity_date=c.cohort_date+30) FROM cohorts c LEFT JOIN activity a ON a.user_id=c.id AND a.activity_date IN(c.cohort_date+1,c.cohort_date+7,c.cohort_date+30) GROUP BY c.cohort_date ORDER BY c.cohort_date`, start, end, rng["timeZone"], epochStart, operationsTime(rng["asOf"]))
		if e != nil {
			return nil, e
		}
		for rows.Next() {
			var date string
			var counts [4]int
			if e = rows.Scan(&date, &counts[0], &counts[1], &counts[2], &counts[3]); e != nil {
				rows.Close()
				return nil, e
			}
			raw[date] = counts
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return nil, e
		}
	}
	result := []map[string]any{}
	epoch, today := rng["epochDate"].(string), rng["today"].(string)
	for day := period["from"].(string); day <= period["to"].(string); day = operationsAddDate(day, 1) {
		v := raw[day]
		row := map[string]any{"cohortDate": day, "cohortSize": v[0]}
		for index, delta := range []int{1, 7, 30} {
			maturity := operationsAddDate(day, delta)
			status := "value"
			switch {
			case day < epoch:
				status = "pre_epoch"
			case maturity > today:
				status = "immature"
			case v[0] == 0:
				status = "no_data"
			}
			retention := map[string]any{"status": status, "cohortDate": day, "cohortSize": v[0], "retainedCount": v[index+1], "retentionDay": delta, "maturityDate": maturity}
			if v[index+1] > v[0] {
				return nil, errors.New("invalid operations retention cohort")
			}
			if status == "value" {
				retention["rate"] = float64(v[index+1]) / float64(v[0])
			}
			row["d"+strconv.Itoa(delta)] = retention
		}
		result = append(result, row)
	}
	return result, nil
}

func opsWeightedRetention(cohorts []map[string]any, key string) map[string]any {
	count, size, retained := 0, 0, 0
	postEpoch := false
	for _, cohort := range cohorts {
		v := cohort[key].(map[string]any)
		if v["status"] != "pre_epoch" {
			postEpoch = true
		}
		if v["status"] == "value" {
			count++
			size += v["cohortSize"].(int)
			retained += v["retainedCount"].(int)
		}
	}
	if count == 0 {
		status := "pre_epoch"
		if postEpoch || len(cohorts) == 0 {
			status = "immature"
		}
		return map[string]any{"status": status}
	}
	return map[string]any{"status": "value", "cohortCount": count, "cohortSize": size, "retainedCount": retained, "rate": float64(retained) / float64(size)}
}

type opsCommercialFacts struct {
	lifecycle [6]int
	revenue   map[string]int64
}

func readOperationsCommercialFacts(ctx context.Context, db operationsDB, start, end time.Time) (v opsCommercialFacts, err error) {
	v.revenue = map[string]int64{}
	if !start.Before(end) {
		return
	}
	err = db.QueryRow(ctx, `WITH flags AS(SELECT e.payment_order_id,bool_or(e.event_type='order_created') created,bool_or(e.event_type='payment_confirmed') paid,bool_or(e.event_type='fulfillment_succeeded') fulfilled,bool_or(e.event_type IN ('checkout_failed','fulfillment_failed_terminal','expired')) failed FROM payment_lifecycle_event e JOIN payment_order p ON p.id=e.payment_order_id WHERE p.purpose IN ('credit_top_up','credit_package') AND e.occurred_at >= $1 AND e.occurred_at < $2 GROUP BY e.payment_order_id) SELECT count(*) FILTER(WHERE created),count(*) FILTER(WHERE created AND NOT paid AND NOT fulfilled AND NOT failed),count(*) FILTER(WHERE paid),count(*) FILTER(WHERE paid AND NOT fulfilled AND NOT failed),count(*) FILTER(WHERE fulfilled),count(*) FILTER(WHERE failed) FROM flags`, start, end).Scan(&v.lifecycle[0], &v.lifecycle[1], &v.lifecycle[2], &v.lifecycle[3], &v.lifecycle[4], &v.lifecycle[5])
	if err != nil {
		return
	}
	rows, e := db.Query(ctx, `SELECT upper(currency),sum(amount_minor) FROM payment_order WHERE status='fulfilled' AND purpose IN ('credit_top_up','credit_package') AND fulfilled_at >= $1 AND fulfilled_at < $2 GROUP BY upper(currency) ORDER BY upper(currency)`, start, end)
	if e != nil {
		err = e
		return
	}
	defer rows.Close()
	for rows.Next() {
		var currency string
		var amount int64
		if e = rows.Scan(&currency, &amount); e != nil {
			err = e
			return
		}
		v.revenue[currency] = amount
	}
	err = rows.Err()
	return
}
func opsConversion(currentPaid, currentActive, previousPaid, previousActive int, available, comparable bool) map[string]any {
	current := map[string]any{"paidUsers": currentPaid, "activeUsers": currentActive, "rate": nil}
	previous := map[string]any{"paidUsers": previousPaid, "activeUsers": previousActive, "rate": nil}
	if currentActive > 0 {
		current["rate"] = float64(currentPaid) / float64(currentActive)
	}
	if previousActive > 0 {
		previous["rate"] = float64(previousPaid) / float64(previousActive)
	}
	reason := ""
	switch {
	case !comparable:
		reason = "pre_epoch"
	case currentActive == 0:
		reason = "zero_current_denominator"
	case previousActive == 0:
		reason = "zero_previous_denominator"
	}
	comparison := map[string]any{"status": "not_comparable", "reason": reason}
	if reason == "" {
		comparison = opsRateComparison(current["rate"].(float64), previous["rate"].(float64), true)
	}
	status := "value"
	if !available {
		status = "pre_epoch"
	}
	return map[string]any{"status": status, "current": current, "previous": previous, "comparison": comparison}
}
func readOperationsCommercialSnapshot(ctx context.Context, db operationsDB, rng map[string]any, counts [2]opsActivityCounts) (map[string]any, error) {
	prev := rng["previous"].(map[string]any)
	s, e := operationsDataBounds(rng)
	ps, pe := operationsDataBounds(prev)
	current, err := readOperationsCommercialFacts(ctx, db, s, e)
	if err != nil {
		return nil, err
	}
	previous, err := readOperationsCommercialFacts(ctx, db, ps, pe)
	if err != nil {
		return nil, err
	}
	available, comparable := rng["availability"] != "pre_epoch", prev["availability"] == "available"
	lifecycle := map[string]any{}
	for i, k := range []string{"createdOrders", "pendingOrders", "paymentConfirmedOrders", "paidNotFulfilledOrders", "fulfilledOrders", "failedOrders"} {
		lifecycle[k] = operationsCountMetricFor(current.lifecycle[i], previous.lifecycle[i], available, comparable)
	}
	currencies := map[string]bool{}
	for c := range current.revenue {
		currencies[c] = true
	}
	for c := range previous.revenue {
		currencies[c] = true
	}
	keys := []string{}
	for c := range currencies {
		keys = append(keys, c)
	}
	sort.Strings(keys)
	curRev, prevRev, comparisons := []any{}, []any{}, []any{}
	for _, c := range keys {
		cv, pv := current.revenue[c], previous.revenue[c]
		if _, ok := current.revenue[c]; ok {
			curRev = append(curRev, map[string]any{"currency": c, "amountMinor": cv})
		}
		if _, ok := previous.revenue[c]; ok {
			prevRev = append(prevRev, map[string]any{"currency": c, "amountMinor": pv})
		}
		comparison := operationsCountMetricFor(int(cv), int(pv), available, comparable)["comparison"].(map[string]any)
		delete(comparison, "current")
		delete(comparison, "previous")
		comparison["currency"] = c
		comparison["currentAmountMinor"] = cv
		comparison["previousAmountMinor"] = pv
		comparisons = append(comparisons, comparison)
	}
	status := "value"
	if !available {
		status = "pre_epoch"
	}
	return map[string]any{"generatedAt": rng["asOf"], "range": rng, "lifecycle": lifecycle, "revenue": map[string]any{"status": status, "current": curRev, "previous": prevRev, "comparison": comparisons, "disclaimer": "不含线下退款"}, "conversion": map[string]any{"fromCreation": opsConversion(counts[0].Payment, counts[0].Creation, counts[1].Payment, counts[1].Creation, available, comparable), "fromLogin": opsConversion(counts[0].Payment, counts[0].Login, counts[1].Payment, counts[1].Login, available, comparable)}}, nil
}

type opsContentFacts struct {
	images, videos, seconds int
	credits                 float64
}

func readOpsContentFacts(ctx context.Context, db operationsDB, start, end time.Time) (v opsContentFacts, e error) {
	if !start.Before(end) {
		return
	}
	e = db.QueryRow(ctx, `SELECT COALESCE(sum(image_count),0),count(*) FILTER(WHERE output_kind='video'),COALESCE(sum(video_seconds),0),(SELECT COALESCE(sum(net_consumed),0) FROM credit_usage_operation WHERE operation_created_at >= $1 AND operation_created_at < $2) FROM user_output_usage_event WHERE operation_created_at >= $1 AND operation_created_at < $2`, start, end).Scan(&v.images, &v.videos, &v.seconds, &v.credits)
	return
}
func readOperationsContentSnapshot(ctx context.Context, db operationsDB, rng map[string]any) (map[string]any, error) {
	prev := rng["previous"].(map[string]any)
	s, e := operationsDataBounds(rng)
	ps, pe := operationsDataBounds(prev)
	current, err := readOpsContentFacts(ctx, db, s, e)
	if err != nil {
		return nil, err
	}
	previous, err := readOpsContentFacts(ctx, db, ps, pe)
	if err != nil {
		return nil, err
	}
	available, comparable := rng["availability"] != "pre_epoch", prev["availability"] == "available"
	metrics := map[string]any{}
	for k, v := range map[string][2]int{"imageCount": {current.images, previous.images}, "videoCount": {current.videos, previous.videos}, "videoSeconds": {current.seconds, previous.seconds}} {
		metrics[k] = operationsCountMetricFor(v[0], v[1], available, comparable)
	}
	comparison := map[string]any{"status": "not_comparable", "reason": "pre_epoch", "current": current.credits, "previous": previous.credits}
	if comparable {
		if previous.credits == 0 {
			comparison["reason"] = "zero_previous"
		} else {
			comparison = map[string]any{"status": "value", "current": current.credits, "previous": previous.credits, "changePercent": (current.credits - previous.credits) / previous.credits * 100}
		}
	}
	status := "value"
	if !available {
		status = "pre_epoch"
	}
	metrics["netCredits"] = map[string]any{"status": status, "current": current.credits, "previous": previous.credits, "comparison": comparison}
	series, err := readOperationsSeries(ctx, db, rng, false)
	if err != nil {
		return nil, err
	}
	return map[string]any{"generatedAt": rng["asOf"], "range": rng, "metrics": metrics, "series": series}, nil
}

// Aggregate all calendar buckets in one query so unrestricted historical
// ranges do not issue four queries for every individual day.
func readOperationsSeries(ctx context.Context, db operationsDB, rng map[string]any, growth bool) (map[string]any, error) {
	keys := []string{"newUsers", "loginActiveUsers", "creationActiveUsers", "paymentActiveUsers"}
	source := `SELECT created_at business_time,id user_id,0 kind FROM "user" WHERE created_at >= $1 AND created_at < $2
 UNION ALL SELECT first_visited_at,user_id,1 FROM user_web_visit WHERE first_visited_at >= $1 AND first_visited_at < $2
 UNION ALL SELECT operation_created_at,user_id,2 FROM user_output_usage_event WHERE operation_created_at >= $1 AND operation_created_at < $2
 UNION ALL SELECT fulfilled_at,user_id,3 FROM payment_order WHERE status='fulfilled' AND purpose IN ('credit_top_up','credit_package') AND fulfilled_at >= $1 AND fulfilled_at < $2`
	aggregates := `count(DISTINCT user_id) FILTER(WHERE kind=0),count(DISTINCT user_id) FILTER(WHERE kind=1),count(DISTINCT user_id) FILTER(WHERE kind=2),count(DISTINCT user_id) FILTER(WHERE kind=3)`
	if !growth {
		keys = []string{"imageCount", "videoCount", "videoSeconds", "netCredits"}
		source = `SELECT operation_created_at business_time,image_count images,CASE WHEN output_kind='video' THEN 1 ELSE 0 END videos,video_seconds seconds,0::numeric credits FROM user_output_usage_event WHERE operation_created_at >= $1 AND operation_created_at < $2 UNION ALL SELECT operation_created_at,0,0,0,net_consumed FROM credit_usage_operation WHERE operation_created_at >= $1 AND operation_created_at < $2`
		aggregates = `sum(images),sum(videos),sum(seconds),sum(credits)`
	}
	values := map[string][4]float64{}
	start, end := operationsDataBounds(rng)
	if start.Before(end) {
		rows, e := db.Query(ctx, `WITH facts AS (`+source+`) SELECT $3||':'||to_char(date_trunc($3,(business_time AT TIME ZONE 'UTC') AT TIME ZONE $4),'YYYY-MM-DD'),`+aggregates+` FROM facts GROUP BY 1`, start, end, rng["granularity"], rng["timeZone"])
		if e != nil {
			return nil, e
		}
		for rows.Next() {
			var key string
			var nums [4]float64
			if e = rows.Scan(&key, &nums[0], &nums[1], &nums[2], &nums[3]); e != nil {
				rows.Close()
				return nil, e
			}
			values[key] = nums
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return nil, e
		}
	}
	result := map[string]any{}
	for _, k := range keys {
		result[k] = []any{}
	}
	for _, raw := range rng["buckets"].([]any) {
		bucket := raw.(map[string]any)
		nums := values[stringValue(bucket["key"])]
		for i, k := range keys {
			result[k] = append(result[k].([]any), opsSeriesBucket(bucket, nums[i]))
		}
	}
	return result, nil
}

type opsTaskHealth struct {
	success, failed, samples, invalid int
	average, p95                      *float64
	attemptFailures, terminalFailures int
}

func readOpsTaskHealth(ctx context.Context, db operationsDB, start, end time.Time) (v opsTaskHealth, e error) {
	if !start.Before(end) {
		return
	}
	e = db.QueryRow(ctx, `WITH success AS(SELECT CASE WHEN e.output_kind='image' THEN g.status::text ELSE v.status END status,CASE WHEN e.output_kind='image' THEN g.created_at ELSE v.created_at END created,CASE WHEN e.output_kind='image' THEN g.completed_at ELSE v.completed_at END completed FROM user_output_usage_event e LEFT JOIN generation g ON e.output_kind='image' AND g.id=e.source_task_id AND g.user_id=e.user_id LEFT JOIN video_generation v ON e.output_kind='video' AND v.id=e.source_task_id AND v.user_id=e.user_id WHERE e.operation_created_at >= $1 AND e.operation_created_at < $2),durations AS(SELECT extract(epoch FROM completed-created) seconds FROM success WHERE status='completed' AND completed>=created) SELECT (SELECT count(*) FROM success),(SELECT count(*) FROM generation WHERE status='failed' AND created_at >= $1 AND created_at < $2 AND COALESCE(NULLIF(lower(btrim(metadata->>'mode')),''),'generate') IN ('generate','edit'))+(SELECT count(*) FROM video_generation WHERE status='failed' AND created_at >= $1 AND created_at < $2),(SELECT count(*) FROM durations),(SELECT avg(seconds) FROM durations),(SELECT percentile_cont(0.95) WITHIN GROUP(ORDER BY seconds) FROM durations),(SELECT count(*) FROM success WHERE status IS DISTINCT FROM 'completed' OR created IS NULL OR completed IS NULL OR completed<created)`, start, end).Scan(&v.success, &v.failed, &v.samples, &v.average, &v.p95, &v.invalid)
	if e != nil {
		return
	}
	if v.invalid != 0 || v.samples != v.success {
		e = errors.New("operations successful output facts are inconsistent")
		return
	}
	e = db.QueryRow(ctx, `SELECT count(*) FILTER(WHERE e.event_type='fulfillment_attempt_failed'),count(*) FILTER(WHERE e.event_type='fulfillment_failed_terminal') FROM payment_lifecycle_event e JOIN payment_order p ON p.id=e.payment_order_id WHERE p.purpose IN ('credit_top_up','credit_package') AND e.occurred_at >= $1 AND e.occurred_at < $2`, start, end).Scan(&v.attemptFailures, &v.terminalFailures)
	return
}
func opsTaskHealthValues(v opsTaskHealth, available bool) (map[string]any, map[string]any) {
	status := "value"
	if !available {
		status = "pre_epoch"
	} else if v.success+v.failed == 0 {
		status = "no_data"
	}
	rate := map[string]any{"status": status, "succeededTasks": 0, "failedTasks": 0, "rate": nil}
	if status == "value" {
		rate["succeededTasks"] = v.success
		rate["failedTasks"] = v.failed
		rate["rate"] = float64(v.success) / float64(v.success+v.failed)
	}
	duration := map[string]any{"status": "pre_epoch", "sampleCount": 0, "averageSeconds": nil, "p95Seconds": nil}
	if available {
		duration["status"] = "no_data"
		if v.samples > 0 {
			duration = map[string]any{"status": "value", "sampleCount": v.samples, "averageSeconds": v.average, "p95Seconds": v.p95}
		}
	}
	return rate, duration
}
func readOperationsHealthSnapshot(ctx context.Context, db operationsDB, rng map[string]any) (map[string]any, error) {
	prev := rng["previous"].(map[string]any)
	s, e := operationsDataBounds(rng)
	ps, pe := operationsDataBounds(prev)
	current, err := readOpsTaskHealth(ctx, db, s, e)
	if err != nil {
		return nil, err
	}
	previous, err := readOpsTaskHealth(ctx, db, ps, pe)
	if err != nil {
		return nil, err
	}
	available, comparable := rng["availability"] != "pre_epoch", prev["availability"] == "available"
	cr, cd := opsTaskHealthValues(current, available)
	pr, pd := opsTaskHealthValues(previous, comparable)
	comparison := map[string]any{"status": "not_comparable", "reason": "no_data"}
	if cr["status"] == "pre_epoch" || pr["status"] == "pre_epoch" {
		comparison["reason"] = "pre_epoch"
	} else if cr["status"] == "value" && pr["status"] == "value" {
		comparison = opsRateComparison(cr["rate"].(float64), pr["rate"].(float64), true)
	}
	var queued, running, pending int
	err = db.QueryRow(ctx, `SELECT (SELECT count(*) FROM image_async_task WHERE status='queued'),(SELECT count(*) FROM image_async_task WHERE status='running'),(SELECT count(*) FROM video_generation WHERE stage NOT IN ('completed','failed'))`).Scan(&queued, &running, &pending)
	if err != nil {
		return nil, err
	}
	var total, enabled, healthy, degraded, unhealthy, cooling, disabled int
	err = db.QueryRow(ctx, `SELECT count(*),count(*) FILTER(WHERE is_enabled),count(*) FILTER(WHERE is_enabled AND health_status='healthy' AND status='active' AND (cooldown_until IS NULL OR cooldown_until<=transaction_timestamp())),count(*) FILTER(WHERE is_enabled AND health_status='degraded'),count(*) FILTER(WHERE is_enabled AND health_status='unhealthy'),count(*) FILTER(WHERE is_enabled AND cooldown_until>transaction_timestamp()),count(*) FILTER(WHERE NOT is_enabled) FROM image_backend_member`).Scan(&total, &enabled, &healthy, &degraded, &unhealthy, &cooling, &disabled)
	if err != nil {
		return nil, err
	}
	ct, pt := current.attemptFailures+current.terminalFailures, previous.attemptFailures+previous.terminalFailures
	fm := operationsCountMetricFor(ct, pt, available, comparable)
	return map[string]any{"taskSuccessRate": map[string]any{"current": cr, "previous": pr, "comparison": comparison}, "processingDuration": map[string]any{"current": cd, "previous": pd}, "fulfillmentFailures": map[string]any{"status": fm["status"], "current": map[string]any{"attemptFailures": current.attemptFailures, "terminalFailures": current.terminalFailures, "total": ct}, "previous": map[string]any{"attemptFailures": previous.attemptFailures, "terminalFailures": previous.terminalFailures, "total": pt}, "comparison": fm["comparison"]}, "queueBacklog": map[string]any{"status": "current", "imageQueued": queued, "imageRunning": running, "videoPending": pending, "total": queued + running + pending}, "backendHealth": map[string]any{"status": "current", "total": total, "enabled": enabled, "healthy": healthy, "degraded": degraded, "unhealthy": unhealthy, "cooling": cooling, "disabled": disabled}}, nil
}
