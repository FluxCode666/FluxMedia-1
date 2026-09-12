package main

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

func itoa(v int) string { return strconv.Itoa(v) }

func (b *backend) registerAdminStatusRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/admin/status/overview", b.endpoint(b.handleAdminStatusOverview))
	mux.HandleFunc("POST /api/admin/status/errors", b.endpoint(b.handleAdminStatusErrors))
}

// handleAdminStatusOverview is the read model for the global status page.  The
// page used to run these aggregates in Next.js; keeping the complete query and
// classification here makes the Go service the sole owner of the data path.
func (b *backend) handleAdminStatusOverview(w http.ResponseWriter, r *http.Request) error {
	if _, err := b.requireAdminViewer(r); err != nil {
		return err
	}
	now := time.Now().UTC()
	last24h, last7d := now.Add(-24*time.Hour), now.Add(-7*24*time.Hour)
	stats24, err := b.adminGenerationWindowStats(r.Context(), last24h)
	if err != nil {
		return err
	}
	stats7, err := b.adminGenerationWindowStats(r.Context(), last7d)
	if err != nil {
		return err
	}

	var totals struct {
		Total, Completed, Failed, Pending, CompletedImages int64
		Credits                                            float64
	}
	err = b.db.QueryRow(r.Context(), `SELECT count(*),count(*) FILTER (WHERE status='completed'),count(*) FILTER (WHERE status='failed'),count(*) FILTER (WHERE status='pending'),COALESCE(sum(CASE WHEN status='completed' THEN CASE WHEN jsonb_typeof(metadata::jsonb #> '{outputImage,billableImageOutputCount}')='number' THEN (metadata::jsonb #>> '{outputImage,billableImageOutputCount}')::int WHEN storage_key IS NOT NULL THEN 1 ELSE 0 END ELSE 0 END),0),COALESCE(sum(credits_consumed),0) FROM generation`).Scan(&totals.Total, &totals.Completed, &totals.Failed, &totals.Pending, &totals.CompletedImages, &totals.Credits)
	if err != nil {
		return err
	}
	credits, err := b.adminCreditStats(r.Context(), now, last24h, last7d)
	if err != nil {
		return err
	}
	users, err := b.adminUserStats(r.Context(), now, last24h, last7d)
	if err != nil {
		return err
	}
	tickets, err := b.adminTicketStats(r.Context(), last24h)
	if err != nil {
		return err
	}
	backend, err := b.adminBackendStats(r.Context())
	if err != nil {
		return err
	}
	scheduler24, scheduler7, err := b.adminSchedulerStats(r.Context(), last24h, last7d)
	if err != nil {
		return err
	}
	video, err := b.adminVideoStats(r.Context(), last7d)
	if err != nil {
		return err
	}
	topErrors, truncated, err := b.adminTopErrors(r.Context(), last7d, last24h)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"now": now.Format(time.RFC3339Nano), "stats24h": stats24, "stats7d": stats7,
		"rowsTruncated": truncated, "topErrors24h": topErrors,
		"generationTotals": map[string]any{"total": totals.Total, "completed": totals.Completed, "failed": totals.Failed, "pending": totals.Pending, "completedImages": totals.CompletedImages, "creditsConsumed": totals.Credits},
		"credits":          credits, "users": users, "tickets": tickets,
		"backend": map[string]any{"api": backend}, "scheduler24h": scheduler24, "scheduler7d": scheduler7, "video7d": video,
	})
	return nil
}

type adminStatusGenerationRow struct {
	Status             string
	Error              *string
	Credits            float64
	StorageKey         *string
	Size               string
	Created, Completed *time.Time
	Metadata           []byte
}

