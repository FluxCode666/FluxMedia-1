package main

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func (b *backend) registerSupportDashboardRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/support/dashboard-configuration", b.endpoint(b.handleDashboardSupportConfiguration))
	mux.HandleFunc("GET /api/support/tickets", b.endpoint(b.handleTicketList))
	mux.HandleFunc("GET /api/support/tickets/unread-count", b.endpoint(b.handleTicketUnreadCount))
	mux.HandleFunc("POST /api/support/tickets", b.endpoint(b.handleTicketCreate))
	mux.HandleFunc("GET /api/support/tickets/{id}/messages", b.endpoint(b.handleTicketMessages))
	mux.HandleFunc("POST /api/support/tickets/{id}/messages", b.endpoint(b.handleTicketAddMessage))
	mux.HandleFunc("POST /api/support/tickets/{id}/seen", b.endpoint(b.handleTicketSeen))
	mux.HandleFunc("PATCH /api/support/tickets/{id}/status", b.endpoint(b.handleTicketStatus))
	mux.HandleFunc("GET /api/announcements", b.endpoint(b.handleAnnouncementList))
	mux.HandleFunc("POST /api/announcements/read", b.endpoint(b.handleAnnouncementRead))
	mux.HandleFunc("POST /api/announcements/read-all", b.endpoint(b.handleAnnouncementReadAll))
	mux.HandleFunc("GET /api/announcements/unread-count", b.endpoint(b.handleAnnouncementUnread))
	mux.HandleFunc("GET /api/admin/announcements", b.endpoint(b.handleAnnouncementAdminList))
	mux.HandleFunc("POST /api/admin/announcements", b.endpoint(b.handleAnnouncementCreate))
	mux.HandleFunc("PUT /api/admin/announcements/{id}", b.endpoint(b.handleAnnouncementUpdate))
	mux.HandleFunc("DELETE /api/admin/announcements/{id}", b.endpoint(b.handleAnnouncementDelete))
	mux.HandleFunc("POST /api/admin/announcements/{id}/toggle", b.endpoint(b.handleAnnouncementToggle))
	mux.HandleFunc("GET /api/referrals/dashboard", b.endpoint(b.handleReferralDashboard))
	mux.HandleFunc("GET /api/referrals/relationships", b.endpoint(b.handleReferralRelationships))
	mux.HandleFunc("POST /api/analytics/data-dashboard", b.endpoint(b.handleDataDashboard))
	mux.HandleFunc("POST /api/admin/analytics/data-dashboard", b.endpoint(b.handleAdminDataDashboard))
	mux.HandleFunc("GET /api/admin/analytics/users", b.endpoint(b.handleAdminAnalyticsUsers))
	mux.HandleFunc("GET /api/analytics/summary", b.endpoint(b.handleAnalyticsSummary))
}

// handleDashboardSupportConfiguration returns the small, explicitly public subset of
// system settings rendered by the dashboard support card. Authentication is still
// required, while the setting itself is read-only for ordinary users.
func (b *backend) handleDashboardSupportConfiguration(w http.ResponseWriter, r *http.Request) error {
	if _, err := b.requireSession(r); err != nil {
		return err
	}
	value, err := b.setting(r.Context(), "DASHBOARD_SUPPORT_CONFIG", defaultDashboardSupportConfiguration())
	if err != nil {
		return err
	}
	// A malformed historical value must not break every dashboard page. The shared
	// TypeScript operation applies the same safe-default behavior after schema parsing.
	if _, ok := value.(map[string]any); !ok {
		value = defaultDashboardSupportConfiguration()
	}
	writeJSON(w, http.StatusOK, value)
	return nil
}

func defaultDashboardSupportConfiguration() map[string]any {
	localized := func(zh, en string) map[string]any {
		return map[string]any{"zh": zh, "en": en}
	}
	return map[string]any{
		"version": 1,
		"officialSupport": map[string]any{
			"enabled":     true,
			"channel":     localized("官方支持中心", "Official support center"),
			"description": localized("通过站内工单联系官方支持，处理账户、积分、支付与服务接入问题。", "Contact the official team for account, credits, billing, and service integration help."),
			"actionLabel": localized("联系支持", "Contact support"),
			"actionUrl":   "/dashboard/support/new",
		},
		"services": []any{
			map[string]any{"id": "system-docs", "enabled": true, "icon": "documentation", "title": localized("API 文档", "API docs"), "description": localized("查看图像 API 接口和使用说明", "Explore image APIs and usage guides"), "actionLabel": localized("查看", "Open"), "url": "/dashboard/api-docs"},
			map[string]any{"id": "support-tickets", "enabled": true, "icon": "support", "title": localized("支持工单", "Support tickets"), "description": localized("查看问题进度并与支持团队沟通", "Track requests and communicate with the support team"), "actionLabel": localized("进入", "Open"), "url": "/dashboard/support"},
			map[string]any{"id": "announcements", "enabled": true, "icon": "website", "title": localized("平台公告", "Announcements"), "description": localized("了解服务更新、维护与重要通知", "Read service updates, maintenance notes, and notices"), "actionLabel": localized("查看", "Open"), "url": "/dashboard/announcements"},
		},
	}
}

func (b *backend) handleTicketUnreadCount(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireSession(r)
	if err != nil {
		return err
	}
	var n int
	if s.User.Role == "admin" || s.User.Role == "super_admin" {
		err = b.db.QueryRow(r.Context(), `SELECT count(*) FROM ticket WHERE last_user_activity_at IS NOT NULL AND (admin_last_seen_at IS NULL OR last_user_activity_at>admin_last_seen_at)`).Scan(&n)
	} else {
		err = b.db.QueryRow(r.Context(), `SELECT count(*) FROM ticket WHERE user_id=$1 AND last_admin_activity_at IS NOT NULL AND (user_last_seen_at IS NULL OR last_admin_activity_at>user_last_seen_at)`, s.User.ID).Scan(&n)
	}
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]int{"count": n})
	return nil
}

