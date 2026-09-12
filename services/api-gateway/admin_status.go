package main

import (
	"net/http"
	"strconv"
	"strings"
	"time"
)

func itoa(v int) string { return strconv.Itoa(v) }

func (b *backend) registerAdminStatusRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/admin/status/errors", b.endpoint(b.handleAdminStatusErrors))
}

func adminStatusErrorCategory(message *string) string {
	if message == nil {
		return "platform"
	}
	v := strings.ToLower(*message)
	if strings.Contains(v, "moderation") || strings.Contains(v, "审核") || strings.Contains(v, "safety") {
		return "moderation"
	}
	if strings.Contains(v, "invalid") || strings.Contains(v, "参数") || strings.Contains(v, "prompt") {
		return "user_request"
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
