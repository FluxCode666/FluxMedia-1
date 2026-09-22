package main

import (
	"context"
	"encoding/json"
	"github.com/jackc/pgx/v5"
	"net/http"
	"net/url"
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
	mux.HandleFunc("GET /api/admin/users/{id}/credits/{resource}", b.endpoint(b.handleAdminCreditsRead))
	mux.HandleFunc("POST /api/admin/users", b.endpoint(b.handleAdminUserCreate))
	mux.HandleFunc("PATCH /api/admin/users/{id}", b.endpoint(b.handleAdminUserMutate))
	mux.HandleFunc("POST /api/admin/users/{id}/credits/grant", b.endpoint(b.handleAdminUserGrant))
	mux.HandleFunc("POST /api/admin/users/{id}/credits/adjust", b.endpoint(b.handleAdminUserAdjust))
	mux.HandleFunc("POST /api/admin/users/{id}/credits/status", b.endpoint(b.handleAdminUserCreditsStatus))
	mux.HandleFunc("POST /api/admin/users/{id}/external-api-key-status", b.endpoint(b.handleAdminUserExternalAPIKeyStatus))
	mux.HandleFunc("POST /api/admin/api-keys/{keyId}/status", b.endpoint(b.handleAdminUserKeyStatus))
	mux.HandleFunc("POST /api/moderation/users/{id}/policy", b.endpoint(b.handleAdminUserModeration))
	mux.HandleFunc("GET /api/moderation/users/{id}/policy", b.endpoint(b.handleAdminUserModerationGet))
	mux.HandleFunc("POST /api/admin/users/{id}/concurrency", b.endpoint(b.handleAdminUserConcurrency))
}

