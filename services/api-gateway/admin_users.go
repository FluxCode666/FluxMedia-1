package main

import (
	"context"
	"encoding/json"
	"github.com/jackc/pgx/v5"
	"net/http"
	"strconv"
	"strings"
	"time"
)

func mapString(m map[string]any, key string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

func (b *backend) registerAdminUserRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/admin/users", b.endpoint(b.handleAdminUsers))
	mux.HandleFunc("GET /api/admin/users/{id}", b.endpoint(b.handleAdminUserDetail))
	mux.HandleFunc("POST /api/admin/users", b.endpoint(b.handleAdminUserCreate))
	mux.HandleFunc("PATCH /api/admin/users/{id}", b.endpoint(b.handleAdminUserMutate))
	mux.HandleFunc("POST /api/admin/users/{id}/credits/grant", b.endpoint(b.handleAdminUserGrant))
	mux.HandleFunc("POST /api/admin/users/{id}/credits/adjust", b.endpoint(b.handleAdminUserAdjust))
	mux.HandleFunc("POST /api/admin/users/{id}/credits/status", b.endpoint(b.handleAdminUserCreditsStatus))
	mux.HandleFunc("POST /api/admin/api-keys/{keyId}/status", b.endpoint(b.handleAdminUserKeyStatus))
	mux.HandleFunc("POST /api/moderation/users/{id}/policy", b.endpoint(b.handleAdminUserModeration))
	mux.HandleFunc("POST /api/admin/users/{id}/concurrency", b.endpoint(b.handleAdminUserConcurrency))
}

