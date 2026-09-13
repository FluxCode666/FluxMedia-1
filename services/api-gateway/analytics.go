package main

// Analytics endpoints used by the Web UOL bindings.  These handlers own the
// read-model queries so server actions do not fall back to the Next.js
// analytics services for any user or administrator analytics operation.

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func (b *backend) registerAnalyticsRoutes(mux *http.ServeMux) {
	// The old handlers remain in support_dashboard.go for compatibility with
	// older deployments; these routes intentionally point at the read-model
	// implementations below.
	mux.HandleFunc("POST /api/analytics/data-dashboard", b.endpoint(b.handleGoAnalyticsDataDashboard))
	mux.HandleFunc("POST /api/admin/analytics/data-dashboard", b.endpoint(b.handleGoAdminAnalyticsDataDashboard))
	mux.HandleFunc("GET /api/admin/analytics/users", b.endpoint(b.handleGoAdminAnalyticsUsers))
	mux.HandleFunc("GET /api/analytics/summary", b.endpoint(b.handleGoAnalyticsSummary))
	mux.HandleFunc("POST /api/analytics/trends", b.endpoint(b.handleGoAnalyticsTrends))
}

// requireAnalyticsReady gates the two independently backfilled read models.
func (b *backend) requireAnalyticsReady(r *http.Request) error {
	readStatus := func(name string) (string, error) {
		var status string
		err := b.db.QueryRow(r.Context(), `SELECT status FROM analytics_read_model_state WHERE read_model=$1`, name).Scan(&status)
		if err == pgx.ErrNoRows {
			return "building", nil
		}
		return status, err
	}
	output, err := readStatus("output_usage")
	if err != nil {
		return err
	}
	credit, err := readStatus("credit_usage")
	if err != nil {
		return err
	}
	if output != "ready" || credit != "ready" {
		return &apiError{http.StatusServiceUnavailable, "NOT_READY", "Analytics data is still being prepared"}
	}
	return nil
}

func (b *backend) userAnalyticsLocation(r *http.Request, userID, fallback string) (*time.Location, string, error) {
	var zone *string
	if err := b.db.QueryRow(r.Context(), `SELECT time_zone FROM "user" WHERE id=$1`, userID).Scan(&zone); err != nil && err != pgx.ErrNoRows {
		return nil, "", err
	}
	name := fallback
	if zone != nil && strings.TrimSpace(*zone) != "" {
		name = strings.TrimSpace(*zone)
	}
	loc, err := time.LoadLocation(name)
	if err != nil {
		return nil, "", &apiError{http.StatusServiceUnavailable, "NOT_READY", "Analytics timezone configuration is invalid"}
	}
	return loc, name, nil
}

func (b *backend) appAnalyticsLocation(r *http.Request) (*time.Location, string, error) {
	name, err := b.settingString(r.Context(), "APP_TIME_ZONE", "UTC")
	if err != nil {
		return nil, "", err
	}
	loc, err := time.LoadLocation(strings.TrimSpace(name))
	if err != nil {
		return nil, "", &apiError{http.StatusServiceUnavailable, "NOT_READY", "Analytics timezone configuration is invalid"}
	}
	return loc, strings.TrimSpace(name), nil
}