// handleAnalyticsSummary serves the dashboard's immutable usage summary directly from
// the Go read models. The session user is the only accepted scope.
func (b *backend) handleAnalyticsSummary(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireSession(r)
	if err != nil {
		return err
	}
	asOf := time.Now().UTC()
	start := asOf.Add(-24 * time.Hour)
	var image24, video24 int
	if err = b.db.QueryRow(r.Context(), `SELECT COALESCE(sum(image_count),0),COALESCE(sum(video_seconds),0) FROM user_output_usage_event WHERE user_id=$1 AND operation_created_at >= $2 AND operation_created_at < $3`, s.User.ID, start, asOf).Scan(&image24, &video24); err != nil {
		return err
	}
	var imageLife, videoLife int
	if err = b.db.QueryRow(r.Context(), `SELECT COALESCE(sum(image_count),0),COALESCE(sum(video_seconds),0) FROM user_output_usage_event WHERE user_id=$1`, s.User.ID).Scan(&imageLife, &videoLife); err != nil {
		return err
	}
	var credit24, creditLife float64
	_ = b.db.QueryRow(r.Context(), `SELECT COALESCE(sum(net_consumed),0) FROM credit_usage_operation WHERE user_id=$1 AND operation_created_at >= $2 AND operation_created_at < $3`, s.User.ID, start, asOf).Scan(&credit24)
	_ = b.db.QueryRow(r.Context(), `SELECT COALESCE(sum(net_consumed),0) FROM credit_usage_operation WHERE user_id=$1`, s.User.ID).Scan(&creditLife)
	rows, err := b.db.Query(r.Context(), `SELECT COALESCE(NULLIF(TRIM(g.model),''),NULLIF(TRIM(v.model),''),'unknown'),count(*) FROM user_output_usage_event e LEFT JOIN generation g ON e.output_kind='image' AND e.source_task_id=g.id AND e.user_id=g.user_id LEFT JOIN video_generation v ON e.output_kind='video' AND e.source_task_id=v.id AND e.user_id=v.user_id WHERE e.user_id=$1 AND e.operation_created_at >= $2 AND e.operation_created_at < $3 GROUP BY 1 ORDER BY 1`, s.User.ID, start, asOf)
	if err != nil {
		return err
	}
	models := []any{}
	total := 0
	for rows.Next() {
		var m string
		var n int
		if err = rows.Scan(&m, &n); err != nil {
			rows.Close()
			return err
		}
		models = append(models, map[string]any{"model": m, "taskCount": n})
		total += n
	}
	rows.Close()
	zone := "UTC"
	var userZone *string
	if zoneErr := b.db.QueryRow(r.Context(), `SELECT time_zone FROM "user" WHERE id=$1`, s.User.ID).Scan(&userZone); zoneErr == nil && userZone != nil {
		if _, loadErr := time.LoadLocation(*userZone); loadErr == nil {
			zone = *userZone
		}
	}
	dist := map[string]any{"models": models, "totalTasks": total}
	writeJSON(w, 200, map[string]any{"asOf": asOf.Format(time.RFC3339Nano), "timeZone": zone, "last24HoursRange": map[string]any{"start": start.Format(time.RFC3339Nano), "end": asOf.Format(time.RFC3339Nano)}, "last24Hours": map[string]any{"imageCount": image24, "videoSeconds": video24, "creditsConsumed": credit24}, "modelDistribution": dist, "lifetime": map[string]any{"imageCount": imageLife, "videoSeconds": videoLife, "creditsConsumed": creditLife}})
	return nil
}

func (b *backend) handleTicketCreate(w http.ResponseWriter, r *http.Request) error {
	s, e := b.requireSession(r)
	if e != nil {
		return e
	}
	var in struct{ Subject, Category, Priority, Message string }
	if e = decodeBody(r, &in); e != nil {
		return e
	}
	if strings.TrimSpace(in.Subject) == "" || strings.TrimSpace(in.Message) == "" {
		return invalid("subject and message are required")
	}
	if in.Category == "" {
		in.Category = "other"
	}
	if in.Priority == "" {
		in.Priority = "medium"
	}
	id := supportRandomID()
	now := time.Now()
	_, e = b.db.Exec(r.Context(), `INSERT INTO ticket(id,user_id,subject,category,priority,status,user_last_seen_at,last_user_activity_at,updated_at) VALUES($1,$2,$3,$4,$5,'open',$6,$6,$6)`, id, s.User.ID, in.Subject, in.Category, in.Priority, now)
	if e != nil {
		return e
	}
	_, e = b.db.Exec(r.Context(), `INSERT INTO ticket_message(id,ticket_id,user_id,content,is_admin_response) VALUES($1,$2,$3,$4,false)`, supportRandomID(), id, s.User.ID, in.Message)
	if e != nil {
		return e
	}
	writeJSON(w, 201, map[string]any{"message": "工单创建成功", "ticketId": id})
	return nil
}
func (b *backend) handleTicketList(w http.ResponseWriter, r *http.Request) error {
	s, e := b.requireSession(r)
	if e != nil {
		return e
	}
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if page < 1 {
		page = 1
	}
	size, _ := strconv.Atoi(r.URL.Query().Get("pageSize"))
	if size != 10 && size != 20 && size != 50 {
		size = 20
	}
	status, search := r.URL.Query().Get("status"), strings.TrimSpace(r.URL.Query().Get("search"))
	isAdmin := s.User.Role == "admin" || s.User.Role == "super_admin"
	where := "t.user_id=$1"
	args := []any{s.User.ID}
	if isAdmin {
		where = "TRUE"
		args = nil
	}
	if status != "" && status != "all" {
		args = append(args, status)
		where += " AND t.status=$" + strconv.Itoa(len(args))
	}
	if search != "" {
		args = append(args, "%"+search+"%")
		n := strconv.Itoa(len(args))
		if isAdmin {
			where += " AND (t.subject ILIKE $" + n + " OR u.email ILIKE $" + n + " OR u.name ILIKE $" + n + ")"
		} else {
			where += " AND t.subject ILIKE $" + n
		}
	}
	var total int
	if e = b.db.QueryRow(r.Context(), `SELECT count(*) FROM ticket t LEFT JOIN "user" u ON u.id=t.user_id WHERE `+where, args...).Scan(&total); e != nil {
		return e
	}
	totalPages := 1
	if total > 0 {
		totalPages = (total + size - 1) / size
	}
	if page > totalPages {
		page = totalPages
	}
	args = append(args, size, (page-1)*size)
	q := `SELECT t.id,t.user_id,t.subject,t.category,t.priority,t.status,t.user_last_seen_at,t.last_admin_activity_at,t.admin_last_seen_at,t.last_user_activity_at,t.created_at,t.updated_at,u.name,u.email FROM ticket t LEFT JOIN "user" u ON u.id=t.user_id WHERE ` + where + ` ORDER BY t.updated_at DESC,t.id DESC LIMIT $` + strconv.Itoa(len(args)-1) + ` OFFSET $` + strconv.Itoa(len(args))
	rows, e := b.db.Query(r.Context(), q, args...)
	if e != nil {
		return e
	}
	defer rows.Close()
	items := []any{}
	for rows.Next() {
		var id, uid, sub, cat, pri, st string
		var ul, ca, ua time.Time
		var la, al, lu *time.Time
		var n, em *string
		if e = rows.Scan(&id, &uid, &sub, &cat, &pri, &st, &ul, &la, &al, &lu, &ca, &ua, &n, &em); e != nil {
			return e
		}
		unread := false
		if isAdmin {
			unread = lu != nil && (al == nil || lu.After(*al))
		} else {
			unread = la != nil && la.After(ul)
		}
		items = append(items, map[string]any{"id": id, "userId": uid, "subject": sub, "category": cat, "priority": pri, "status": st, "unread": unread, "createdAt": ca, "updatedAt": ua, "userName": n, "userEmail": em})
	}
	if e = rows.Err(); e != nil {
		return e
	}
	writeJSON(w, http.StatusOK, map[string]any{"records": items, "items": items, "page": page, "pageSize": size, "totalCount": total, "total": total, "totalPages": totalPages})
	return nil
}

