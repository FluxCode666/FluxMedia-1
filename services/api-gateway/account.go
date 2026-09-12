package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// handleProfile serves the settings profile mutation previously implemented as
// a Next.js server action.
func (b *backend) handleProfile(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireSession(r)
	if err != nil {
		return err
	}
	if r.Method == http.MethodGet {
		var name, email string
		var image, zone *string
		if err := b.db.QueryRow(r.Context(), `SELECT name,email,image,time_zone FROM "user" WHERE id=$1`, s.User.ID).Scan(&name, &email, &image, &zone); err != nil {
			return err
		}
		defaultZone, err := b.settingString(r.Context(), "APP_TIME_ZONE", "UTC")
		if err != nil {
			return err
		}
		zoneValue := ""
		if zone != nil {
			zoneValue = strings.TrimSpace(*zone)
		}
		writeJSON(w, http.StatusOK, map[string]any{"id": s.User.ID, "name": name, "email": email, "image": image, "timeZone": zoneValue, "defaultTimeZone": defaultZone})
		return nil
	}
	var in struct {
		Name  *string `json:"name"`
		Image *string `json:"image"`
	}
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	if in.Name == nil && in.Image == nil {
		return invalid("请至少提供一个资料字段")
	}
	if in.Name != nil && strings.TrimSpace(*in.Name) == "" {
		return invalid("名称不能为空")
	}
	_, err = b.db.Exec(r.Context(), `UPDATE "user" SET name=COALESCE($2,name), image=COALESCE($3,image), updated_at=now() WHERE id=$1`, s.User.ID, in.Name, in.Image)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]string{"message": "资料更新成功"})
	return nil
}

func (b *backend) handleCreditsBalance(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireSession(r)
	if err != nil {
		return err
	}
	var balance, earned, spent float64
	var status string
	_, err = b.db.Exec(r.Context(), `INSERT INTO credits_balance(id,user_id) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING`, newRequestID(), s.User.ID)
	if err != nil {
		return err
	}
	err = b.db.QueryRow(r.Context(), `SELECT balance,total_earned,total_spent,status FROM credits_balance WHERE user_id=$1`, s.User.ID).Scan(&balance, &earned, &spent, &status)
	if err != nil {
		return err
	}
	var refunded float64
	_ = b.db.QueryRow(r.Context(), `SELECT COALESCE(sum(amount),0) FROM credits_transaction WHERE user_id=$1 AND type='refund'`, s.User.ID).Scan(&refunded)
	writeJSON(w, http.StatusOK, map[string]any{"balance": balance, "totalEarned": earned, "totalSpent": spent, "totalRefunded": refunded, "totalNetSpent": spent - refunded, "status": status, "asOf": time.Now().UTC()})
	return nil
}

func (b *backend) handleCreditsTransactions(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireSession(r)
	if err != nil {
		return err
	}
	limit, offset := 50, 0
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, e := strconv.Atoi(v); e == nil && n > 0 && n <= 100 {
			limit = n
		}
	}
	if v := r.URL.Query().Get("offset"); v != "" {
		if n, e := strconv.Atoi(v); e == nil && n >= 0 {
			offset = n
		}
	}
	rows, err := b.db.Query(r.Context(), `SELECT id,type,amount,debit_account,credit_account,description,metadata,created_at FROM credits_transaction WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3`, s.User.ID, limit, offset)
	if err != nil {
		return err
	}
	defer rows.Close()
	items := []any{}
	for rows.Next() {
		var id, typ, debit, credit string
		var amount int
		var desc *string
		var metadata any
		var created time.Time
		if err := rows.Scan(&id, &typ, &amount, &debit, &credit, &desc, &metadata, &created); err != nil {
			return err
		}
		items = append(items, map[string]any{"id": id, "type": typ, "amount": amount, "debitAccount": debit, "creditAccount": credit, "description": desc, "metadata": metadata, "createdAt": created})
	}
	var total int
	if err := b.db.QueryRow(r.Context(), `SELECT count(*) FROM credits_transaction WHERE user_id=$1`, s.User.ID).Scan(&total); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"transactions": items, "totalCount": total})
	return nil
}

func (b *backend) handleTopUpOptions(w http.ResponseWriter, r *http.Request) error {
	if _, err := b.requireSession(r); err != nil {
		return err
	}
	value, err := b.setting(r.Context(), "CREDIT_TOP_UP_CONFIG", map[string]any{"enabled": false, "defaultCurrency": "CNY", "currencies": []any{}})
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, value)
	return nil
}