func (b *backend) handleGoAnalyticsSummary(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireSession(r)
	if err != nil {
		return err
	}
	if err = b.requireAnalyticsReady(r); err != nil {
		return err
	}
	fallback, err := b.settingString(r.Context(), "APP_TIME_ZONE", "UTC")
	if err != nil {
		return err
	}
	_, zone, err := b.userAnalyticsLocation(r, s.User.ID, fallback)
	if err != nil {
		return err
	}
	asOf := time.Now().UTC()
	start := asOf.Add(-24 * time.Hour)
	var recentImage, recentVideo int
	if err = b.db.QueryRow(r.Context(), `SELECT COALESCE(sum(image_count),0),COALESCE(sum(video_seconds),0) FROM user_output_usage_event WHERE user_id=$1 AND operation_created_at >= $2 AND operation_created_at < $3`, s.User.ID, start, asOf).Scan(&recentImage, &recentVideo); err != nil {
		return err
	}
	var lifetimeImage, lifetimeVideo int
	if err = b.db.QueryRow(r.Context(), `SELECT COALESCE(total_image_count,0),COALESCE(total_video_seconds,0) FROM user_usage_summary WHERE user_id=$1`, s.User.ID).Scan(&lifetimeImage, &lifetimeVideo); err != nil && err != pgx.ErrNoRows {
		return err
	}
	var recentCredits, lifetimeCredits float64
	if err = b.db.QueryRow(r.Context(), `SELECT COALESCE(sum(net_consumed),0) FROM credit_usage_operation WHERE user_id=$1 AND operation_created_at >= $2 AND operation_created_at < $3`, s.User.ID, start, asOf).Scan(&recentCredits); err != nil {
		return err
	}
	if err = b.db.QueryRow(r.Context(), `SELECT COALESCE(sum(net_consumed),0) FROM credit_usage_operation WHERE user_id=$1`, s.User.ID).Scan(&lifetimeCredits); err != nil {
		return err
	}
	rows, err := b.db.Query(r.Context(), `SELECT COALESCE(NULLIF(TRIM(g.model),''),NULLIF(TRIM(v.model),''),'unknown'),count(*) FROM user_output_usage_event e LEFT JOIN generation g ON e.output_kind='image' AND e.source_task_id=g.id AND e.user_id=g.user_id LEFT JOIN video_generation v ON e.output_kind='video' AND e.source_task_id=v.id AND e.user_id=v.user_id WHERE e.user_id=$1 AND e.operation_created_at >= $2 AND e.operation_created_at < $3 GROUP BY 1 ORDER BY count(*) DESC,1`, s.User.ID, start, asOf)
	if err != nil {
		return err
	}
	defer rows.Close()
	models := make([]any, 0)
	totalTasks := 0
	for rows.Next() {
		var model string
		var count int
		if err = rows.Scan(&model, &count); err != nil {
			return err
		}
		models = append(models, map[string]any{"model": model, "taskCount": count})
		totalTasks += count
	}
	if err = rows.Err(); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"asOf": asOf.Format(time.RFC3339Nano), "timeZone": zone,
		"last24HoursRange":  map[string]any{"start": start.Format(time.RFC3339Nano), "end": asOf.Format(time.RFC3339Nano)},
		"last24Hours":       map[string]any{"imageCount": recentImage, "videoSeconds": recentVideo, "creditsConsumed": recentCredits},
		"modelDistribution": map[string]any{"models": models, "totalTasks": totalTasks},
		"lifetime":          map[string]any{"imageCount": lifetimeImage, "videoSeconds": lifetimeVideo, "creditsConsumed": lifetimeCredits},
	})
	return nil
}

type analyticsTrendInput struct {
	Granularity string `json:"granularity"`
	Metric      string `json:"metric"`
	Range       string `json:"range"`
	Start       string `json:"start"`
	End         string `json:"end"`
}

type analyticsTrendRange struct {
	start, end time.Time
	labels     []string
	starts     []time.Time
	ends       []time.Time
}

func parseAnalyticsLocalDate(value string, loc *time.Location) (time.Time, error) {
	t, err := time.ParseInLocation("2006-01-02", value, loc)
	if err != nil || t.Format("2006-01-02") != value {
		return time.Time{}, invalid("日期格式无效")
	}
	return t, nil
}