func (b *backend) ticketAccess(ctx context.Context, s *sessionResponse, id string) (bool, error) {
	if s.User.Role == "admin" || s.User.Role == "super_admin" {
		return true, nil
	}
	var ok bool
	e := b.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM ticket WHERE id=$1 AND user_id=$2)`, id, s.User.ID).Scan(&ok)
	return ok, e
}
func (b *backend) handleTicketMessages(w http.ResponseWriter, r *http.Request) error {
	s, e := b.requireSession(r)
	if e != nil {
		return e
	}
	id := r.PathValue("id")
	ok, e := b.ticketAccess(r.Context(), s, id)
	if e != nil {
		return e
	}
	if !ok {
		return invalid("工单不存在")
	}
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if page < 1 {
		page = 1
	}
	size, _ := strconv.Atoi(r.URL.Query().Get("pageSize"))
	if size != 10 && size != 20 && size != 50 {
		size = 20
	}
	var sub, uid, cat, pri, st string
	var ul, ca, ua time.Time
	var la, al, lu *time.Time
	var uname, uemail, uimage *string
	e = b.db.QueryRow(r.Context(), `SELECT t.id,t.user_id,t.subject,t.category,t.priority,t.status,t.user_last_seen_at,t.last_admin_activity_at,t.admin_last_seen_at,t.last_user_activity_at,t.created_at,t.updated_at,u.name,u.email,u.image FROM ticket t LEFT JOIN "user" u ON u.id=t.user_id WHERE t.id=$1`, id).Scan(new(string), &uid, &sub, &cat, &pri, &st, &ul, &la, &al, &lu, &ca, &ua, &uname, &uemail, &uimage)
	if e != nil {
		if e == pgx.ErrNoRows {
			return invalid("工单不存在")
		}
		return e
	}
	var total int
	if e = b.db.QueryRow(r.Context(), `SELECT count(*) FROM ticket_message WHERE ticket_id=$1`, id).Scan(&total); e != nil {
		return e
	}
	totalPages := 1
	if total > 0 {
		totalPages = (total + size - 1) / size
	}
	if page > totalPages {
		page = totalPages
	}
	rows, e := b.db.Query(r.Context(), `SELECT m.id,m.content,m.is_admin_response,m.created_at,u.id,u.name,u.image FROM ticket_message m LEFT JOIN "user" u ON u.id=m.user_id WHERE m.ticket_id=$1 ORDER BY m.created_at DESC,m.id DESC LIMIT $2 OFFSET $3`, id, size, (page-1)*size)
	if e != nil {
		return e
	}
	defer rows.Close()
	msgs := []any{}
	for rows.Next() {
		var mid, c string
		var adm bool
		var t time.Time
		var xid, xn, xi *string
		if e = rows.Scan(&mid, &c, &adm, &t, &xid, &xn, &xi); e != nil {
			return e
		}
		msgs = append(msgs, map[string]any{"id": mid, "content": c, "isAdminResponse": adm, "createdAt": t, "user": map[string]any{"id": xid, "name": xn, "image": xi}})
	}
	if e = rows.Err(); e != nil {
		return e
	}
	for i, j := 0, len(msgs)-1; i < j; i, j = i+1, j-1 {
		msgs[i], msgs[j] = msgs[j], msgs[i]
	}
	ticket := map[string]any{"id": id, "userId": uid, "subject": sub, "category": cat, "priority": pri, "status": st, "userLastSeenAt": ul, "lastAdminActivityAt": la, "adminLastSeenAt": al, "lastUserActivityAt": lu, "createdAt": ca, "updatedAt": ua}
	user := any(nil)
	if uname != nil || uemail != nil || uimage != nil {
		user = map[string]any{"id": uid, "name": uname, "email": uemail, "image": uimage}
	}
	msgPage := map[string]any{"records": msgs, "items": msgs, "page": page, "pageSize": size, "totalCount": total, "total": total, "totalPages": totalPages}
	writeJSON(w, http.StatusOK, map[string]any{"ticket": ticket, "ticketUser": user, "messages": msgPage})
	return nil
}

func (b *backend) handleTicketAddMessage(w http.ResponseWriter, r *http.Request) error {
	s, e := b.requireSession(r)
	if e != nil {
		return e
	}
	id := r.PathValue("id")
	ok, e := b.ticketAccess(r.Context(), s, id)
	if e != nil {
		return e
	}
	if !ok {
		return forbidden()
	}
	var in struct {
		Content string `json:"content"`
	}
	if e = decodeBody(r, &in); e != nil {
		return e
	}
	if strings.TrimSpace(in.Content) == "" {
		return invalid("content is required")
	}
	var st string
	e = b.db.QueryRow(r.Context(), `SELECT status FROM ticket WHERE id=$1`, id).Scan(&st)
	if e != nil {
		return e
	}
	if st == "closed" {
		return invalid("工单已关闭")
	}
	now := time.Now()
	_, e = b.db.Exec(r.Context(), `INSERT INTO ticket_message(id,ticket_id,user_id,content,is_admin_response) VALUES($1,$2,$3,$4,$5)`, supportRandomID(), id, s.User.ID, in.Content, s.User.Role == "admin" || s.User.Role == "super_admin")
	if e != nil {
		return e
	}
	if s.User.Role == "admin" || s.User.Role == "super_admin" {
		_, e = b.db.Exec(r.Context(), `UPDATE ticket SET status=CASE WHEN status='open' THEN 'in_progress' ELSE status END,last_admin_activity_at=$1,admin_last_seen_at=$1,updated_at=$1 WHERE id=$2`, now, id)
	} else {
		_, e = b.db.Exec(r.Context(), `UPDATE ticket SET last_user_activity_at=$1,updated_at=$1 WHERE id=$2`, now, id)
	}
	if e != nil {
		return e
	}
	writeJSON(w, 200, map[string]string{"message": "消息发送成功"})
	return nil
}
func (b *backend) handleTicketSeen(w http.ResponseWriter, r *http.Request) error {
	s, e := b.requireSession(r)
	if e != nil {
		return e
	}
	id := r.PathValue("id")
	ok, e := b.ticketAccess(r.Context(), s, id)
	if e != nil {
		return e
	}
	if !ok {
		return forbidden()
	}
	now := time.Now()
	if s.User.Role == "admin" || s.User.Role == "super_admin" {
		_, e = b.db.Exec(r.Context(), `UPDATE ticket SET admin_last_seen_at=$1 WHERE id=$2`, now, id)
	} else {
		_, e = b.db.Exec(r.Context(), `UPDATE ticket SET user_last_seen_at=$1 WHERE id=$2`, now, id)
	}
	if e != nil {
		return e
	}
	writeJSON(w, 200, map[string]any{"seenAt": now})
	return nil
}
func (b *backend) handleTicketStatus(w http.ResponseWriter, r *http.Request) error {
	if _, e := b.requireAdmin(r, false); e != nil {
		return e
	}
	var in struct {
		Status string `json:"status"`
	}
	if e := decodeBody(r, &in); e != nil {
		return e
	}
	if in.Status != "open" && in.Status != "in_progress" && in.Status != "resolved" && in.Status != "closed" {
		return invalid("invalid status")
	}
	_, e := b.db.Exec(r.Context(), `UPDATE ticket SET status=$1,last_admin_activity_at=now(),admin_last_seen_at=now(),updated_at=now() WHERE id=$2`, in.Status, r.PathValue("id"))
	if e != nil {
		return e
	}
	writeJSON(w, 200, map[string]string{"message": "状态更新成功"})
	return nil
}

func (b *backend) handleAnnouncementList(w http.ResponseWriter, r *http.Request) error {
	s, e := b.requireSession(r)
	if e != nil {
		return e
	}
	page, pageSize := announcementPageParams(r, 20)
	var total int
	if e = b.db.QueryRow(r.Context(), `SELECT count(*) FROM announcement WHERE is_published=true AND (published_at IS NULL OR published_at<=now()) AND (expires_at IS NULL OR expires_at>now())`).Scan(&total); e != nil {
		return e
	}
	rows, e := b.db.Query(r.Context(), `SELECT a.id,a.title,a.content,a.severity,a.is_published,a.is_pinned,a.priority,a.published_at,a.expires_at,a.created_at,a.updated_at, ar.read_at FROM announcement a LEFT JOIN announcement_read ar ON ar.announcement_id=a.id AND ar.user_id=$1 WHERE a.is_published=true AND (a.published_at IS NULL OR a.published_at<=now()) AND (a.expires_at IS NULL OR a.expires_at>now()) ORDER BY a.is_pinned DESC,a.priority DESC,a.published_at DESC NULLS LAST,a.created_at DESC,a.id DESC LIMIT $2 OFFSET $3`, s.User.ID, pageSize, (page-1)*pageSize)
	if e != nil {
		return e
	}
	defer rows.Close()
	out := []any{}
	for rows.Next() {
		var id, t, c, sev string
		var pub, pin bool
		var pr int
		var pa, ea, ca, ua, ra *time.Time
		if e = rows.Scan(&id, &t, &c, &sev, &pub, &pin, &pr, &pa, &ea, &ca, &ua, &ra); e != nil {
			return e
		}
		isRead := ra != nil && ua != nil && !ra.Before(*ua)
		out = append(out, map[string]any{"id": id, "title": t, "content": c, "severity": sev, "isPinned": pin, "priority": pr, "publishedAt": pa, "expiresAt": ea, "createdAt": ca, "updatedAt": ua, "isRead": isRead})
	}
	if e = rows.Err(); e != nil {
		return e
	}
	writeJSON(w, 200, map[string]any{"items": out, "records": out, "announcements": out, "total": total, "totalCount": total, "page": page, "pageSize": pageSize, "totalPages": maxAnnouncementPages(total, pageSize)})
	return nil
}

func announcementPageParams(r *http.Request, defaultSize int) (int, int) {
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if page < 1 {
		page = 1
	}
	pageSize, _ := strconv.Atoi(r.URL.Query().Get("pageSize"))
	if pageSize <= 0 {
		pageSize = defaultSize
	}
	if pageSize > 100 {
		pageSize = 100
	}
	return page, pageSize
}
func maxAnnouncementPages(total, pageSize int) int {
	if pageSize <= 0 || total <= 0 {
		return 1
	}
	return (total + pageSize - 1) / pageSize
}

func (b *backend) handleAnnouncementRead(w http.ResponseWriter, r *http.Request) error {
	s, e := b.requireSession(r)
	if e != nil {
		return e
	}
	var in struct {
		ID string `json:"id"`
	}
	if e = decodeBody(r, &in); e != nil {
		return e
	}
	if in.ID == "" {
		return invalid("id is required")
	}
	var exists bool
	if e = b.db.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM announcement WHERE id=$1)`, in.ID).Scan(&exists); e != nil {
		return e
	}
	if !exists {
		return &apiError{404, "NOT_FOUND", "公告不存在"}
	}
	result, e := b.db.Exec(r.Context(), `INSERT INTO announcement_read(id,announcement_id,user_id,read_at) VALUES($1,$2,$3,now()) ON CONFLICT (user_id,announcement_id) DO UPDATE SET read_at=EXCLUDED.read_at`, supportRandomID(), in.ID, s.User.ID)
	if e != nil {
		return e
	}
	if result.RowsAffected() == 0 {
		return &apiError{404, "NOT_FOUND", "公告不存在"}
	}
	writeJSON(w, 200, map[string]string{"message": "已标记为已读"})
	return nil
}