func (b *backend) handleAdminUserConcurrency(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireAdmin(r, false)
	if err != nil {
		return err
	}
	var in struct {
		UserID   string `json:"userId"`
		Override *int   `json:"override"`
		Reason   string `json:"reason"`
	}
	if err = decodeBody(r, &in); err != nil {
		return err
	}
	id := r.PathValue("id")
	if id == "" || in.UserID != "" && in.UserID != id {
		return invalid("用户标识不匹配")
	}
	in.Reason = strings.TrimSpace(in.Reason)
	if in.Reason == "" || len([]rune(in.Reason)) > 300 {
		return invalid("操作原因不合法")
	}
	if in.Override != nil && (*in.Override < 1 || *in.Override > 10000) {
		return invalid("用户生图并发必须是 1 至 10000 的整数")
	}
	defaultConcurrency, err := b.settingInt(r, "IMAGE_GENERATION_DEFAULT_USER_CONCURRENCY", 20, 1, 10000)
	if err != nil {
		return err
	}
	tx, err := b.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer rollback(tx)
	var before *int
	var role string
	var updated time.Time
	if err = tx.QueryRow(r.Context(), `SELECT image_generation_concurrency_override,role,updated_at FROM "user" WHERE id=$1 FOR UPDATE`, id).Scan(&before, &role, &updated); err != nil {
		if err == pgx.ErrNoRows {
			return &apiError{404, "NOT_FOUND", "用户不存在"}
		}
		return err
	}
	if s.User.Role != "super_admin" && (s.User.ID == id || role != "user" && role != "observer_admin") {
		return forbidden()
	}
	changed := (before == nil) != (in.Override == nil) || (before != nil && in.Override != nil && *before != *in.Override)
	var auditID *string
	if changed {
		updated = time.Now().UTC().Truncate(time.Microsecond)
		if _, err = tx.Exec(r.Context(), `UPDATE "user" SET image_generation_concurrency_override=$1,updated_at=$2 WHERE id=$3`, in.Override, updated, id); err != nil {
			return err
		}
		value := newRequestID()
		auditID = &value
		metadata := map[string]any{"requestId": requestID(r), "operation": "mediaLimits.setUserConcurrencyOverride", "actorUserId": s.User.ID, "actorRole": s.User.Role, "targetUserId": id, "targetRole": role}
		if _, err = tx.Exec(r.Context(), `INSERT INTO admin_audit_log(id,admin_user_id,target_user_id,action,reason,before,after,metadata,created_at) VALUES($1,$2,$3,'mediaLimits.setUserConcurrencyOverride',$4,$5,$6,$7,$8)`, value, s.User.ID, id, strings.TrimSpace(in.Reason), mustJSON(map[string]any{"imageGenerationConcurrencyOverride": before}), mustJSON(map[string]any{"imageGenerationConcurrencyOverride": in.Override}), mustJSON(metadata), updated); err != nil {
			return err
		}
	}
	effective := defaultConcurrency
	source := "system_default"
	if in.Override != nil {
		effective = *in.Override
		source = "user_override"
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	noStore(w)
	writeJSON(w, 200, map[string]any{"changed": changed, "before": before, "after": in.Override, "effectiveConcurrency": effective, "effectiveSource": source, "auditLogId": auditID, "updatedAt": updated.UTC(), "message": "用户生图并发限制已更新"})
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
	q, status, cs := strings.TrimSpace(r.URL.Query().Get("query")), r.URL.Query().Get("status"), r.URL.Query().Get("creditsStatus")
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if page < 1 {
		page = 1
	}
	size, _ := strconv.Atoi(r.URL.Query().Get("pageSize"))
	if size != 10 && size != 20 && size != 50 {
		size = 20
	}
	where := []string{"TRUE"}
	args := []any{}
	if q != "" {
		args = append(args, "%"+q+"%")
		where = append(where, "(u.name ILIKE $1 OR u.email ILIKE $1 OR u.id ILIKE $1)")
	}
	if status == "active" {
		where = append(where, "NOT u.banned")
	} else if status == "banned" {
		where = append(where, "u.banned")
	} else if status == "unverified" {
		where = append(where, "NOT u.email_verified")
	}
	if cs == "frozen" {
		where = append(where, "COALESCE(cb.status,'active')='frozen'")
	} else if cs == "active" {
		where = append(where, "COALESCE(cb.status,'active')='active'")
	}
	whereSQL := strings.Join(where, " AND ")
	var total int
	if e = b.db.QueryRow(r.Context(), `SELECT count(*) FROM "user" u LEFT JOIN credits_balance cb ON cb.user_id=u.id WHERE `+whereSQL, args...).Scan(&total); e != nil {
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
	rows, e := b.db.Query(r.Context(), `SELECT u.id,u.name,u.email,u.image,u.role,u.banned,u.banned_reason,u.email_verified,u.image_generation_concurrency_override,u.created_at,u.updated_at,COALESCE(cb.balance,0),COALESCE(cb.total_earned,0),COALESCE(cb.total_spent,0),COALESCE(cb.status,'active'),(SELECT count(*) FROM generation g WHERE g.user_id=u.id),(SELECT count(*) FROM generation g WHERE g.user_id=u.id AND g.status='failed'),(SELECT count(*) FROM external_api_key k WHERE k.user_id=u.id),(SELECT count(*) FROM external_api_key k WHERE k.user_id=u.id AND k.is_active) FROM "user" u LEFT JOIN credits_balance cb ON cb.user_id=u.id WHERE `+whereSQL+` ORDER BY u.created_at DESC,u.id DESC LIMIT $`+strconv.Itoa(len(args)-1)+` OFFSET $`+strconv.Itoa(len(args)), args...)
	if e != nil {
		return e
	}
	defer rows.Close()
	users := []any{}
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
		if e = rows.Scan(&id, &name, &email, &image, &role, &banned, &br, &ev, &ov, &ca, &ua, &bal, &earned, &spent, &cst, &gc, &fg, &kc, &ak); e != nil {
			return e
		}
		users = append(users, map[string]any{"id": id, "name": name, "email": email, "image": image, "role": role, "banned": banned, "bannedReason": br, "emailVerified": ev, "imageGenerationConcurrencyOverride": ov, "createdAt": ca, "updatedAt": ua, "creditsBalance": bal, "creditsTotalEarned": earned, "creditsTotalSpent": spent, "creditsStatus": cst, "generationCount": gc, "failedGenerationCount": fg, "apiKeyCount": kc, "activeApiKeyCount": ak})
	}
	if e = rows.Err(); e != nil {
		return e
	}
	var all, admins, banned int
	if e = b.db.QueryRow(r.Context(), `SELECT count(*),count(*) FILTER(WHERE role IN ('observer_admin','admin','super_admin')),count(*) FILTER(WHERE banned) FROM "user"`).Scan(&all, &admins, &banned); e != nil {
		return e
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": users, "pagination": map[string]any{"page": page, "pageSize": size, "totalCount": total, "totalPages": totalPages}, "stats": map[string]any{"totalUsers": all, "admins": admins, "banned": banned}, "actorId": s.User.ID})
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
	var walletCreated, walletUpdated time.Time
	var wallet any
	err := b.db.QueryRow(r.Context(), `SELECT balance,total_earned,total_spent,status,created_at,updated_at FROM credits_balance WHERE user_id=$1`, id).Scan(&bal, &earned, &spent, &st, &walletCreated, &walletUpdated)
	if err != nil && err != pgx.ErrNoRows {
		return err
	}
	if err == nil {
		wallet = map[string]any{"balance": bal, "totalEarned": earned, "totalSpent": spent, "status": st, "createdAt": walletCreated, "updatedAt": walletUpdated}
	}
	rows, e := b.db.Query(r.Context(), `SELECT id,type,amount,description,metadata,created_at FROM credits_transaction WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`, id)
	if e != nil {
		return e
	}
	defer rows.Close()
	txs := []any{}
	for rows.Next() {
		var i, t string
		var d *string
		var a float64
		var m any
		var c time.Time
		if e = rows.Scan(&i, &t, &a, &d, &m, &c); e != nil {
			return e
		}
		txs = append(txs, map[string]any{"id": i, "type": t, "amount": a, "description": d, "metadata": m, "createdAt": c})
	}
	if err := rows.Err(); err != nil {
		return err
	}
	activeBatches := []any{}
	brs, err := b.db.Query(r.Context(), `SELECT id,amount,remaining,issued_at,expires_at,source_type,source_ref FROM credits_batch WHERE user_id=$1 AND status='active' AND remaining>0 AND (expires_at IS NULL OR expires_at>now()) ORDER BY issued_at DESC,id DESC LIMIT 10`, id)
	if err != nil {
		return err
	}
	if brs != nil {
		defer brs.Close()
		for brs.Next() {
			var i, src string
			var amount, rem float64
			var issued time.Time
			var exp *time.Time
			var sourceRef *string
			if err := brs.Scan(&i, &amount, &rem, &issued, &exp, &src, &sourceRef); err != nil {
				return err
			}
			activeBatches = append(activeBatches, map[string]any{"id": i, "amount": amount, "remaining": rem, "issuedAt": issued, "expiresAt": exp, "sourceType": src, "sourceRef": sourceRef})
		}
		if err := brs.Err(); err != nil {
			return err
		}
	}
	var transactionsCount int
	if err := b.db.QueryRow(r.Context(), `SELECT count(*) FROM credits_transaction WHERE user_id=$1`, id).Scan(&transactionsCount); err != nil {
		return err
	}
	gens := []any{}
	var gt, gc, gf int
	var gcredit float64
	gr, err := b.db.Query(r.Context(), `SELECT id,prompt,revised_prompt,model,size,status,storage_key,storage_bucket,file_size,credits_consumed,error,metadata,created_at,completed_at FROM generation WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 12`, id)
	if err != nil {
		return err
	}
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
			if err := gr.Scan(&i, &p, &rev, &model, &size, &stt, &sk, &sb, &fs, &cc, &er, &md, &ca, &done); err != nil {
				return err
			}
			gens = append(gens, map[string]any{"id": i, "prompt": p, "revisedPrompt": rev, "model": model, "size": size, "status": stt, "storageKey": sk, "storageBucket": sb, "imageUrl": generationURL(sk, sb), "fileSize": fs, "creditsConsumed": cc, "error": er, "metadata": md, "createdAt": ca, "completedAt": done})
		}
		if err := gr.Err(); err != nil {
			return err
		}
	}
	if err := b.db.QueryRow(r.Context(), `SELECT count(*),count(*) FILTER(WHERE status='completed'),count(*) FILTER(WHERE status='failed'),COALESCE(sum(credits_consumed),0) FROM generation WHERE user_id=$1`, id).Scan(&gt, &gc, &gf, &gcredit); err != nil {
		return err
	}
	keys := []any{}
	kr, err := b.db.Query(r.Context(), `SELECT id,name,key_prefix,last_four,credit_limit,credits_used,last_used_at,is_active,created_at,updated_at FROM external_api_key WHERE user_id=$1 ORDER BY created_at DESC,id DESC`, id)
	if err != nil {
		return err
	}
	if kr != nil {
		defer kr.Close()
		for kr.Next() {
			var i, n, kp, lf string
			var cl *float64
			var cu float64
			var lu *time.Time
			var active bool
			var ca, ua time.Time
			if err := kr.Scan(&i, &n, &kp, &lf, &cl, &cu, &lu, &active, &ca, &ua); err != nil {
				return err
			}
			keys = append(keys, map[string]any{"id": i, "name": n, "keyPrefix": kp, "lastFour": lf, "creditLimit": cl, "creditsUsed": cu, "lastUsedAt": lu, "isActive": active, "createdAt": ca, "updatedAt": ua})
		}
		if err := kr.Err(); err != nil {
			return err
		}
	}
	var moderationOverride *string
	var globalRaw []byte
	if err := b.db.QueryRow(r.Context(), `SELECT u.moderation_block_risk_level_override,s.value FROM "user" u LEFT JOIN system_setting s ON s.key=$2 WHERE u.id=$1`, id, globalModerationPolicySetting).Scan(&moderationOverride, &globalRaw); err != nil {
		return err
	}
	moderationPolicy := resolveUserModerationPolicy(globalRaw, moderationOverride)
	mediaLimits, err := b.adminUserMediaLimits(r, id)
	if err != nil {
		return err
	}
	auditLogs := []any{}
	arows, err := b.db.Query(r.Context(), `SELECT id,admin_user_id,action,reason,before,after,metadata,created_at FROM admin_audit_log WHERE target_user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50`, id)
	if err != nil {
		return err
	}
	defer arows.Close()
	for arows.Next() {
		var aid, action string
		var adminID, reason *string
		var before, after, metadata json.RawMessage
		var createdAt time.Time
		if err := arows.Scan(&aid, &adminID, &action, &reason, &before, &after, &metadata, &createdAt); err != nil {
			return err
		}
		auditLogs = append(auditLogs, map[string]any{"id": aid, "adminUserId": adminID, "action": action, "reason": reason, "before": before, "after": after, "metadata": metadata, "createdAt": createdAt})
	}
	if err := arows.Err(); err != nil {
		return err
	}
	noStore(w)
	writeJSON(w, 200, map[string]any{"user": u, "creditsBalance": wallet, "transactions": txs, "transactionsCount": transactionsCount, "activeBatches": activeBatches, "generations": gens, "apiKeys": keys, "auditLogs": auditLogs, "moderationPolicy": moderationPolicy, "mediaLimits": mediaLimits, "generationSummary": map[string]any{"total": gt, "completed": gc, "failed": gf, "creditsConsumed": gcredit}})
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
	// Profile and credential changes are super-admin operations in the shared
	// UOL contract. Enforce that boundary in Go as well, rather than relying on
	// the Next action wrapper to be the only guard.
	for _, field := range []string{"name", "email", "image", "password"} {
		if _, ok := in[field]; ok {
			super = true
			break
		}
	}
	if _, ok := in["reason"]; ok && len(in) == 1 {
		return invalid("至少需要一个用户变更字段")
	}
	if _, ok := in["role"]; ok {
		super = true
	}
	s, e := b.adminTarget(r, super, id)
	if e != nil {
		return e
	}
	// Distinguish an omitted avatar from an explicit clear. Validate before any
	// other requested field is written so invalid images cannot partially apply.
	var image *string
	imageValue, imageSet := in["image"]
	if imageSet && imageValue != nil {
		value, ok := imageValue.(string)
		if !ok {
			return invalid("头像地址无效")
		}
		value = strings.TrimSpace(value)
		parsed, err := url.Parse(value)
		if err != nil || !parsed.IsAbs() || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") || len(value) > 4096 || strings.ContainsAny(value, "\r\n\\") {
			return invalid("头像地址无效")
		}
		image = &value
	}
	if userID, ok := in["userId"]; ok && userID != id {
		return invalid("用户标识不匹配")
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
	name, nameSet := in["name"].(string)
	email, emailSet := in["email"].(string)
	if nameSet || emailSet || imageSet {
		tx, err := b.db.Begin(r.Context())
		if err != nil {
			return err
		}
		defer rollback(tx)
		var before, after []byte
		if err = tx.QueryRow(r.Context(), `SELECT json_build_object('name',name,'email',email,'image',image) FROM "user" WHERE id=$1 FOR UPDATE`, id).Scan(&before); err != nil {
			return err
		}
		if err = tx.QueryRow(r.Context(), `UPDATE "user" SET name=CASE WHEN $2 THEN $3 ELSE name END,email=CASE WHEN $4 THEN $5 ELSE email END,image=CASE WHEN $6 THEN $7::text ELSE image END,updated_at=now() WHERE id=$1 RETURNING json_build_object('name',name,'email',email,'image',image)`, id, nameSet, name, emailSet, strings.ToLower(strings.TrimSpace(email)), imageSet, image).Scan(&after); err != nil {
			return err
		}
		if _, err = tx.Exec(r.Context(), `INSERT INTO admin_audit_log(id,admin_user_id,target_user_id,action,reason,before,after) VALUES($1,$2,$3,'user.profile.update',$4,$5,$6)`, newRequestID(), s.User.ID, id, mapString(in, "reason"), before, after); err != nil {
			return err
		}
		if err = tx.Commit(r.Context()); err != nil {
			return err
		}
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
	uid := r.PathValue("id")
	actor, err := b.requireAdmin(r, !grant)
	if err != nil {
		return err
	}
	if actor.User.ID == uid {
		return &apiError{403, "FORBIDDEN", "不能调整自己的积分"}
	}
	var targetRole string
	if err = b.db.QueryRow(r.Context(), `SELECT role FROM "user" WHERE id=$1`, uid).Scan(&targetRole); err != nil {
		return err
	}
	if actor.User.Role != "super_admin" && targetRole != "user" && targetRole != "observer_admin" {
		return forbidden()
	}
	var input struct {
		UserID    string     `json:"userId"`
		Amount    float64    `json:"amount"`
		Mode      string     `json:"mode"`
		Reason    string     `json:"reason"`
		ExpiresAt *time.Time `json:"expiresAt"`
	}
	if err = decodeBody(r, &input); err != nil {
		return err
	}
	if input.UserID != "" && input.UserID != uid {
		return invalid("用户 ID 不匹配")
	}
	if input.Mode == "" {
		input.Mode = "deduct"
	}
	if !grant && input.Mode != "deduct" && input.Mode != "set" {
		return invalid("积分调整模式无效")
	}
	amount, err := validateCreditAmount(input.Amount, !grant && input.Mode == "set")
	if err != nil {
		return err
	}
	tx, err := b.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer rollback(tx)
	wallet, err := b.lockCreditWallet(r, tx, uid)
	if err != nil {
		return err
	}
	if wallet.Status != "active" {
		return &apiError{403, "ACCOUNT_FROZEN", "积分账户已冻结"}
	}
	delta := amount
	if !grant {
		if input.Mode == "set" {
			delta = creditRound(amount - wallet.Balance)
		} else {
			delta = -amount
		}
	}
	result := creditMutationResult{Balance: wallet.Balance}
	in := creditMutation{UserID: uid, Amount: delta, SourceType: "bonus", Reason: input.Reason, ExpiresAt: input.ExpiresAt, ServiceName: "admin_deduct", OperationType: "admin_credit_adjustment", Metadata: map[string]any{"adminUserId": actor.User.ID, "reason": input.Reason}}
	if delta > 0 {
		result, err = b.grantCreditTx(r, tx, wallet, in)
	} else if delta < 0 {
		in.Amount = -delta
		result, err = b.consumeCreditTx(r, tx, wallet, in)
	}
	if err != nil {
		return err
	}
	action := "credits.grant"
	if !grant {
		action = "credits.adjust"
	}
	if _, err = tx.Exec(r.Context(), `INSERT INTO admin_audit_log(id,admin_user_id,target_user_id,action,reason,before,after) VALUES($1,$2,$3,$4,$5,$6,$7)`, newRequestID(), actor.User.ID, uid, action, input.Reason, mustJSON(map[string]any{"balance": wallet.Balance}), mustJSON(map[string]any{"balance": result.Balance, "amount": delta, "mode": input.Mode})); err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"message": "积分操作成功", "batchId": result.BatchID, "transactionId": result.TransactionID, "balance": result.Balance, "previousBalance": wallet.Balance, "newBalance": result.Balance})
	return nil
}
func (b *backend) handleAdminUserCreditsStatus(w http.ResponseWriter, r *http.Request) error {
	id := r.PathValue("id")
	actor, err := b.requireAdmin(r, false)
	if err != nil {
		return err
	}
	if actor.User.ID == id {
		return &apiError{403, "FORBIDDEN", "不能调整自己的积分账户"}
	}
	var role string
	if err = b.db.QueryRow(r.Context(), `SELECT role FROM "user" WHERE id=$1`, id).Scan(&role); err != nil {
		return err
	}
	if actor.User.Role != "super_admin" && role != "user" && role != "observer_admin" {
		return forbidden()
	}
	var input struct{ Status, Reason string }
	if err = decodeBody(r, &input); err != nil {
		return err
	}
	if input.Status != "active" && input.Status != "frozen" {
		return invalid("积分状态无效")
	}
	tx, err := b.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer rollback(tx)
	wallet, err := b.lockCreditWallet(r, tx, id)
	if err != nil {
		return err
	}
	if _, err = tx.Exec(r.Context(), `UPDATE credits_balance SET status=$1,updated_at=now() WHERE user_id=$2`, input.Status, id); err != nil {
		return err
	}
	if _, err = tx.Exec(r.Context(), `INSERT INTO admin_audit_log(id,admin_user_id,target_user_id,action,reason,before,after) VALUES($1,$2,$3,'credits.status',$4,$5,$6)`, newRequestID(), actor.User.ID, id, input.Reason, mustJSON(map[string]any{"status": wallet.Status}), mustJSON(map[string]any{"status": input.Status})); err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"success": true, "message": "积分账户状态已更新", "previousStatus": wallet.Status, "status": input.Status})
	return nil
}