func (b *backend) adminGenerationWindowStats(ctx context.Context, start time.Time) (map[string]any, error) {
	var total, completed, failed, pending, produced int64
	var credits, avg, p95 *float64
	err := b.db.QueryRow(ctx, `SELECT count(*),count(*) FILTER (WHERE status='completed'),count(*) FILTER (WHERE status='failed'),count(*) FILTER (WHERE status='pending'),COALESCE(sum(CASE WHEN status='completed' THEN CASE WHEN jsonb_typeof(metadata::jsonb #> '{outputImage,billableImageOutputCount}')='number' THEN (metadata::jsonb #>> '{outputImage,billableImageOutputCount}')::int WHEN storage_key IS NOT NULL THEN 1 ELSE 0 END ELSE 0 END),0),COALESCE(sum(credits_consumed),0),avg(round(greatest(0,extract(epoch FROM (completed_at-created_at)))) FILTER (WHERE status='completed' AND completed_at IS NOT NULL)),percentile_disc(0.95) WITHIN GROUP (ORDER BY round(greatest(0,extract(epoch FROM (completed_at-created_at)))) ) FILTER (WHERE status='completed' AND completed_at IS NOT NULL) FROM generation WHERE created_at >= $1`, start).Scan(&total, &completed, &failed, &pending, &produced, &credits, &avg, &p95)
	if err != nil {
		return nil, err
	}
	var platform, moderation, userReq int64
	rows, err := b.db.Query(ctx, `SELECT error FROM generation WHERE created_at >= $1 AND status='failed'`, start)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var msg *string
		if err = rows.Scan(&msg); err != nil {
			rows.Close()
			return nil, err
		}
		switch adminStatusErrorCategory(msg) {
		case "moderation":
			moderation++
		case "user_request":
			userReq++
		default:
			platform++
		}
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	breakdown := adminEmptyDurationBreakdown()
	rows, err = b.db.Query(ctx, `SELECT CASE WHEN lower(btrim(coalesce(nullif(metadata::jsonb #>> '{outputImage,requestedSize}',''),nullif(metadata::jsonb #>> '{outputImage,actualSize}',''),size)))='' OR lower(btrim(coalesce(nullif(metadata::jsonb #>> '{outputImage,requestedSize}',''),nullif(metadata::jsonb #>> '{outputImage,actualSize}',''),size)))='auto' THEN 'custom' WHEN lower(btrim(coalesce(nullif(metadata::jsonb #>> '{outputImage,requestedSize}',''),nullif(metadata::jsonb #>> '{outputImage,actualSize}',''),size))) = ANY($2::text[]) THEN '4k' WHEN lower(btrim(coalesce(nullif(metadata::jsonb #>> '{outputImage,requestedSize}',''),nullif(metadata::jsonb #>> '{outputImage,actualSize}',''),size))) = ANY($3::text[]) THEN '2k' WHEN lower(btrim(coalesce(nullif(metadata::jsonb #>> '{outputImage,requestedSize}',''),nullif(metadata::jsonb #>> '{outputImage,actualSize}',''),size))) = ANY($4::text[]) THEN '1k' ELSE 'custom' END, count(*), avg(round(greatest(0,extract(epoch FROM (completed_at-created_at))))), percentile_disc(0.95) WITHIN GROUP (ORDER BY round(greatest(0,extract(epoch FROM (completed_at-created_at))))) FROM generation WHERE created_at >= $1 AND status='completed' AND completed_at IS NOT NULL AND metadata::jsonb #>> '{backend,type}'='pool-api' GROUP BY 1`, start, adminResolutionPresets(3840), adminResolutionPresets(2048), adminResolutionPresets(1024))
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var bucket string
		var n int64
		var a, p *float64
		if err = rows.Scan(&bucket, &n, &a, &p); err != nil {
			rows.Close()
			return nil, err
		}
		if cell, ok := breakdown[bucket]; ok {
			cell["api"] = map[string]any{"count": n, "avgSeconds": a, "p95Seconds": p}
		}
	}
	rows.Close()
	repair := map[string]any{"attempted": int64(0), "succeeded": int64(0), "failed": int64(0), "byAttempt": []any{}}
	rows, err = b.db.Query(ctx, `SELECT metadata FROM generation WHERE created_at >= $1 AND jsonb_typeof(metadata::jsonb #> '{moderationPromptRepair,attempts}')='array' AND jsonb_array_length(metadata::jsonb #> '{moderationPromptRepair,attempts}')>0`, start)
	if err != nil {
		return nil, err
	}
	byAttempt := map[int]map[string]int64{}
	for rows.Next() {
		var raw []byte
		if err = rows.Scan(&raw); err != nil {
			rows.Close()
			return nil, err
		}
		var doc map[string]any
		if json.Unmarshal(raw, &doc) != nil {
			continue
		}
		mr, _ := doc["moderationPromptRepair"].(map[string]any)
		arr, _ := mr["attempts"].([]any)
		for _, item := range arr {
			obj, ok := item.(map[string]any)
			if !ok {
				continue
			}
			n := 1
			if x, ok := obj["attempt"].(float64); ok && x > 0 {
				n = int(x)
			}
			repair["attempted"] = repair["attempted"].(int64) + 1
			status, _ := obj["status"].(string)
			succeeded := status == "succeeded"
			if succeeded {
				repair["succeeded"] = repair["succeeded"].(int64) + 1
			} else if status == "failed" || status == "skipped" {
				repair["failed"] = repair["failed"].(int64) + 1
			}
			itemStats := byAttempt[n]
			if itemStats == nil {
				itemStats = map[string]int64{"attempt": int64(n), "attempted": 0, "succeeded": 0, "failed": 0}
				byAttempt[n] = itemStats
			}
			itemStats["attempted"]++
			if succeeded {
				itemStats["succeeded"]++
			} else if status == "failed" || status == "skipped" {
				itemStats["failed"]++
			}
		}
	}
	rows.Close()
	keys := make([]int, 0, len(byAttempt))
	for k := range byAttempt {
		keys = append(keys, k)
	}
	for i := 0; i < len(keys); i++ {
		for j := i + 1; j < len(keys); j++ {
			if keys[j] < keys[i] {
				keys[i], keys[j] = keys[j], keys[i]
			}
		}
	}
	arr := make([]any, 0, len(keys))
	for _, k := range keys {
		arr = append(arr, byAttempt[k])
	}
	repair["byAttempt"] = arr
	finished := completed + failed
	platformDen := completed + platform
	success := 1.0
	if finished > 0 {
		success = float64(completed) / float64(finished)
	}
	sla := 1.0
	if platformDen > 0 {
		sla = float64(completed) / float64(platformDen)
	}
	return map[string]any{"total": total, "completed": completed, "failed": failed, "pending": pending, "producedImages": produced, "creditsConsumed": credits, "successRate": success, "platformSla": sla, "platformErrors": platform, "moderationErrors": moderation, "userRequestErrors": userReq, "avgSeconds": avg, "p95Seconds": p95, "durationBreakdown": breakdown, "moderationPromptRepair": repair}, nil
}