func (b *backend) handleAnnouncementReadAll(w http.ResponseWriter, r *http.Request) error {
	s, e := b.requireSession(r)
	if e != nil {
		return e
	}
	result, e := b.db.Exec(r.Context(), `INSERT INTO announcement_read(id,announcement_id,user_id,read_at)
SELECT $1 || a.id, a.id, $2, now() FROM announcement a
LEFT JOIN announcement_read ar ON ar.announcement_id=a.id AND ar.user_id=$2
WHERE a.is_published=true AND (a.published_at IS NULL OR a.published_at<=now()) AND (a.expires_at IS NULL OR a.expires_at>now())
  AND (ar.id IS NULL OR ar.read_at<a.updated_at)
ON CONFLICT (user_id,announcement_id) DO UPDATE SET read_at=EXCLUDED.read_at`, supportRandomID()+"-", s.User.ID)
	if e != nil {
		return e
	}
	writeJSON(w, 200, map[string]any{"count": result.RowsAffected()})
	return nil
}

func (b *backend) handleAnnouncementUnread(w http.ResponseWriter, r *http.Request) error {
	s, e := b.requireSession(r)
	if e != nil {
		return e
	}
	var n int
	e = b.db.QueryRow(r.Context(), `SELECT count(*) FROM announcement a LEFT JOIN announcement_read ar ON ar.announcement_id=a.id AND ar.user_id=$1 WHERE a.is_published=true AND (ar.id IS NULL OR ar.read_at<a.updated_at)`, s.User.ID).Scan(&n)
	if e != nil {
		return e
	}
	writeJSON(w, 200, map[string]int{"count": n})
	return nil
}