// handleAdminUserExternalAPIKeyStatus changes all external keys owned by one
// user. The UOL user operation is intentionally user-scoped; the key-scoped
// endpoint remains available for the admin key table.
func (b *backend) handleAdminUserExternalAPIKeyStatus(w http.ResponseWriter, r *http.Request) error {
	id := r.PathValue("id")
	s, err := b.adminTarget(r, false, id)
	if err != nil {
		return err
	}
	var in struct {
		Enabled *bool  `json:"externalApiKeyEnabled"`
		Reason  string `json:"reason"`
	}
	if err = decodeBody(r, &in); err != nil {
		return err
	}
	if in.Enabled == nil {
		return invalid("externalApiKeyEnabled is required")
	}
	if _, err = b.db.Exec(r.Context(), `UPDATE external_api_key SET is_active=$1,updated_at=now() WHERE user_id=$2`, *in.Enabled, id); err != nil {
		return err
	}
	b.auditAdmin(r.Context(), s.User.ID, id, "external_api_key.user_status", in.Reason, nil, map[string]any{"isActive": *in.Enabled})
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "message": "用户 API Key 状态已更新"})
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
	var previous bool
	if e = b.db.QueryRow(r.Context(), `SELECT user_id,is_active FROM external_api_key WHERE id=$1`, r.PathValue("keyId")).Scan(&uid, &previous); e != nil {
		return e
	}
	_, e = b.db.Exec(r.Context(), `UPDATE external_api_key SET is_active=$1,updated_at=now() WHERE id=$2`, in.IsActive, r.PathValue("keyId"))
	if e != nil {
		return e
	}
	b.auditAdmin(r.Context(), s.User.ID, uid, "external_api_key.status", in.Reason, nil, map[string]any{"isActive": in.IsActive})
	writeJSON(w, 200, map[string]any{"success": true, "previousStatus": map[bool]string{true: "active", false: "disabled"}[previous], "newStatus": map[bool]string{true: "active", false: "disabled"}[in.IsActive], "updatedAt": time.Now().UTC()})
	return nil
}