func adminEmptyDurationBreakdown() map[string]map[string]any {
	out := map[string]map[string]any{}
	for _, k := range []string{"4k", "2k", "1k", "custom"} {
		out[k] = map[string]any{"api": map[string]any{"count": int64(0), "avgSeconds": nil, "p95Seconds": nil}}
	}
	return out
}
func adminResolutionPresets(edge int) []string {
	ratios := [][2]int{{1, 1}, {3, 2}, {2, 3}, {16, 9}, {9, 16}, {4, 3}, {3, 4}, {21, 9}}
	out := []string{}
	for _, r := range ratios {
		w, h := edge, edge
		if r[0] >= r[1] {
			h = edge * r[1] / r[0]
		} else {
			w = edge * r[0] / r[1]
		}
		out = append(out, strconv.Itoa(w)+"x"+strconv.Itoa(h))
	}
	if edge == 1024 {
		out = append(out, "1024x1024", "1536x1024", "1024x1536")
	}
	return out
}

func adminStatusErrorCategory(message *string) string {
	if message == nil {
		return "platform"
	}
	v := strings.ToLower(strings.NewReplacer("’", "'", "‘", "'", string(rune(96)), "'").Replace(*message))
	for _, pattern := range []string{"aliyun moderation timed out", "aliyun moderation failed", "content moderation failed", "moderation skipped unexpectedly", "moderation timed out", "moderation failed", "socket hang up", "socket closed", "connection reset", "econnreset", "operation was aborted", "temporarily unavailable", "service unavailable"} {
		if strings.Contains(v, pattern) {
			return "platform"
		}
	}
	for _, pattern := range []string{"content failed moderation", "content blocked", "content policy", "content policy violation", "violates our content policy", "policy violation", "policy_violation", "safety policy", "safety system", "safety violation", "safety_violations", "request was rejected by the safety system", "rejected by the safety system", "blocked by the safety system", "flagged by the safety system", "image_unsafe", "not allowed to generate", "unsafe content", "未能通过安全", "安全系统", "安全限制", "安全过滤器", "系统拦截", "系统拒绝", "内容审查", "露骨", "性暗示", "裸露", "自伤", "未成年人", "受版权保护", "拒绝", "拦截"} {
		if strings.Contains(v, pattern) {
			return "moderation"
		}
	}
	for _, pattern := range []string{"prompt_too_long", "提示词过长", "prompt too long", "too_many_images", "参考图最多", "too many reference images", "image_too_large", "image dimensions exceed", "decompression bomb", "invalid image data", "invalid image file", "invalid image format", "unsupported image format", "unable to decode", "invalid_mask_image_format", "积分不足", "insufficient credits", "insufficient_credits", "api key quota exceeded", "api key credit limit", "api_key_quota_exceeded", "invalid model", "unsupported model", "prompt exceeds", "invalid quality", "invalid moderation", "invalid thinking", "invalid display size", "invalid resolution", "transparent background is not supported", "must be between", "total pixels", "no more than", "at least one source image", "source images must be", "reference images must be", "mask must be", "total upload size", "upload is too large", "invalid or missing api key", "account frozen", "image_generation_user_error", "user_error"} {
		if strings.Contains(v, pattern) {
			return "user_request"
		}
	}
	return "platform"
}
func (b *backend) handleAdminStatusErrors(w http.ResponseWriter, r *http.Request) error {
	if _, err := b.requireAdmin(r, false); err != nil {
		return err
	}
	var in struct {
		FromDate *time.Time `json:"fromDate"`
		ToDate   *time.Time `json:"toDate"`
		Page     int        `json:"page"`
		PageSize int        `json:"pageSize"`
	}
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	if in.Page < 1 {
		in.Page = 1
	}
	if in.PageSize != 10 && in.PageSize != 20 && in.PageSize != 50 {
		in.PageSize = 20
	}
	where := `g.status='failed'`
	args := []any{}
	if in.FromDate != nil {
		args = append(args, *in.FromDate)
		where += ` AND g.created_at >= $` + itoa(len(args))
	}
	if in.ToDate != nil {
		args = append(args, *in.ToDate)
		where += ` AND g.created_at <= $` + itoa(len(args))
	}
	var total int
	if err := b.db.QueryRow(r.Context(), `SELECT count(*) FROM generation g WHERE `+where, args...).Scan(&total); err != nil {
		return err
	}
	totalPages := (total + in.PageSize - 1) / in.PageSize
	if totalPages < 1 {
		totalPages = 1
	}
	if in.Page > totalPages {
		in.Page = totalPages
	}
	args = append(args, in.PageSize, (in.Page-1)*in.PageSize)
	rows, err := b.db.Query(r.Context(), `SELECT g.id,g.user_id,u.email,u.name,g.prompt,g.model,g.size,g.credits_consumed,g.error,g.created_at,g.completed_at FROM generation g LEFT JOIN "user" u ON u.id=g.user_id WHERE `+where+` ORDER BY g.created_at DESC,g.id DESC LIMIT $`+itoa(len(args)-1)+` OFFSET $`+itoa(len(args)), args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	records := []any{}
	for rows.Next() {
		var id, uid, prompt, model, size string
		var email, name, message *string
		var credits float64
		var created time.Time
		var completed *time.Time
		if err := rows.Scan(&id, &uid, &email, &name, &prompt, &model, &size, &credits, &message, &created, &completed); err != nil {
			return err
		}
		records = append(records, map[string]any{"id": id, "userId": uid, "userEmail": email, "userName": name, "prompt": prompt, "model": model, "size": size, "creditsConsumed": credits, "error": message, "createdAt": created, "completedAt": completed, "category": adminStatusErrorCategory(message)})
	}
	writeJSON(w, http.StatusOK, map[string]any{"records": records, "page": in.Page, "pageSize": in.PageSize, "totalCount": total, "totalPages": totalPages})
	return rows.Err()
}

func (b *backend) adminCreditStats(ctx context.Context, now, last24h, last7d time.Time) (map[string]any, error) {
	var balance struct {
		Balance, Earned, Spent float64
		Frozen                 int64
	}
	if err := b.db.QueryRow(ctx, `SELECT COALESCE(sum(balance),0),COALESCE(sum(total_earned),0),COALESCE(sum(total_spent),0),count(*) FILTER (WHERE status='frozen') FROM credits_balance`).Scan(&balance.Balance, &balance.Earned, &balance.Spent, &balance.Frozen); err != nil {
		return nil, err
	}
	ledger := func(start time.Time) (map[string]any, error) {
		var c, r, e, g float64
		err := b.db.QueryRow(ctx, `SELECT COALESCE(sum(amount) FILTER(WHERE type='consumption'),0),COALESCE(sum(amount) FILTER(WHERE type='refund'),0),COALESCE(sum(amount) FILTER(WHERE type='expiration'),0),COALESCE(sum(amount) FILTER(WHERE type IN ('monthly_grant','registration_bonus','admin_grant','purchase','referral_reward')),0) FROM credits_transaction WHERE created_at >= $1`, start).Scan(&c, &r, &e, &g)
		return map[string]any{"consumption": c, "refund": r, "expiration": e, "grants": g}, err
	}
	l24, e := ledger(last24h)
	if e != nil {
		return nil, e
	}
	l7, e := ledger(last7d)
	if e != nil {
		return nil, e
	}
	var active, consumed, expired float64
	e = b.db.QueryRow(ctx, `SELECT COALESCE(sum(remaining) FILTER(WHERE status='active'),0),COALESCE(sum(amount) FILTER(WHERE status='consumed'),0),COALESCE(sum(remaining) FILTER(WHERE status='expired'),0) FROM credits_batch`).Scan(&active, &consumed, &expired)
	if e != nil {
		return nil, e
	}
	_ = now
	return map[string]any{"balance": map[string]any{"totalBalance": balance.Balance, "totalEarned": balance.Earned, "totalSpent": balance.Spent, "frozen": balance.Frozen}, "ledger24h": l24, "ledger7d": l7, "batches": map[string]any{"activeRemaining": active, "consumedAmount": consumed, "expiredAmount": expired}}, nil
}
func (b *backend) adminUserStats(ctx context.Context, _ time.Time, last24h, last7d time.Time) (map[string]any, error) {
	var total, n24, n7, banned, obs, admins, super int64
	err := b.db.QueryRow(ctx, `SELECT count(*),count(*) FILTER(WHERE created_at >= $1),count(*) FILTER(WHERE created_at >= $2),count(*) FILTER(WHERE banned),count(*) FILTER(WHERE role='observer_admin'),count(*) FILTER(WHERE role='admin'),count(*) FILTER(WHERE role='super_admin') FROM "user"`, last24h, last7d).Scan(&total, &n24, &n7, &banned, &obs, &admins, &super)
	return map[string]any{"total": total, "new24h": n24, "new7d": n7, "banned": banned, "observers": obs, "admins": admins, "superAdmins": super}, err
}
func (b *backend) adminTicketStats(ctx context.Context, last24h time.Time) (map[string]any, error) {
	var open, progress, unresolved, n24 int64
	err := b.db.QueryRow(ctx, `SELECT count(*) FILTER(WHERE status='open'),count(*) FILTER(WHERE status='in_progress'),count(*) FILTER(WHERE status IN ('open','in_progress')),count(*) FILTER(WHERE created_at >= $1) FROM ticket`, last24h).Scan(&open, &progress, &unresolved, &n24)
	return map[string]any{"open": open, "inProgress": progress, "unresolved": unresolved, "new24h": n24}, err
}
func (b *backend) adminBackendStats(ctx context.Context) (map[string]any, error) {
	rows, e := b.db.Query(ctx, `SELECT status,health_status,is_enabled,cooldown_until,lease_acquired_count,0::bigint FROM image_backend_member WHERE type='api'`)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := map[string]any{"total": int64(0), "enabled": int64(0), "active": int64(0), "limited": int64(0), "error": int64(0), "cooling": int64(0), "disabled": int64(0), "successCount": int64(0), "failCount": int64(0), "healthStates": []any{}}
	health := map[string]int64{}
	for rows.Next() {
		var status, hs string
		var enabled bool
		var cooldown *time.Time
		var lease, fail int64
		if e = rows.Scan(&status, &hs, &enabled, &cooldown, &lease, &fail); e != nil {
			return nil, e
		}
		out["total"] = out["total"].(int64) + 1
		health[hs]++
		out["successCount"] = out["successCount"].(int64) + lease
		out["failCount"] = out["failCount"].(int64) + fail
		if !enabled {
			out["disabled"] = out["disabled"].(int64) + 1
			continue
		}
		out["enabled"] = out["enabled"].(int64) + 1
		if status == "active" {
			out["active"] = out["active"].(int64) + 1
		}
		if status == "limited" {
			out["limited"] = out["limited"].(int64) + 1
		}
		if status == "error" {
			out["error"] = out["error"].(int64) + 1
		}
		if cooldown != nil && cooldown.After(time.Now()) {
			out["cooling"] = out["cooling"].(int64) + 1
		}
	}
	hs := []any{}
	for k, v := range health {
		hs = append(hs, map[string]any{"health": k, "count": v})
	}
	out["healthStates"] = hs
	return out, rows.Err()
}
func (b *backend) adminSchedulerStats(ctx context.Context, last24h, last7d time.Time) (map[string]any, map[string]any, error) {
	load := func(start time.Time) (map[string]any, error) {
		rows, e := b.db.Query(ctx, `SELECT request_kind,strategy,outcome,COALESCE(sum(event_count),0),COALESCE(sum(candidate_count_total),0),COALESCE(sum(latency_ms_total),0) FROM image_backend_member_scheduler_metric WHERE bucket_started_at >= $1 GROUP BY request_kind,strategy,outcome`, start)
		if e != nil {
			return nil, e
		}
		defer rows.Close()
		out := map[string]any{"acquiredCount": int64(0), "switchCount": int64(0), "noCandidateCount": int64(0), "capacityRejectedCount": int64(0), "terminalFailureCount": int64(0), "avgCandidateCount": nil, "avgLatencyMs": nil, "byOutcome": []any{}, "byStrategy": []any{}, "byRequestKind": []any{}}
		byO, byS, byR := map[string]int64{}, map[string]int64{}, map[string]int64{}
		var selections, candidates, latency int64
		for rows.Next() {
			var rk, st, oc string
			var n, c, l int64
			if e = rows.Scan(&rk, &st, &oc, &n, &c, &l); e != nil {
				return nil, e
			}
			byO[oc] += n
			byS[st] += n
			byR[rk] += n
			switch oc {
			case "acquired":
				out["acquiredCount"] = out["acquiredCount"].(int64) + n
			case "switched":
				out["switchCount"] = out["switchCount"].(int64) + n
			case "no_candidate":
				out["noCandidateCount"] = out["noCandidateCount"].(int64) + n
			case "capacity_rejected":
				out["capacityRejectedCount"] = out["capacityRejectedCount"].(int64) + n
			case "terminal_failure":
				out["terminalFailureCount"] = out["terminalFailureCount"].(int64) + n
			}
			if oc == "acquired" || oc == "switched" {
				selections += n
				candidates += c
				latency += l
			}
		}
		if selections > 0 {
			out["avgCandidateCount"] = float64(candidates) / float64(selections)
			out["avgLatencyMs"] = float64(latency) / float64(selections)
		}
		dist := func(m map[string]int64) []any {
			a := []any{}
			for k, v := range m {
				a = append(a, map[string]any{"key": k, "count": v})
			}
			return a
		}
		out["byOutcome"] = dist(byO)
		out["byStrategy"] = dist(byS)
		out["byRequestKind"] = dist(byR)
		return out, rows.Err()
	}
	a, e := load(last24h)
	if e != nil {
		return nil, nil, e
	}
	z, e := load(last7d)
	return a, z, e
}
func (b *backend) adminVideoStats(ctx context.Context, last7d time.Time) (map[string]any, error) {
	rows, e := b.db.Query(ctx, `SELECT model,status,count(*),COALESCE(sum(CASE WHEN status='completed' THEN credits_consumed ELSE 0 END),0),COALESCE(sum(CASE WHEN status='completed' THEN duration_seconds ELSE 0 END),0),COALESCE(sum(CASE WHEN status='completed' AND completed_at IS NOT NULL THEN extract(epoch FROM(completed_at-created_at)) ELSE 0 END),0),count(*) FILTER(WHERE status='completed' AND completed_at IS NOT NULL) FROM video_generation WHERE created_at >= $1 GROUP BY model,status`, last7d)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	total, completed, failed, running, pending := int64(0), int64(0), int64(0), int64(0), int64(0)
	var credits, seconds, latency float64
	var latCount int64
	models := map[string]map[string]any{}
	for rows.Next() {
		var model, status string
		var n, lc int64
		var c, s, l float64
		if e = rows.Scan(&model, &status, &n, &c, &s, &l, &lc); e != nil {
			return nil, e
		}
		total += n
		item := models[model]
		if item == nil {
			item = map[string]any{"model": model, "total": int64(0), "completed": int64(0), "failed": int64(0)}
			models[model] = item
		}
		item["total"] = item["total"].(int64) + n
		switch status {
		case "completed":
			completed += n
			item["completed"] = item["completed"].(int64) + n
			credits += c
			seconds += s
			latency += l
			latCount += lc
		case "failed":
			failed += n
			item["failed"] = item["failed"].(int64) + n
		case "running":
			running += n
		default:
			pending += n
		}
	}
	finished := completed + failed
	rate := 1.0
	if finished > 0 {
		rate = float64(completed) / float64(finished)
	}
	var avg any
	if latCount > 0 {
		avg = latency / float64(latCount)
	}
	arr := []any{}
	for _, m := range models {
		arr = append(arr, m)
	}
	return map[string]any{"total": total, "completed": completed, "failed": failed, "running": running, "pending": pending, "successRate": rate, "creditsConsumed": credits, "totalVideoSeconds": seconds, "avgLatencySeconds": avg, "byModel": arr}, rows.Err()
}
func (b *backend) adminTopErrors(ctx context.Context, last7d, last24h time.Time) ([]any, bool, error) {
	rows, e := b.db.Query(ctx, `SELECT status,error,created_at FROM generation WHERE created_at >= $1 ORDER BY created_at DESC LIMIT 10000`, last7d)
	if e != nil {
		return nil, false, e
	}
	defer rows.Close()
	counts := map[string]map[string]any{}
	n := 0
	for rows.Next() {
		var status string
		var msg *string
		var created time.Time
		if e = rows.Scan(&status, &msg, &created); e != nil {
			return nil, false, e
		}
		if created.Before(last24h) || status != "failed" {
			continue
		}
		text := "Unknown error"
		if msg != nil && strings.TrimSpace(*msg) != "" {
			text = strings.Join(strings.Fields(*msg), " ")
		}
		if len(text) > 140 {
			text = text[:137] + "..."
		}
		item := counts[text]
		if item == nil {
			item = map[string]any{"message": text, "count": int64(0), "category": adminStatusErrorCategory(msg)}
			counts[text] = item
		}
		item["count"] = item["count"].(int64) + 1
		n++
	}
	out := make([]map[string]any, 0, len(counts))
	for _, v := range counts {
		out = append(out, v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i]["count"].(int64) > out[j]["count"].(int64) })
	limited := n >= 10000
	if len(out) > 8 {
		out = out[:8]
	}
	returnAny := make([]any, len(out))
	for i := range out {
		returnAny[i] = out[i]
	}
	return returnAny, limited, nil
}