func supportRandomID() string {
	if s, e := randomToken(16); e == nil {
		return s
	}
	return fmt.Sprintf("%d", time.Now().UnixNano())
}

func (b *backend) handleAnnouncementCreate(w http.ResponseWriter, r *http.Request) error {
	s, e := b.requireAdmin(r, false)
	if e != nil {
		return e
	}
	var in struct {
		Title, Content, Severity string
		IsPublished, IsPinned    bool
		Priority                 int
		PublishedAt, ExpiresAt   *time.Time
	}
	if e = decodeBody(r, &in); e != nil {
		return e
	}
	if err := validateAnnouncementInput(in.Title, in.Content, in.Severity, in.Priority, in.PublishedAt, in.ExpiresAt); err != nil {
		return err
	}
	id := supportRandomID()
	_, e = b.db.Exec(r.Context(), `INSERT INTO announcement(id,title,content,severity,is_published,is_pinned,priority,published_at,expires_at,created_by_user_id,updated_by_user_id) VALUES($1,$2,$3,COALESCE(NULLIF($4,''),'info'),$5,$6,$7,$8,$9,$10,$10)`, id, strings.TrimSpace(in.Title), strings.TrimSpace(in.Content), in.Severity, in.IsPublished, in.IsPinned, in.Priority, in.PublishedAt, in.ExpiresAt, s.User.ID)
	if e != nil {
		return e
	}
	writeJSON(w, 201, map[string]any{"id": id, "message": "公告已创建"})
	return nil
}
func (b *backend) handleAnnouncementUpdate(w http.ResponseWriter, r *http.Request) error {
	s, e := b.requireAdmin(r, false)
	if e != nil {
		return e
	}
	id := r.PathValue("id")
	var in struct {
		Title, Content, Severity string
		IsPublished, IsPinned    bool
		Priority                 int
		PublishedAt, ExpiresAt   *time.Time
	}
	if e = decodeBody(r, &in); e != nil {
		return e
	}
	if err := validateAnnouncementInput(in.Title, in.Content, in.Severity, in.Priority, in.PublishedAt, in.ExpiresAt); err != nil {
		return err
	}
	result, e := b.db.Exec(r.Context(), `UPDATE announcement SET title=$1,content=$2,severity=$3,is_published=$4,is_pinned=$5,priority=$6,published_at=$7,expires_at=$8,updated_by_user_id=$9,updated_at=now() WHERE id=$10`, strings.TrimSpace(in.Title), strings.TrimSpace(in.Content), in.Severity, in.IsPublished, in.IsPinned, in.Priority, in.PublishedAt, in.ExpiresAt, s.User.ID, id)
	if e != nil {
		return e
	}
	if result.RowsAffected() != 1 {
		return &apiError{404, "NOT_FOUND", "公告不存在"}
	}
	writeJSON(w, 200, map[string]string{"message": "公告已更新"})
	return nil
}
func (b *backend) handleAnnouncementDelete(w http.ResponseWriter, r *http.Request) error {
	if _, e := b.requireAdmin(r, false); e != nil {
		return e
	}
	result, e := b.db.Exec(r.Context(), `DELETE FROM announcement WHERE id=$1`, r.PathValue("id"))
	if e != nil {
		return e
	}
	if result.RowsAffected() != 1 {
		return &apiError{404, "NOT_FOUND", "公告不存在"}
	}
	writeJSON(w, 200, map[string]string{"message": "公告已删除"})
	return nil
}
func (b *backend) handleAnnouncementToggle(w http.ResponseWriter, r *http.Request) error {
	s, e := b.requireAdmin(r, false)
	if e != nil {
		return e
	}
	var p bool
	e = b.db.QueryRow(r.Context(), `UPDATE announcement SET is_published=NOT is_published,published_at=CASE WHEN NOT is_published AND published_at IS NULL THEN now() ELSE published_at END,updated_by_user_id=$1,updated_at=now() WHERE id=$2 RETURNING is_published`, s.User.ID, r.PathValue("id")).Scan(&p)
	if e != nil {
		if e == pgx.ErrNoRows {
			return &apiError{404, "NOT_FOUND", "公告不存在"}
		}
		return e
	}
	writeJSON(w, 200, map[string]any{"isPublished": p})
	return nil
}