func (b *backend) handleCreditsResource(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireSession(r)
	if err != nil {
		return err
	}
	switch r.URL.Path {
	case "/api/credits/active-batches":
		rows, err := b.db.Query(r.Context(), `SELECT id,amount,remaining,issued_at,expires_at,source_type FROM credits_batch WHERE user_id=$1 AND status='active' AND remaining>0 ORDER BY issued_at`, s.User.ID)
		if err != nil {
			return err
		}
		defer rows.Close()
		out := []any{}
		for rows.Next() {
			var id, src string
			var amount, rem float64
			var issued time.Time
			var exp *time.Time
			if err := rows.Scan(&id, &amount, &rem, &issued, &exp, &src); err != nil {
				return err
			}
			out = append(out, map[string]any{"id": id, "amount": amount, "remaining": rem, "issuedAt": issued, "expiresAt": exp, "sourceType": src})
		}
		writeJSON(w, 200, out)
		return nil
	case "/api/credits/check":
		var in struct {
			Amount float64 `json:"amount"`
		}
		if err := decodeBody(r, &in); err != nil {
			return err
		}
		var bal float64
		var status string
		if err := b.db.QueryRow(r.Context(), `SELECT balance,status FROM credits_balance WHERE user_id=$1`, s.User.ID).Scan(&bal, &status); err != nil {
			return err
		}
		writeJSON(w, 200, map[string]any{"available": in.Amount > 0 && bal >= in.Amount && status == "active", "currentBalance": bal, "required": in.Amount, "status": status})
		return nil
	case "/api/credits/use":
		var in struct {
			Amount      float64        `json:"amount"`
			ServiceName string         `json:"serviceName"`
			Description string         `json:"description"`
			Metadata    map[string]any `json:"metadata"`
		}
		if err := decodeBody(r, &in); err != nil {
			return err
		}
		if in.Amount <= 0 || strings.TrimSpace(in.ServiceName) == "" {
			return invalid("积分数量和服务名不能为空")
		}
		tx, err := b.db.Begin(r.Context())
		if err != nil {
			return err
		}
		defer rollback(tx)
		if _, err = tx.Exec(r.Context(), `INSERT INTO credits_balance(id,user_id) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING`, newRequestID(), s.User.ID); err != nil {
			return err
		}
		var bal float64
		var st string
		if err = tx.QueryRow(r.Context(), `SELECT balance,status FROM credits_balance WHERE user_id=$1 FOR UPDATE`, s.User.ID).Scan(&bal, &st); err != nil {
			return err
		}
		if st != "active" {
			writeJSON(w, 200, map[string]any{"success": false, "error": "account_frozen", "message": "积分账户已冻结"})
			return nil
		}
		if bal < in.Amount {
			writeJSON(w, 200, map[string]any{"success": false, "error": "insufficient_credits", "message": "积分不足", "required": in.Amount, "available": bal})
			return nil
		}
		if _, err = tx.Exec(r.Context(), `UPDATE credits_balance SET balance=balance-$2,total_spent=total_spent+$2,updated_at=now() WHERE user_id=$1`, s.User.ID, in.Amount); err != nil {
			return err
		}
		raw, _ := json.Marshal(in.Metadata)
		id := newRequestID()
		if _, err = tx.Exec(r.Context(), `INSERT INTO credits_transaction(id,user_id,type,amount,debit_account,credit_account,description,metadata) VALUES($1,$2,'consumption',$3,$4,$5,$6,$7)`, id, s.User.ID, in.Amount, "WALLET:"+s.User.ID, "SERVICE:"+in.ServiceName, in.Description, raw); err != nil {
			return err
		}
		if err = tx.Commit(r.Context()); err != nil {
			return err
		}
		writeJSON(w, 200, map[string]any{"success": true, "consumedAmount": in.Amount, "remainingBalance": bal - in.Amount, "transactionId": id})
		return nil
	}
	return invalid("unknown credits resource")
}

func randomAPIKey() (string, error) {
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		return "", e
	}
	return "sk-" + base64.RawURLEncoding.EncodeToString(b), nil
}