func parseAnalyticsTrendRange(in analyticsTrendInput, asOf time.Time, loc *time.Location) (analyticsTrendRange, error) {
	if in.Metric == "" {
		in.Metric = "imageCount"
	}
	if in.Granularity != "hour" && in.Granularity != "day" {
		return analyticsTrendRange{}, invalid("granularity 无效")
	}
	if in.Metric != "imageCount" && in.Metric != "videoSeconds" {
		return analyticsTrendRange{}, invalid("metric 无效")
	}
	if in.Granularity == "hour" {
		var start, end time.Time
		if in.Range == "last24Hours" || in.Range == "last48Hours" {
			hours := 24
			if in.Range == "last48Hours" {
				hours = 48
			}
			start, end = asOf.Add(-time.Duration(hours)*time.Hour), asOf
		} else if in.Range == "custom" {
			var err error
			for _, layout := range []string{"2006-01-02T15:04", "2006-01-02T15:04:05", "2006-01-02T15:04:05.000"} {
				start, err = time.ParseInLocation(layout, in.Start, loc)
				if err == nil {
					end, err = time.ParseInLocation(layout, in.End, loc)
					if err == nil {
						break
					}
				}
			}
			if err != nil {
				return analyticsTrendRange{}, invalid("小时范围无效")
			}
			if !end.After(start) || end.After(asOf) || end.Sub(start) > 168*time.Hour {
				return analyticsTrendRange{}, invalid("按小时查询范围无效")
			}
		} else {
			return analyticsTrendRange{}, invalid("小时范围无效")
		}
		count := int((end.Sub(start) + time.Hour - 1) / time.Hour)
		labels := make([]string, count)
		starts, ends := make([]time.Time, count), make([]time.Time, count)
		for i := range labels {
			st := start.Add(time.Duration(i) * time.Hour)
			en := st.Add(time.Hour)
			if en.After(end) {
				en = end
			}
			starts[i], ends[i] = st, en
			labels[i] = st.In(loc).Format("2006-01-02 15:04")
		}
		return analyticsTrendRange{start: start, end: end, labels: labels, starts: starts, ends: ends}, nil
	}

	today := asOf.In(loc)
	var startDay, endDay time.Time
	var err error
	if in.Range == "custom" {
		startDay, err = parseAnalyticsLocalDate(in.Start, loc)
		if err != nil {
			return analyticsTrendRange{}, err
		}
		endDay, err = parseAnalyticsLocalDate(in.End, loc)
		if err != nil || endDay.Before(startDay) || endDay.After(time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, loc)) {
			return analyticsTrendRange{}, invalid("日期范围无效")
		}
	} else {
		endDay = time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, loc)
		switch in.Range {
		case "last7Days":
			startDay = endDay.AddDate(0, 0, -6)
		case "currentMonth":
			startDay = time.Date(endDay.Year(), endDay.Month(), 1, 0, 0, 0, 0, loc)
		case "currentQuarter":
			startDay = time.Date(endDay.Year(), ((endDay.Month()-1)/3)*3+1, 1, 0, 0, 0, 0, loc)
		case "currentYear":
			startDay = time.Date(endDay.Year(), 1, 1, 0, 0, 0, 0, loc)
		default:
			return analyticsTrendRange{}, invalid("日期范围无效")
		}
	}
	count := int(endDay.Sub(startDay).Hours()/24) + 1
	if count < 1 || count > 366 {
		return analyticsTrendRange{}, invalid("按天查询范围不能超过 366 个自然日")
	}
	starts, ends := make([]time.Time, count), make([]time.Time, count)
	labels := make([]string, count)
	for i := range labels {
		st := startDay.AddDate(0, 0, i)
		en := st.AddDate(0, 0, 1)
		if in.Range != "custom" && st.Format("2006-01-02") == endDay.Format("2006-01-02") {
			en = asOf
		}
		starts[i], ends[i], labels[i] = st, en, st.Format("2006-01-02")
	}
	return analyticsTrendRange{start: starts[0], end: ends[len(ends)-1], labels: labels, starts: starts, ends: ends}, nil
}