func validateAnnouncementInput(title, content, severity string, priority int, publishedAt, expiresAt *time.Time) error {
	title = strings.TrimSpace(title)
	content = strings.TrimSpace(content)
	if len([]rune(title)) < 2 || len([]rune(title)) > 160 {
		return invalid("标题长度必须为 2-160 个字符")
	}
	if len([]rune(content)) < 2 || len([]rune(content)) > 10000 {
		return invalid("内容长度必须为 2-10000 个字符")
	}
	switch severity {
	case "", "info", "success", "warning", "critical":
	default:
		return invalid("severity 无效")
	}
	if priority < 0 || priority > 999 {
		return invalid("priority 无效")
	}
	if publishedAt != nil && expiresAt != nil && !expiresAt.After(*publishedAt) {
		return invalid("expiresAt must be after publishedAt")
	}
	return nil
}
func (b *backend) handleReferralDashboard(w http.ResponseWriter, r *http.Request) error {
	s, e := b.requireSession(r)
	if e != nil {
		return e
	}
	var code string
	e = b.db.QueryRow(r.Context(), `SELECT code FROM referral_profile WHERE user_id=$1`, s.User.ID).Scan(&code)
	if e != nil && e != pgx.ErrNoRows {
		return e
	}
	if code == "" {
		code = supportRandomID()[:12]
		_, e = b.db.Exec(r.Context(), `INSERT INTO referral_profile(user_id,code) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING`, s.User.ID, code)
		if e != nil {
			return e
		}
	}
	var invited, rewarded int
	var total float64
	e = b.db.QueryRow(r.Context(), `SELECT count(*),count(*) FILTER(WHERE status='rewarded'),COALESCE(sum(inviter_reward_credits),0) FROM referral_relationship WHERE inviter_user_id=$1`, s.User.ID).Scan(&invited, &rewarded, &total)
	if e != nil {
		return e
	}
	base := strings.TrimRight(b.config.authURL, "/")
	if base == "" {
		base = "http://localhost:3000"
	}
	rewardConfig, err := b.referralRewardConfig(r.Context())
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"code": code, "inviteUrl": base + "/r/" + code, "invitedCount": invited, "rewardedCount": rewarded, "totalRewardCredits": total, "rewardConfig": rewardConfig})
	return nil
}

// handleReferralRelationships returns the current user's complete, redacted
// relationship list. Identity is always derived from the authenticated session;
// no user id or pagination input is accepted from the browser.
func (b *backend) handleReferralRelationships(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireSession(r)
	if err != nil {
		return err
	}
	rows, err := b.db.Query(r.Context(), `SELECT rr.id,u.name,u.email,rr.status,rr.inviter_reward_credits,rr.invitee_reward_credits,rr.created_at,rr.rewarded_at FROM referral_relationship rr JOIN "user" u ON u.id=rr.invitee_user_id WHERE rr.inviter_user_id=$1 ORDER BY rr.created_at DESC,rr.id DESC`, s.User.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	records := make([]any, 0)
	for rows.Next() {
		var id, name, email, status string
		var inviterReward, inviteeReward float64
		var created time.Time
		var rewardedAt *time.Time
		if err := rows.Scan(&id, &name, &email, &status, &inviterReward, &inviteeReward, &created, &rewardedAt); err != nil {
			return err
		}
		if status != "pending" && status != "rewarded" && status != "skipped" {
			status = "pending"
		}
		records = append(records, map[string]any{
			"id": id, "inviteeName": name, "inviteeEmail": maskReferralEmail(email),
			"status": status, "inviterRewardCredits": inviterReward, "inviteeRewardCredits": inviteeReward,
			"createdAt": created.UTC().Format(time.RFC3339Nano), "rewardedAt": referralTimeString(rewardedAt),
		})
	}
	if err := rows.Err(); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"records": records, "totalCount": len(records)})
	return nil
}

func referralTimeString(value *time.Time) any {
	if value == nil {
		return nil
	}
	return value.UTC().Format(time.RFC3339Nano)
}

func maskReferralEmail(email string) string {
	parts := strings.SplitN(email, "@", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "***"
	}
	return parts[0][:1] + "***@" + parts[1]
}