func (b *backend) handleAdminUserModeration(w http.ResponseWriter, r *http.Request) error {
	s, err := b.adminTarget(r, false, r.PathValue("id"))
	if err != nil {
		return err
	}
	var in struct {
		Level  *string `json:"level"`
		Reason string  `json:"reason"`
	}
	if err = decodeBody(r, &in); err != nil {
		return err
	}
	_, err = b.db.Exec(r.Context(), `UPDATE "user" SET moderation_block_risk_level_override=$1,updated_at=now() WHERE id=$2`, r.PathValue("id"), in.Level, s.User.ID)
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"success": true, "after": in.Level, "changed": true})
	return nil
}
func (b *backend) handleAdminUserConcurrency(w http.ResponseWriter, r *http.Request) error {
	s, err := b.adminTarget(r, false, r.PathValue("id"))
	if err != nil {
		return err
	}
	var in struct {
		Override *int   `json:"override"`
		Reason   string `json:"reason"`
	}
	if err = decodeBody(r, &in); err != nil {
		return err
	}
	_, err = b.db.Exec(r.Context(), `UPDATE "user" SET image_generation_concurrency_override=$1,updated_at=now() WHERE id=$2`, in.Override, r.PathValue("id"))
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"success": true, "after": in.Override, "changed": true, "message": "用户生图并发限制已更新"})
	_ = s
	return nil
}
func (b *backend) adminTarget(r *http.Request, super bool, id string) (*sessionResponse, error) {
	s, e := b.requireAdmin(r, super)
	if e != nil {
		return nil, e
	}
	var role string
	if e = b.db.QueryRow(r.Context(), `SELECT role FROM "user" WHERE id=$1`, id).Scan(&role); e != nil {
		if e == pgx.ErrNoRows {
			return nil, invalid("用户不存在")
		}
		return nil, e
	}
	if !super && role != "user" {
		return nil, forbidden()
	}
	return s, nil
}
func (b *backend) auditAdmin(ctx context.Context, admin, target, action, reason string, before, after any) {
	raw1, _ := json.Marshal(before)
	raw2, _ := json.Marshal(after)
	_, _ = b.db.Exec(ctx, `INSERT INTO admin_audit_log(id,admin_user_id,target_user_id,action,reason,before,after) VALUES($1,$2,$3,$4,$5,$6,$7)`, newRequestID(), admin, target, action, strings.TrimSpace(reason), raw1, raw2)
}
func (b *backend) handleAdminUsers(w http.ResponseWriter, r *http.Request) error {
	s, e := b.requireAdmin(r, false)
	if e != nil {
		return e
	}
	q := strings.TrimSpace(r.URL.Query().Get("query"))
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if page < 1 {
		page = 1
	}
	size, _ := strconv.Atoi(r.URL.Query().Get("pageSize"))
	if size != 10 && size != 20 && size != 50 {
		size = 20
	}
	status := r.URL.Query().Get("status")
	cs := r.URL.Query().Get("creditsStatus")
	where := []string{"TRUE"}
	args := []any{}
	if q != "" {
		args = append(args, "%"+q+"%")
		where = append(where, "(u.name ILIKE $1 OR u.email ILIKE $1 OR u.id=$1)")
	}
	if status == "active" {
		where = append(where, "NOT u.banned")
	}
	if status == "banned" {
		where = append(where, "u.banned")
	}
	if status == "unverified" {
		where = append(where, "NOT u.email_verified")
	}
	if cs == "frozen" {
		where = append(where, "COALESCE(cb.status,'active')='frozen'")
	}
	if cs == "active" {
		where = append(where, "COALESCE(cb.status,'active')='active'")
	}
	base := len(args)
	args = append(args, size, (page-1)*size)
	rows, e := b.db.Query(r.Context(), `SELECT u.id,u.name,u.email,u.image,u.role,u.banned,u.banned_reason,u.email_verified,u.image_generation_concurrency_override,u.created_at,u.updated_at,COALESCE(cb.balance,0),COALESCE(cb.total_earned,0),COALESCE(cb.total_spent,0),COALESCE(cb.status,'active'),(SELECT count(*) FROM generation g WHERE g.user_id=u.id),(SELECT count(*) FROM generation g WHERE g.user_id=u.id AND g.status='failed'),(SELECT count(*) FROM external_api_key k WHERE k.user_id=u.id),(SELECT count(*) FROM external_api_key k WHERE k.user_id=u.id AND k.is_active),count(*) OVER() FROM "user" u LEFT JOIN credits_balance cb ON cb.user_id=u.id WHERE `+strings.Join(where, " AND ")+` ORDER BY u.created_at DESC LIMIT $`+strconv.Itoa(base+1)+` OFFSET $`+strconv.Itoa(base+2), args...)
	if e != nil {
		return e
	}
	defer rows.Close()
	users := []any{}
	total := 0
	for rows.Next() {
		var id, name, email string
		var image, br *string
		var role string
		var banned, ev bool
		var ov *int
		var ca, ua time.Time
		var bal, earned, spent float64
		var cst string
		var gc, fg, kc, ak int
		if e = rows.Scan(&id, &name, &email, &image, &role, &banned, &br, &ev, &ov, &ca, &ua, &bal, &earned, &spent, &cst, &gc, &fg, &kc, &ak, &total); e != nil {
			return e
		}
		users = append(users, map[string]any{"id": id, "name": name, "email": email, "image": image, "role": role, "banned": banned, "bannedReason": br, "emailVerified": ev, "imageGenerationConcurrencyOverride": ov, "createdAt": ca, "updatedAt": ua, "creditsBalance": bal, "creditsTotalEarned": earned, "creditsTotalSpent": spent, "creditsStatus": cst, "generationCount": gc, "failedGenerationCount": fg, "apiKeyCount": kc, "activeApiKeyCount": ak})
	}
	var all, admins, banned int
	b.db.QueryRow(r.Context(), `SELECT count(*),count(*) FILTER(WHERE role IN ('admin','super_admin')),count(*) FILTER(WHERE banned) FROM "user"`).Scan(&all, &admins, &banned)
	writeJSON(w, 200, map[string]any{"users": users, "pagination": map[string]any{"page": page, "pageSize": size, "totalCount": total, "totalPages": (total + size - 1) / size}, "stats": map[string]any{"totalUsers": all, "admins": admins, "banned": banned}, "actorId": s.User.ID})
	return nil
}
func (b *backend) handleAdminUserDetail(w http.ResponseWriter, r *http.Request) error {
	if _, e := b.requireAdmin(r, false); e != nil {
		return e
	}
	id := r.PathValue("id")
	var u map[string]any
	var name, email, role string
	var banned, ev bool
	var image, br *string
	var created, updated time.Time
	if e := b.db.QueryRow(r.Context(), `SELECT name,email,role,banned,banned_reason,email_verified,image,created_at,updated_at FROM "user" WHERE id=$1`, id).Scan(&name, &email, &role, &banned, &br, &ev, &image, &created, &updated); e != nil {
		if e == pgx.ErrNoRows {
			return invalid("用户不存在")
		}
		return e
	}
	u = map[string]any{"id": id, "name": name, "email": email, "role": role, "banned": banned, "bannedReason": br, "emailVerified": ev, "image": image, "createdAt": created, "updatedAt": updated}
	var bal, earned, spent float64
	var st string
	_ = b.db.QueryRow(r.Context(), `SELECT balance,total_earned,total_spent,status FROM credits_balance WHERE user_id=$1`, id).Scan(&bal, &earned, &spent, &st)
	rows, e := b.db.Query(r.Context(), `SELECT id,type,amount,description,metadata,created_at FROM credits_transaction WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`, id)
	if e != nil {
		return e
	}
	defer rows.Close()
	txs := []any{}
	for rows.Next() {
		var i, t, d string
		var a float64
		var m any
		var c time.Time
		if e = rows.Scan(&i, &t, &a, &d, &m, &c); e == nil {
			txs = append(txs, map[string]any{"id": i, "type": t, "amount": a, "description": d, "metadata": m, "createdAt": c})
		}
	}
	activeBatches := []any{}
	brs, _ := b.db.Query(r.Context(), `SELECT id,amount,remaining,issued_at,expires_at,source_type FROM credits_batch WHERE user_id=$1 AND status='active' AND remaining>0 ORDER BY issued_at DESC LIMIT 10`, id)
	if brs != nil {
		defer brs.Close()
		for brs.Next() {
			var i, src string
			var amount, rem float64
			var issued time.Time
			var exp *time.Time
			if brs.Scan(&i, &amount, &rem, &issued, &exp, &src) == nil {
				activeBatches = append(activeBatches, map[string]any{"id": i, "amount": amount, "remaining": rem, "issuedAt": issued, "expiresAt": exp, "sourceType": src})
			}
		}
	}
	gens := []any{}
	var gt, gc, gf int
	var gcredit float64
	gr, _ := b.db.Query(r.Context(), `SELECT id,prompt,revised_prompt,model,size,status,storage_key,storage_bucket,file_size,credits_consumed,error,metadata,created_at,completed_at FROM generation WHERE user_id=$1 ORDER BY created_at DESC LIMIT 12`, id)
	if gr != nil {
		defer gr.Close()
		for gr.Next() {
			var i, p, model, size, stt string
			var rev, sk, sb, er *string
			var fs *int64
			var cc float64
			var md any
			var ca time.Time
			var done *time.Time
			if gr.Scan(&i, &p, &rev, &model, &size, &stt, &sk, &sb, &fs, &cc, &er, &md, &ca, &done) == nil {
				gens = append(gens, map[string]any{"id": i, "prompt": p, "revisedPrompt": rev, "model": model, "size": size, "status": stt, "storageKey": sk, "storageBucket": sb, "fileSize": fs, "creditsConsumed": cc, "error": er, "metadata": md, "createdAt": ca, "completedAt": done})
				gt++
				if stt == "completed" {
					gc++
				}
				if stt == "failed" {
					gf++
				}
				gcredit += cc
			}
		}
	}
	_ = b.db.QueryRow(r.Context(), `SELECT count(*),count(*) FILTER(WHERE status='completed'),count(*) FILTER(WHERE status='failed'),COALESCE(sum(credits_consumed),0) FROM generation WHERE user_id=$1`, id).Scan(&gt, &gc, &gf, &gcredit)
	keys := []any{}
	kr, _ := b.db.Query(r.Context(), `SELECT id,name,key_prefix,last_four,credit_limit,credits_used,last_used_at,is_active,created_at,updated_at FROM external_api_key WHERE user_id=$1 ORDER BY created_at DESC`, id)
	if kr != nil {
		defer kr.Close()
		for kr.Next() {
			var i, n, kp, lf string
			var cl, cu float64
			var lu *time.Time
			var active bool
			var ca, ua time.Time
			if kr.Scan(&i, &n, &kp, &lf, &cl, &cu, &lu, &active, &ca, &ua) == nil {
				keys = append(keys, map[string]any{"id": i, "name": n, "keyPrefix": kp, "lastFour": lf, "creditLimit": cl, "creditsUsed": cu, "lastUsedAt": lu, "isActive": active, "createdAt": ca, "updatedAt": ua})
			}
		}
	}
	writeJSON(w, 200, map[string]any{"user": u, "creditsBalance": map[string]any{"balance": bal, "totalEarned": earned, "totalSpent": spent, "status": st}, "transactions": txs, "activeBatches": activeBatches, "generations": gens, "apiKeys": keys, "auditLogs": []any{}, "generationSummary": map[string]any{"total": gt, "completed": gc, "failed": gf, "creditsConsumed": gcredit}})
	return nil
}
func (b *backend) handleAdminUserCreate(w http.ResponseWriter, r *http.Request) error {
	s, e := b.requireAdmin(r, true)
	if e != nil {
		return e
	}
	var in struct {
		Name, Email, Password, Role, Reason string
		EmailVerified                       bool
	}
	if e = decodeBody(r, &in); e != nil {
		return e
	}
	if strings.TrimSpace(in.Name) == "" || len(in.Password) < 8 || len(in.Password) > 128 {
		return invalid("用户资料或密码无效")
	}
	if in.Role == "" {
		in.Role = "user"
	}
	email := strings.ToLower(strings.TrimSpace(in.Email))
	var exists bool
	if e = b.db.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM "user" WHERE lower(email)=$1)`, email).Scan(&exists); e != nil {
		return e
	}
	if exists {
		return invalid("该邮箱已被注册或占用")
	}
	pwd, e := hashPassword(r.Context(), in.Password)
	if e != nil {
		return e
	}
	id := newRequestID()
	tx, e := b.db.Begin(r.Context())
	if e != nil {
		return e
	}
	defer rollback(tx)
	if _, e = tx.Exec(r.Context(), `INSERT INTO "user"(id,name,email,email_verified,role) VALUES($1,$2,$3,$4,$5)`, id, in.Name, email, in.EmailVerified, in.Role); e != nil {
		return e
	}
	if _, e = tx.Exec(r.Context(), `INSERT INTO account(id,account_id,provider_id,user_id,password) VALUES($1,$2,'credential',$2,$3)`, newRequestID(), id, pwd); e != nil {
		return e
	}
	if _, e = tx.Exec(r.Context(), `INSERT INTO credits_balance(id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, newRequestID(), id); e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	b.auditAdmin(r.Context(), s.User.ID, id, "user.create", in.Reason, nil, map[string]any{"id": id, "email": email, "role": in.Role})
	writeJSON(w, 201, map[string]any{"message": "用户创建成功", "userId": id})
	return nil
}
func (b *backend) handleAdminUserMutate(w http.ResponseWriter, r *http.Request) error {
	id := r.PathValue("id")
	var in map[string]any
	if e := decodeBody(r, &in); e != nil {
		return e
	}
	super := false
	if _, ok := in["role"]; ok {
		super = true
	}
	s, e := b.adminTarget(r, super, id)
	if e != nil {
		return e
	}
	if role, ok := in["role"].(string); ok {
		_, e = b.db.Exec(r.Context(), `UPDATE "user" SET role=$1,updated_at=now() WHERE id=$2`, role, id)
		b.auditAdmin(r.Context(), s.User.ID, id, "user.role.update", mapString(in, "reason"), nil, map[string]any{"role": role})
	}
	if v, ok := in["banned"].(bool); ok {
		_, e = b.db.Exec(r.Context(), `UPDATE "user" SET banned=$1,banned_reason=CASE WHEN $1 THEN $2 ELSE NULL END,updated_at=now() WHERE id=$3`, v, mapString(in, "reason"), id)
		if v {
			_, _ = b.db.Exec(r.Context(), `DELETE FROM session WHERE user_id=$1`, id)
		}
		b.auditAdmin(r.Context(), s.User.ID, id, map[bool]string{true: "user.ban", false: "user.unban"}[v], mapString(in, "reason"), nil, map[string]any{"banned": v})
	}
	if name, ok := in["name"].(string); ok {
		_, e = b.db.Exec(r.Context(), `UPDATE "user" SET name=$1,updated_at=now() WHERE id=$2`, name, id)
	}
	if email, ok := in["email"].(string); ok {
		_, e = b.db.Exec(r.Context(), `UPDATE "user" SET email=$1,updated_at=now() WHERE id=$2`, strings.ToLower(strings.TrimSpace(email)), id)
	}
	if password, ok := in["password"].(string); ok {
		if len(password) < 8 {
			return invalid("密码至少8位")
		}
		h, er := hashPassword(r.Context(), password)
		if er != nil {
			return er
		}
		_, e = b.db.Exec(r.Context(), `UPDATE account SET password=$1,updated_at=now() WHERE user_id=$2 AND provider_id='credential'`, h, id)
	}
	if e != nil {
		return e
	}
	writeJSON(w, 200, map[string]string{"message": "用户资料已更新"})
	return nil
}
func (b *backend) handleAdminUserGrant(w http.ResponseWriter, r *http.Request) error {
	return b.adjustAdminCredits(w, r, true)
}
func (b *backend) handleAdminUserAdjust(w http.ResponseWriter, r *http.Request) error {
	return b.adjustAdminCredits(w, r, false)
}
func (b *backend) adjustAdminCredits(w http.ResponseWriter, r *http.Request, grant bool) error {
	id := r.PathValue("id")
	s, e := b.adminTarget(r, !grant, id)
	if e != nil {
		return e
	}
	var in struct {
		Amount float64
		Reason string
	}
	if e = decodeBody(r, &in); e != nil {
		return e
	}
	if in.Amount <= 0 {
		return invalid("积分数量必须大于0")
	}
	if grant {
		_, e = b.db.Exec(r.Context(), `INSERT INTO credits_balance(id,user_id,balance,total_earned) VALUES($1,$2,$3,$3) ON CONFLICT(user_id) DO UPDATE SET balance=credits_balance.balance+$3,total_earned=credits_balance.total_earned+$3`, newRequestID(), id, in.Amount)
	} else {
		_, e = b.db.Exec(r.Context(), `UPDATE credits_balance SET balance=balance-$1,total_spent=total_spent+$1 WHERE user_id=$2 AND balance >= $1`, in.Amount, id)
	}
	if e != nil {
		return e
	}
	b.auditAdmin(r.Context(), s.User.ID, id, map[bool]string{true: "credits.grant", false: "credits.deduct"}[grant], in.Reason, nil, map[string]any{"amount": in.Amount})
	writeJSON(w, 200, map[string]any{"message": "积分操作成功"})
	return nil
}
func (b *backend) handleAdminUserCreditsStatus(w http.ResponseWriter, r *http.Request) error {
	id := r.PathValue("id")
	s, e := b.adminTarget(r, false, id)
	if e != nil {
		return e
	}
	var in struct{ Status, Reason string }
	if e = decodeBody(r, &in); e != nil {
		return e
	}
	if in.Status != "active" && in.Status != "frozen" {
		return invalid("积分状态无效")
	}
	_, e = b.db.Exec(r.Context(), `INSERT INTO credits_balance(id,user_id,status) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET status=$3,updated_at=now()`, newRequestID(), id, in.Status)
	if e != nil {
		return e
	}
	b.auditAdmin(r.Context(), s.User.ID, id, "credits.status", in.Reason, nil, map[string]any{"status": in.Status})
	writeJSON(w, 200, map[string]string{"message": "积分账户状态已更新"})
	return nil
}
func (b *backend) handleAdminUserKeyStatus(w http.ResponseWriter, r *http.Request) error {
	s, e := b.requireAdmin(r, false)
	if e != nil {
		return e
	}
	var in struct {
		IsActive bool
		Reason   string
	}
	if e = decodeBody(r, &in); e != nil {
		return e
	}
	var uid string
	if e = b.db.QueryRow(r.Context(), `SELECT user_id FROM external_api_key WHERE id=$1`, r.PathValue("keyId")).Scan(&uid); e != nil {
		return e
	}
	_, e = b.db.Exec(r.Context(), `UPDATE external_api_key SET is_active=$1,updated_at=now() WHERE id=$2`, in.IsActive, r.PathValue("keyId"))
	if e != nil {
		return e
	}
	b.auditAdmin(r.Context(), s.User.ID, uid, "external_api_key.status", in.Reason, nil, map[string]any{"isActive": in.IsActive})
	writeJSON(w, 200, map[string]string{"message": "API Key 状态已更新"})
	return nil
}