func (b *backend) handleGoAnalyticsTrends(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireSession(r)
	if err != nil {
		return err
	}
	if err = b.requireAnalyticsReady(r); err != nil {
		return err
	}
	fallback, err := b.settingString(r.Context(), "APP_TIME_ZONE", "UTC")
	if err != nil {
		return err
	}
	loc, zone, err := b.userAnalyticsLocation(r, s.User.ID, fallback)
	if err != nil {
		return err
	}
	var in analyticsTrendInput
	if err = decodeBody(r, &in); err != nil {
		return err
	}
	asOf := time.Now().UTC()
	rangeValue, err := parseAnalyticsTrendRange(in, asOf, loc)
	if err != nil {
		return err
	}
	values := make([]int, len(rangeValue.labels))
	imageTasks, videoTasks := 0, 0
	rows, err := b.db.Query(r.Context(), `SELECT operation_created_at,output_kind,COALESCE(image_count,0),COALESCE(video_seconds,0) FROM user_output_usage_event WHERE user_id=$1 AND operation_created_at >= $2 AND operation_created_at < $3`, s.User.ID, rangeValue.start.UTC(), rangeValue.end.UTC())
	if err != nil {
		return err
	}
	for rows.Next() {
		var at time.Time
		var kind string
		var images, seconds int
		if err = rows.Scan(&at, &kind, &images, &seconds); err != nil {
			rows.Close()
			return err
		}
		if kind == "image" {
			imageTasks++
		} else if kind == "video" {
			videoTasks++
		}
		for i := range rangeValue.labels {
			if !at.Before(rangeValue.starts[i].UTC()) && at.Before(rangeValue.ends[i].UTC()) {
				if in.Metric == "videoSeconds" {
					values[i] += seconds
				} else {
					values[i] += images
				}
				break
			}
		}
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	buckets := make([]any, len(values))
	for i, value := range values {
		buckets[i] = map[string]any{"start": rangeValue.starts[i].UTC().Format(time.RFC3339Nano), "end": rangeValue.ends[i].UTC().Format(time.RFC3339Nano), "label": rangeValue.labels[i], "value": value}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"asOf": asOf.Format(time.RFC3339Nano), "timeZone": zone,
		"range":       map[string]any{"start": rangeValue.start.UTC().Format(time.RFC3339Nano), "end": rangeValue.end.UTC().Format(time.RFC3339Nano)},
		"granularity": in.Granularity, "metric": func() string {
			if in.Metric == "" {
				return "imageCount"
			}
			return in.Metric
		}(),
		"unit": func() string {
			if in.Metric == "videoSeconds" {
				return "seconds"
			}
			return "images"
		}(),
		"buckets":      buckets,
		"distribution": map[string]any{"imageTasks": imageTasks, "videoTasks": videoTasks, "totalTasks": imageTasks + videoTasks},
	})
	return nil
}

func (b *backend) handleGoAnalyticsDataDashboard(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireSession(r)
	if err != nil {
		return err
	}
	fallback, err := b.settingString(r.Context(), "APP_TIME_ZONE", "UTC")
	if err != nil {
		return err
	}
	loc, zone, err := b.userAnalyticsLocation(r, s.User.ID, fallback)
	if err != nil {
		return err
	}
	var in struct {
		StartDate string `json:"startDate"`
		EndDate   string `json:"endDate"`
	}
	if err = decodeBody(r, &in); err != nil {
		return err
	}
	return b.writeGoDataDashboard(w, r, s.User.ID, zone, loc, in.StartDate, in.EndDate)
}

func (b *backend) handleGoAdminAnalyticsDataDashboard(w http.ResponseWriter, r *http.Request) error {
	_, err := b.requireAdmin(r, false)
	if err != nil {
		return err
	}
	loc, zone, err := b.appAnalyticsLocation(r)
	if err != nil {
		return err
	}
	var in struct {
		UserID    string `json:"userId"`
		StartDate string `json:"startDate"`
		EndDate   string `json:"endDate"`
	}
	if err = decodeBody(r, &in); err != nil {
		return err
	}
	uid := strings.TrimSpace(in.UserID)
	if uid == "" {
		uid = ""
	}
	return b.writeGoDataDashboard(w, r, uid, zone, loc, in.StartDate, in.EndDate)
}