func (b *backend) referralRewardConfig(ctx context.Context) (map[string]any, error) {
	fallback := map[string]any{
		"enabled": false,
		"inviter": map[string]any{"mode": "percentage", "value": 10.0},
		"invitee": map[string]any{"mode": "percentage", "value": 10.0},
	}
	value, err := b.setting(ctx, "REFERRAL_REWARD_CONFIG", fallback)
	if err != nil {
		return nil, err
	}
	candidate, ok := value.(map[string]any)
	if !ok {
		return fallback, nil
	}
	result := map[string]any{"enabled": false}
	if enabled, ok := candidate["enabled"].(bool); ok {
		result["enabled"] = enabled
	}
	for _, side := range []string{"inviter", "invitee"} {
		result[side] = normalizeReferralRewardSide(candidate[side], fallback[side].(map[string]any))
	}
	return result, nil
}

func normalizeReferralRewardSide(value any, fallback map[string]any) map[string]any {
	candidate, ok := value.(map[string]any)
	if !ok {
		return fallback
	}
	mode, _ := candidate["mode"].(string)
	if mode != "fixed" && mode != "percentage" {
		mode = fallback["mode"].(string)
	}
	amount := 0.0
	switch n := candidate["value"].(type) {
	case float64:
		amount = n
	case float32:
		amount = float64(n)
	case int:
		amount = float64(n)
	}
	if amount < 0 || amount != amount {
		amount = fallback["value"].(float64)
	}
	max := 100.0
	if mode == "fixed" {
		max = 1_000_000
	}
	if amount > max {
		amount = max
	}
	return map[string]any{"mode": mode, "value": amount}
}

func (b *backend) handleAnnouncementAdminList(w http.ResponseWriter, r *http.Request) error {
	if _, e := b.requireAdmin(r, false); e != nil {
		return e
	}
	page, pageSize := announcementPageParams(r, 20)
	filter := r.URL.Query().Get("published")
	where := ""
	args := []any{}
	if filter == "published" {
		where = " WHERE is_published=true"
	} else if filter == "unpublished" {
		where = " WHERE is_published=false"
	} else if filter != "" && filter != "all" {
		return invalid("published 无效")
	}
	var total int
	if e := b.db.QueryRow(r.Context(), "SELECT count(*) FROM announcement"+where, args...).Scan(&total); e != nil {
		return e
	}
	rows, e := b.db.Query(r.Context(), "SELECT id,title,content,severity,is_published,is_pinned,priority,published_at,expires_at,created_by_user_id,updated_by_user_id,created_at,updated_at FROM announcement"+where+" ORDER BY is_pinned DESC,updated_at DESC,id DESC LIMIT $1 OFFSET $2", pageSize, (page-1)*pageSize)
	if e != nil {
		return e
	}
	defer rows.Close()
	out := []any{}
	for rows.Next() {
		var id, t, c, sev string
		var pub, pin bool
		var pr int
		var pa, ea, ca, ua *time.Time
		var createdBy, updatedBy *string
		if e = rows.Scan(&id, &t, &c, &sev, &pub, &pin, &pr, &pa, &ea, &createdBy, &updatedBy, &ca, &ua); e != nil {
			return e
		}
		out = append(out, map[string]any{"id": id, "title": t, "content": c, "severity": sev, "isPublished": pub, "isPinned": pin, "priority": pr, "publishedAt": pa, "expiresAt": ea, "createdByUserId": createdBy, "updatedByUserId": updatedBy, "createdAt": ca, "updatedAt": ua})
	}
	var active, drafts, pinned int
	if e = b.db.QueryRow(r.Context(), `SELECT count(*) FILTER (WHERE is_published AND (published_at IS NULL OR published_at<=now()) AND (expires_at IS NULL OR expires_at>now())),count(*) FILTER (WHERE NOT is_published),count(*) FILTER (WHERE is_pinned) FROM announcement`).Scan(&active, &drafts, &pinned); e != nil {
		return e
	}
	writeJSON(w, 200, map[string]any{"items": out, "records": out, "total": total, "totalCount": total, "page": page, "pageSize": pageSize, "totalPages": maxAnnouncementPages(total, pageSize), "stats": map[string]int{"active": active, "drafts": drafts, "pinned": pinned}})
	return nil
}