func (b *backend) handleAPIKeys(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireSession(r)
	if err != nil {
		return err
	}
	keyID := strings.TrimPrefix(r.URL.Path, "/api/external-api/keys/")
	switch r.Method {
	case http.MethodGet:
		rows, err := b.db.Query(r.Context(), `SELECT id,name,key_prefix,last_four,generation_group_id,credit_limit,credits_used,last_used_at,is_active,created_at,updated_at FROM external_api_key WHERE user_id=$1 ORDER BY created_at DESC,id DESC`, s.User.ID)
		if err != nil {
			return err
		}
		defer rows.Close()
		out := []any{}
		for rows.Next() {
			var id, name, prefix, last4 string
			var group *string
			var limit, used *float64
			var last *time.Time
			var active bool
			var created, updated time.Time
			if err := rows.Scan(&id, &name, &prefix, &last4, &group, &limit, &used, &last, &active, &created, &updated); err != nil {
				return err
			}
			out = append(out, map[string]any{"id": id, "name": name, "keyPrefix": prefix, "lastFour": last4, "generationGroupId": group, "creditLimit": limit, "creditsUsed": used, "lastUsedAt": last, "isActive": active, "createdAt": created, "updatedAt": updated, "apiKey": nil})
		}
		writeJSON(w, 200, map[string]any{"keys": out, "editableGroups": []any{}})
		return nil
	case http.MethodPost:
		var in struct {
			Name              string   `json:"name"`
			GenerationGroupID *string  `json:"generationGroupId"`
			CreditLimit       *float64 `json:"creditLimit"`
		}
		if err := decodeBody(r, &in); err != nil {
			return err
		}
		if strings.TrimSpace(in.Name) == "" {
			in.Name = "默认 API 密钥"
		}
		secret, err := randomAPIKey()
		if err != nil {
			return err
		}
		hash := sha256.Sum256([]byte(secret))
		id := newRequestID()
		now := time.Now().UTC()
		var outID string
		err = b.db.QueryRow(r.Context(), `INSERT INTO external_api_key(id,user_id,name,key_prefix,key_hash,last_four,generation_group_id,credit_limit,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id`, id, s.User.ID, in.Name, secret[:7], hex.EncodeToString(hash[:]), secret[len(secret)-4:], in.GenerationGroupID, in.CreditLimit, now).Scan(&outID)
		if err != nil {
			return err
		}
		writeJSON(w, 201, map[string]any{"apiKey": secret, "key": map[string]any{"id": outID, "name": in.Name, "keyPrefix": secret[:7], "lastFour": secret[len(secret)-4:], "isActive": true, "creditLimit": in.CreditLimit, "creditsUsed": 0, "generationGroupId": in.GenerationGroupID, "createdAt": now, "updatedAt": now}})
		return nil
	case http.MethodPatch:
		var in struct {
			GenerationGroupID *string  `json:"generationGroupId"`
			CreditLimit       *float64 `json:"creditLimit"`
		}
		if err := decodeBody(r, &in); err != nil {
			return err
		}
		if keyID == "" {
			return invalid("API 密钥 ID 无效")
		}
		_, err = b.db.Exec(r.Context(), `UPDATE external_api_key SET generation_group_id=COALESCE($3,generation_group_id),credit_limit=CASE WHEN $4::boolean THEN $5 ELSE credit_limit END,updated_at=now() WHERE id=$1 AND user_id=$2 AND is_active`, keyID, s.User.ID, in.GenerationGroupID, in.CreditLimit != nil, in.CreditLimit)
		if err != nil {
			return err
		}
		writeJSON(w, 200, map[string]any{"id": keyID})
		return nil
	case http.MethodDelete:
		if keyID == "" {
			return invalid("API 密钥 ID 无效")
		}
		if r.URL.Query().Get("hard") == "1" {
			_, err = b.db.Exec(r.Context(), `DELETE FROM external_api_key WHERE id=$1 AND user_id=$2 AND NOT is_active`, keyID, s.User.ID)
		} else {
			_, err = b.db.Exec(r.Context(), `UPDATE external_api_key SET is_active=false,updated_at=now() WHERE id=$1 AND user_id=$2 AND is_active`, keyID, s.User.ID)
		}
		if err != nil {
			return err
		}
		writeJSON(w, 200, map[string]any{"id": keyID})
		return nil
	}
	return invalid("不支持的请求方法")
}

func (b *backend) registerAccountRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/user/profile", b.endpoint(b.handleProfile))
	mux.HandleFunc("PATCH /api/user/profile", b.endpoint(b.handleProfile))
	mux.HandleFunc("GET /api/credits/balance", b.endpoint(b.handleCreditsBalance))
	mux.HandleFunc("GET /api/credits/transactions", b.endpoint(b.handleCreditsTransactions))
	mux.HandleFunc("GET /api/credits/top-up/options", b.endpoint(b.handleTopUpOptions))
	mux.HandleFunc("POST /api/credits/use", b.endpoint(b.handleCreditsResource))
	mux.HandleFunc("POST /api/credits/check", b.endpoint(b.handleCreditsResource))
	mux.HandleFunc("GET /api/credits/active-batches", b.endpoint(b.handleCreditsResource))
	mux.HandleFunc("GET /api/external-api/keys", b.endpoint(b.handleAPIKeys))
	mux.HandleFunc("POST /api/external-api/keys", b.endpoint(b.handleAPIKeys))
	mux.HandleFunc("PATCH /api/external-api/keys/{id}", b.endpoint(b.handleAPIKeys))
	mux.HandleFunc("DELETE /api/external-api/keys/{id}", b.endpoint(b.handleAPIKeys))
}