func (b *backend) writeGoDataDashboard(w http.ResponseWriter, r *http.Request, userID, zone string, loc *time.Location, startDate, endDate string) error {
	if err := b.requireAnalyticsReady(r); err != nil {
		return err
	}
	asOf := time.Now().UTC()
	today := asOf.In(loc).Format("2006-01-02")
	if endDate == "" {
		endDate = today
	}
	if startDate == "" {
		startDate = asOf.In(loc).AddDate(0, 0, -6).Format("2006-01-02")
	}
	startLocal, err := parseAnalyticsLocalDate(startDate, loc)
	if err != nil {
		return err
	}
	endLocal, err := parseAnalyticsLocalDate(endDate, loc)
	if err != nil || endLocal.Before(startLocal) || endDate > today {
		return invalid("日期范围无效")
	}
	days := int(endLocal.Sub(startLocal).Hours()/24) + 1
	if days < 1 || days > 30 {
		return invalid("日期范围必须为 1 至 30 天且不能处于未来")
	}
	rangeStart := startLocal
	rangeEnd := endLocal.AddDate(0, 0, 1)
	if endDate == today {
		rangeEnd = asOf.In(loc)
	}
	whereUser := ""
	args := []any{rangeStart.UTC(), rangeEnd.UTC()}
	if userID != "" {
		whereUser = " AND e.user_id=$3"
		args = append(args, userID)
	}
	values := make([]struct {
		images, imageTasks, videos, seconds int
		credits                             float64
	}, days)
	index := func(at time.Time) int {
		d := at.In(loc).Format("2006-01-02")
		for i := 0; i < days; i++ {
			if startLocal.AddDate(0, 0, i).Format("2006-01-02") == d {
				return i
			}
		}
		return -1
	}
	rows, err := b.db.Query(r.Context(), `SELECT e.operation_created_at,e.output_kind,COALESCE(e.image_count,0),COALESCE(e.video_seconds,0),COALESCE((SELECT sum(c.net_consumed) FROM credit_usage_operation c WHERE c.user_id=e.user_id AND c.operation_id=e.source_task_id),0) FROM user_output_usage_event e WHERE e.operation_created_at >= $1 AND e.operation_created_at < $2`+whereUser, args...)
	if err != nil {
		return err
	}
	for rows.Next() {
		var at time.Time
		var kind string
		var images, seconds int
		var credits float64
		if err = rows.Scan(&at, &kind, &images, &seconds, &credits); err != nil {
			rows.Close()
			return err
		}
		i := index(at)
		if i < 0 || i >= days {
			continue
		}
		values[i].images += images
		values[i].credits += credits
		if kind == "image" {
			values[i].imageTasks++
		} else if kind == "video" {
			values[i].videos++
			values[i].seconds += seconds
		}
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	var failed int
	failedArgs := []any{rangeStart.UTC(), rangeEnd.UTC()}
	userFilter := ""
	if userID != "" {
		userFilter = " AND user_id=$3"
		failedArgs = append(failedArgs, userID)
	}
	if err = b.db.QueryRow(r.Context(), `SELECT COALESCE((SELECT count(*) FROM generation WHERE status='failed' AND created_at >= $1 AND created_at < $2 AND coalesce(nullif(lower(btrim(metadata->>'mode')), ''), 'generate') IN ('generate','edit')`+userFilter+`),0)+COALESCE((SELECT count(*) FROM video_generation WHERE status='failed' AND created_at >= $1 AND created_at < $2`+userFilter+`),0)`, failedArgs...).Scan(&failed); err != nil {
		return err
	}
	var model string
	var modelCount int
	modelArgs := []any{rangeStart.UTC(), rangeEnd.UTC()}
	modelFilter := ""
	if userID != "" {
		modelFilter = " AND e.user_id=$3"
		modelArgs = append(modelArgs, userID)
	}
	if err = b.db.QueryRow(r.Context(), `SELECT COALESCE(NULLIF(TRIM(CASE WHEN e.output_kind='image' THEN g.model ELSE v.model END),''),'unknown'),count(*) FROM user_output_usage_event e LEFT JOIN generation g ON e.output_kind='image' AND e.source_task_id=g.id AND e.user_id=g.user_id LEFT JOIN video_generation v ON e.output_kind='video' AND e.source_task_id=v.id AND e.user_id=v.user_id WHERE e.operation_created_at >= $1 AND e.operation_created_at < $2`+modelFilter+` GROUP BY 1 ORDER BY count(*) DESC,1 LIMIT 1`, modelArgs...).Scan(&model, &modelCount); err != nil && err != pgx.ErrNoRows {
		return err
	}
	buckets := make([]any, days)
	imageTotal, videoTotal, imageTasks, videoTasks, active := 0, 0, 0, 0, 0
	creditsTotal := 0.0
	for i := 0; i < days; i++ {
		d := startLocal.AddDate(0, 0, i)
		e := d.AddDate(0, 0, 1)
		if d.Format("2006-01-02") == today {
			e = asOf.In(loc)
		}
		v := values[i]
		imageTotal += v.images
		videoTotal += v.seconds
		imageTasks += v.imageTasks
		videoTasks += v.videos
		creditsTotal += v.credits
		if v.imageTasks > 0 || v.videos > 0 {
			active++
		}
		buckets[i] = map[string]any{"date": d.Format("2006-01-02"), "start": d.UTC().Format(time.RFC3339Nano), "end": e.UTC().Format(time.RFC3339Nano), "imageCount": v.images, "imageTaskCount": v.imageTasks, "videoCount": v.videos, "videoSeconds": v.seconds, "creditsConsumed": v.credits}
	}
	terminal := imageTasks + videoTasks + failed
	var rate any
	if terminal > 0 {
		rate = float64(imageTasks+videoTasks) / float64(terminal)
	}
	var most any
	if modelCount > 0 {
		most = map[string]any{"model": model, "taskCount": modelCount}
	}
	snapshot := map[string]any{"asOf": asOf.Format(time.RFC3339Nano), "timeZone": zone, "today": today, "range": map[string]any{"startDate": startDate, "endDate": endDate, "start": rangeStart.UTC().Format(time.RFC3339Nano), "end": rangeEnd.UTC().Format(time.RFC3339Nano)}, "metrics": map[string]any{"imageCount": imageTotal, "videoSeconds": videoTotal, "creditsConsumed": creditsTotal, "successRate": map[string]any{"succeeded": imageTasks + videoTasks, "failed": failed, "terminal": terminal, "rate": rate}, "activeDays": active, "mostUsedModel": most}, "buckets": buckets, "taskComposition": map[string]any{"imageTaskCount": imageTasks, "videoCount": videoTasks, "totalTasks": imageTasks + videoTasks}}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ready", "snapshot": snapshot})
	return nil
}

func (b *backend) handleGoAdminAnalyticsUsers(w http.ResponseWriter, r *http.Request) error {
	if _, err := b.requireAdmin(r, false); err != nil {
		return err
	}
	query := strings.TrimSpace(r.URL.Query().Get("query"))
	selected := strings.TrimSpace(r.URL.Query().Get("selectedUserId"))
	limit := 20
	if n, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && n > 0 && n <= 50 {
		limit = n
	}
	var rows pgx.Rows
	var err error
	if selected != "" {
		rows, err = b.db.Query(r.Context(), `SELECT id,name,email FROM "user" WHERE id=$1`, selected)
	} else if query == "" {
		writeJSON(w, http.StatusOK, map[string]any{"users": []any{}})
		return nil
	} else {
		rows, err = b.db.Query(r.Context(), `SELECT id,name,email FROM "user" WHERE name ILIKE $1 OR email ILIKE $1 ORDER BY name,id LIMIT $2`, "%"+query+"%", limit)
	}
	if err != nil {
		return err
	}
	defer rows.Close()
	users := make([]any, 0)
	for rows.Next() {
		var id, name, email string
		if err := rows.Scan(&id, &name, &email); err != nil {
			return err
		}
		users = append(users, map[string]string{"id": id, "name": name, "email": email})
	}
	return func() error { writeJSON(w, http.StatusOK, map[string]any{"users": users}); return nil }()
}