func (b *backend) handleDataDashboard(w http.ResponseWriter, r *http.Request) error {
	s, e := b.requireSession(r)
	if e != nil {
		return e
	}
	var in struct {
		StartDate string `json:"startDate"`
		EndDate   string `json:"endDate"`
	}
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	return b.writeDataDashboard(w, r, s.User.ID, in.StartDate, in.EndDate)
}
func (b *backend) handleAdminDataDashboard(w http.ResponseWriter, r *http.Request) error {
	s, e := b.requireAdmin(r, false)
	if e != nil {
		return e
	}
	var in struct {
		UserID    string `json:"userId"`
		StartDate string `json:"startDate"`
		EndDate   string `json:"endDate"`
	}
	if e = decodeBody(r, &in); e != nil {
		return e
	}
	uid := in.UserID
	if uid == "" {
		uid = s.User.ID
	}
	return b.writeDataDashboard(w, r, uid, in.StartDate, in.EndDate)
}
func (b *backend) writeDataDashboard(w http.ResponseWriter, r *http.Request, uid, startDate, endDate string) error {
	asOf := time.Now().UTC()
	today := asOf.Format("2006-01-02")
	if startDate == "" {
		d := asOf.AddDate(0, 0, -6)
		startDate = d.Format("2006-01-02")
	}
	if endDate == "" {
		endDate = today
	}
	start, err := time.Parse("2006-01-02", startDate)
	if err != nil {
		return invalid("日期格式无效")
	}
	endDay, err := time.Parse("2006-01-02", endDate)
	if err != nil || endDay.Before(start) {
		return invalid("日期范围无效")
	}
	days := int(endDay.Sub(start).Hours()/24) + 1
	if days < 1 || days > 30 || endDate > today {
		return invalid("日期范围必须为 1 至 30 天且不能处于未来")
	}
	rangeEnd := endDay.AddDate(0, 0, 1)
	if endDate == today {
		rangeEnd = asOf
	}
	type bucket struct {
		imageCount, imageTasks, videoCount, videoSeconds int
		credits                                          float64
	}
	bs := make([]bucket, days)
	idx := func(t time.Time) int { return int(t.UTC().Truncate(24*time.Hour).Sub(start.UTC()) / (24 * time.Hour)) }
	rows, err := b.db.Query(r.Context(), `SELECT created_at,status,COALESCE(credits_consumed,0),COALESCE(model,'') FROM generation WHERE user_id=$1 AND created_at >= $2 AND created_at < $3`, uid, start.UTC(), rangeEnd)
	if err != nil {
		return err
	}
	for rows.Next() {
		var created time.Time
		var status, model string
		var c float64
		if err = rows.Scan(&created, &status, &c, &model); err != nil {
			rows.Close()
			return err
		}
		i := idx(created)
		if i < 0 || i >= days {
			continue
		}
		if status == "completed" {
			bs[i].imageCount++
			bs[i].imageTasks++
			bs[i].credits += c
		}
	}
	rows.Close()
	rows, err = b.db.Query(r.Context(), `SELECT created_at,status,COALESCE(duration_seconds,0),COALESCE(credits_consumed,0) FROM video_generation WHERE user_id=$1 AND created_at >= $2 AND created_at < $3`, uid, start.UTC(), rangeEnd)
	if err != nil {
		return err
	}
	for rows.Next() {
		var created time.Time
		var status string
		var sec int
		var c float64
		if err = rows.Scan(&created, &status, &sec, &c); err != nil {
			rows.Close()
			return err
		}
		i := idx(created)
		if i < 0 || i >= days {
			continue
		}
		if status == "completed" {
			bs[i].videoCount++
			bs[i].videoSeconds += sec
			bs[i].credits += c
		}
	}
	rows.Close()
	buckets := make([]any, days)
	var images, imageTasks, videos, seconds int
	var credits float64
	active := 0
	for i := 0; i < days; i++ {
		d := start.AddDate(0, 0, i)
		e := d.AddDate(0, 0, 1)
		if d.Format("2006-01-02") == today {
			e = asOf
		}
		x := bs[i]
		if x.imageTasks > 0 || x.videoCount > 0 {
			active++
		}
		images += x.imageCount
		imageTasks += x.imageTasks
		videos += x.videoCount
		seconds += x.videoSeconds
		credits += x.credits
		buckets[i] = map[string]any{"date": d.Format("2006-01-02"), "start": d.UTC().Format(time.RFC3339Nano), "end": e.UTC().Format(time.RFC3339Nano), "imageCount": x.imageCount, "imageTaskCount": x.imageTasks, "videoCount": x.videoCount, "videoSeconds": x.videoSeconds, "creditsConsumed": x.credits}
	}
	// Successful model distribution is intentionally bounded to the selected range.
	var mostModel *map[string]any
	var model string
	var modelCount int
	_ = b.db.QueryRow(r.Context(), `SELECT COALESCE(NULLIF(TRIM(model),''),'unknown'),count(*) FROM generation WHERE user_id=$1 AND status='completed' AND created_at >= $2 AND created_at < $3 GROUP BY 1 ORDER BY count(*) DESC,1 LIMIT 1`, uid, start.UTC(), rangeEnd).Scan(&model, &modelCount)
	if modelCount > 0 {
		m := map[string]any{"model": model, "taskCount": modelCount}
		mostModel = &m
	}
	terminal := imageTasks + videos
	snapshot := map[string]any{"asOf": asOf.Format(time.RFC3339Nano), "timeZone": "UTC", "today": today, "range": map[string]any{"startDate": startDate, "endDate": endDate, "start": start.UTC().Format(time.RFC3339Nano), "end": rangeEnd.UTC().Format(time.RFC3339Nano)}, "metrics": map[string]any{"imageCount": images, "videoSeconds": seconds, "creditsConsumed": credits, "successRate": map[string]any{"succeeded": terminal, "failed": 0, "terminal": terminal, "rate": func() any {
		if terminal == 0 {
			return nil
		}
		return float64(terminal) / float64(terminal)
	}()}, "activeDays": active, "mostUsedModel": mostModel}, "buckets": buckets, "taskComposition": map[string]any{"imageTaskCount": imageTasks, "videoCount": videos, "totalTasks": terminal}}
	writeJSON(w, 200, map[string]any{"status": "ready", "snapshot": snapshot})
	return nil
}
func (b *backend) handleAdminAnalyticsUsers(w http.ResponseWriter, r *http.Request) error {
	if _, e := b.requireAdmin(r, false); e != nil {
		return e
	}
	q := strings.TrimSpace(r.URL.Query().Get("query"))
	selected := strings.TrimSpace(r.URL.Query().Get("selectedUserId"))
	if q == "" && selected == "" {
		writeJSON(w, 200, map[string]any{"users": []any{}})
		return nil
	}
	limit := 20
	if n, e := strconv.Atoi(r.URL.Query().Get("limit")); e == nil && n > 0 && n <= 50 {
		limit = n
	}
	pattern := "%" + q + "%"
	query := `SELECT id,name,email FROM "user" WHERE (name ILIKE $1 OR email ILIKE $1)`
	args := []any{pattern}
	if selected != "" {
		query = `SELECT id,name,email FROM "user" WHERE id=$1`
		args = []any{selected}
	}
	query += " ORDER BY name LIMIT $" + strconv.Itoa(len(args)+1)
	args = append(args, limit)
	rows, e := b.db.Query(r.Context(), query, args...)
	if e != nil {
		return e
	}
	defer rows.Close()
	out := []any{}
	for rows.Next() {
		var id, n, em string
		if e = rows.Scan(&id, &n, &em); e != nil {
			return e
		}
		out = append(out, map[string]string{"id": id, "name": n, "email": em})
	}
	writeJSON(w, 200, map[string]any{"users": out})
	return nil
}
