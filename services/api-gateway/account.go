package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
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
	uid, err := b.requireCreditsUser(r)
	if err != nil {
		return err
	}
	if r.URL.Query().Get("registrationBonus") == "1" {
		session, e := b.requireSession(r)
		if e != nil {
			return e
		}
		if _, e = b.grantRegistrationBonus(r, session.User.ID); e != nil {
			return e
		}
	}
	result, err := b.creditWalletSnapshot(r, uid)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, result)
	return nil
}
func (b *backend) handleCreditsTransactions(w http.ResponseWriter, r *http.Request) error {
	uid, err := b.requireCreditsUser(r)
	if err != nil {
		return err
	}
	result, err := b.creditsTransactionsForUser(r, uid)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, result)
	return nil
}

func (b *backend) handleTopUpOptions(w http.ResponseWriter, r *http.Request) error {
	if _, err := b.requireSession(r); err != nil {
		return err
	}
	value, err := b.topUpOptions(r.Context())
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, value)
	return nil
}

func (b *backend) handleCreditsResource(w http.ResponseWriter, r *http.Request) error {
	uid, err := b.requireCreditsUser(r)
	if err != nil {
		return err
	}
	if r.URL.Path == "/api/credits/active-batches" {
		batches, err := b.creditsBatchesForUser(r, uid)
		if err != nil {
			return err
		}
		writeJSON(w, 200, batches)
		return nil
	}
	var in struct {
		Amount      float64        `json:"amount"`
		ServiceName string         `json:"serviceName"`
		Description string         `json:"description"`
		Metadata    map[string]any `json:"metadata"`
	}
	if err = decodeBody(r, &in); err != nil {
		return err
	}
	amount, err := validateCreditAmount(in.Amount, false)
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
	if r.URL.Path == "/api/credits/check" {
		if err = tx.Commit(r.Context()); err != nil {
			return err
		}
		writeJSON(w, 200, map[string]any{"available": wallet.Status == "active" && wallet.Balance >= amount, "currentBalance": wallet.Balance, "balance": wallet.Balance, "required": amount, "status": wallet.Status})
		return nil
	}
	result, err := b.consumeCreditTx(r, tx, wallet, creditMutation{UserID: uid, Amount: amount, ServiceName: in.ServiceName, Reason: in.Description, Metadata: in.Metadata, OperationType: "manual_consumption"})
	if err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"success": true, "consumedAmount": amount, "remainingBalance": result.Balance, "transactionId": result.TransactionID})
	return nil
}

func randomAPIKey() (string, error) {
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		return "", e
	}
	return "sk-" + base64.RawURLEncoding.EncodeToString(b), nil
}

// API keys are recoverable by their owner after creation.  Keep the format
// byte-compatible with the web implementation so keys created before this
// endpoint was moved to Go remain readable by either process.
func (b *backend) encryptAPIKey(secret string) (string, error) {
	if strings.TrimSpace(b.config.authSecret) == "" {
		return "", errors.New("BETTER_AUTH_SECRET is required for API key encryption")
	}
	keyMaterial := sha256.Sum256([]byte("FluxMedia external API key encryption v1\x00" + b.config.authSecret))
	block, err := aes.NewCipher(keyMaterial[:])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCMWithNonceSize(block, 12)
	if err != nil {
		return "", err
	}
	iv := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, iv); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nil, iv, []byte(secret), []byte("external-api-key:v1"))
	tagSize := gcm.Overhead()
	tag := sealed[len(sealed)-tagSize:]
	ciphertext := sealed[:len(sealed)-tagSize]
	return "v1." + base64.RawURLEncoding.EncodeToString(iv) + "." + base64.RawURLEncoding.EncodeToString(tag) + "." + base64.RawURLEncoding.EncodeToString(ciphertext), nil
}

func (b *backend) decryptAPIKey(value string) (string, error) {
	parts := strings.Split(value, ".")
	if len(parts) != 4 || parts[0] != "v1" || strings.TrimSpace(b.config.authSecret) == "" {
		return "", errors.New("invalid encrypted API key")
	}
	iv, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || len(iv) != 12 {
		return "", errors.New("invalid encrypted API key")
	}
	tag, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(tag) != 16 {
		return "", errors.New("invalid encrypted API key")
	}
	ciphertext, err := base64.RawURLEncoding.DecodeString(parts[3])
	if err != nil {
		return "", errors.New("invalid encrypted API key")
	}
	keyMaterial := sha256.Sum256([]byte("FluxMedia external API key encryption v1\x00" + b.config.authSecret))
	block, err := aes.NewCipher(keyMaterial[:])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCMWithNonceSize(block, 12)
	if err != nil {
		return "", err
	}
	sealed := append(append([]byte{}, ciphertext...), tag...)
	plain, err := gcm.Open(nil, iv, sealed, []byte("external-api-key:v1"))
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

func normalizeAPIKeyCreditLimit(value *float64) (*float64, error) {
	if value == nil {
		return nil, nil
	}
	if *value < 0 || *value != *value || *value > 1e15 {
		return nil, invalid("API Key 额度必须是大于等于 0 的数字")
	}
	rounded := float64(int64(*value*100+0.5000000001)) / 100
	return &rounded, nil
}

func (b *backend) selectableAPIKeyGroups(r *http.Request) ([]map[string]any, error) {
	rows, err := b.db.Query(r.Context(), `SELECT id,name,is_enabled FROM image_backend_group WHERE is_enabled AND is_user_selectable ORDER BY priority ASC,id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	groups := []map[string]any{}
	for rows.Next() {
		var id, name string
		var enabled bool
		if err := rows.Scan(&id, &name, &enabled); err != nil {
			return nil, err
		}
		groups = append(groups, map[string]any{"id": id, "name": name, "enabled": enabled, "selectable": true})
	}
	return groups, rows.Err()
}

func (b *backend) apiKeySummary(r *http.Request, userID, keyID string, includeSecret bool) (map[string]any, error) {
	var id, name, prefix, last4 string
	var group *string
	var limit, used *float64
	var last *time.Time
	var active bool
	var created, updated time.Time
	var encrypted *string
	err := b.db.QueryRow(r.Context(), `SELECT id,name,key_prefix,last_four,generation_group_id,credit_limit,credits_used,last_used_at,is_active,created_at,updated_at,encrypted_key FROM external_api_key WHERE id=$1 AND user_id=$2`, keyID, userID).Scan(&id, &name, &prefix, &last4, &group, &limit, &used, &last, &active, &created, &updated, &encrypted)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, &apiError{http.StatusNotFound, "NOT_FOUND", "API 密钥不存在"}
	}
	if err != nil {
		return nil, err
	}
	creditsUsed := float64(0)
	if used != nil {
		creditsUsed = float64(int64(*used*100+0.5000000001)) / 100
	}
	var currentGroup map[string]any
	if group != nil && *group != "" {
		var groupName string
		var groupEnabled, groupSelectable bool
		if e := b.db.QueryRow(r.Context(), `SELECT name,is_enabled,is_user_selectable FROM image_backend_group WHERE id=$1`, *group).Scan(&groupName, &groupEnabled, &groupSelectable); e == nil {
			currentGroup = map[string]any{"id": *group, "name": groupName, "enabled": groupEnabled, "selectable": groupEnabled && groupSelectable}
		}
	}
	result := map[string]any{"id": id, "name": name, "keyPrefix": prefix, "lastFour": last4, "generationGroupId": group, "creditLimit": limit, "creditsUsed": creditsUsed, "lastUsedAt": last, "isActive": active, "createdAt": created, "updatedAt": updated, "currentGroup": currentGroup, "apiKey": nil}
	if includeSecret && encrypted != nil {
		if secret, e := b.decryptAPIKey(*encrypted); e == nil {
			result["apiKey"] = secret
		}
	}
	return result, nil
}

// handleInternalExternalQuota is the bridge used by the remaining Go-backed
// media operation callers.  It is authenticated with a body HMAC so a public
// client cannot submit an arbitrary user/key pair; PostgreSQL remains the
// authority for the atomic reservation and refund.
func (b *backend) handleInternalExternalQuota(w http.ResponseWriter, r *http.Request) error {
	raw, err := io.ReadAll(io.LimitReader(r.Body, b.config.maxBodyBytes+1))
	if err != nil || int64(len(raw)) > b.config.maxBodyBytes {
		return &apiError{http.StatusRequestEntityTooLarge, "REQUEST_BODY_TOO_LARGE", "请求体过大"}
	}
	signature := strings.TrimSpace(r.Header.Get("X-Go-Internal-Signature"))
	mac := hmac.New(sha256.New, []byte(b.config.authSecret))
	_, _ = mac.Write(raw)
	expected := hex.EncodeToString(mac.Sum(nil))
	if signature == "" || subtle.ConstantTimeCompare([]byte(signature), []byte(expected)) != 1 {
		return &apiError{http.StatusUnauthorized, "UNAUTHORIZED", "内部调用签名无效"}
	}
	var in struct {
		Action string  `json:"action"`
		UserID string  `json:"userId"`
		KeyID  string  `json:"apiKeyId"`
		Amount float64 `json:"amount"`
	}
	if err := json.Unmarshal(raw, &in); err != nil {
		return invalid("请求 JSON 无效")
	}
	if strings.TrimSpace(in.UserID) == "" || strings.TrimSpace(in.KeyID) == "" {
		return invalid("API 密钥身份无效")
	}
	switch in.Action {
	case "get":
		key, err := b.apiKeySummary(r, in.UserID, in.KeyID, false)
		if err != nil {
			return err
		}
		limit, _ := key["creditLimit"].(*float64)
		used, _ := key["creditsUsed"].(float64)
		var remaining any
		if limit != nil {
			remaining = maxFloat(0, *limit-used)
		}
		key["creditsRemaining"] = remaining
		writeJSON(w, http.StatusOK, key)
		return nil
	case "reserve", "refund":
		if in.Amount <= 0 || in.Amount > 1e15 || in.Amount != in.Amount {
			return invalid("额度数量无效")
		}
		amount := float64(int64(in.Amount*100+0.5000000001)) / 100
		var tag pgconn.CommandTag
		if in.Action == "reserve" {
			tag, err = b.db.Exec(r.Context(), `UPDATE external_api_key SET credits_used=credits_used+$3,updated_at=now() WHERE id=$1 AND user_id=$2 AND is_active AND (credit_limit IS NULL OR credit_limit-credits_used >= $3)`, in.KeyID, in.UserID, amount)
		} else {
			tag, err = b.db.Exec(r.Context(), `UPDATE external_api_key SET credits_used=GREATEST(0,credits_used-$3),updated_at=now() WHERE id=$1 AND user_id=$2`, in.KeyID, in.UserID, amount)
		}
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 && in.Action == "reserve" {
			key, e := b.apiKeySummary(r, in.UserID, in.KeyID, false)
			if e != nil {
				return e
			}
			limit, _ := key["creditLimit"].(*float64)
			used, _ := key["creditsUsed"].(float64)
			remaining := maxFloat(0, amount)
			if limit != nil {
				remaining = maxFloat(0, *limit-used)
			}
			return &apiError{http.StatusTooManyRequests, "api_key_quota_exceeded", fmt.Sprintf("API key quota exceeded: required %.2f, remaining %.2f", amount, remaining)}
		}
		writeJSON(w, http.StatusOK, map[string]any{"amount": amount})
		return nil
	default:
		return invalid("未知额度操作")
	}
}

func maxFloat(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

func (b *backend) handleAPIKeys(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireSession(r)
	if err != nil {
		return err
	}
	keyID := strings.TrimPrefix(r.URL.Path, "/api/external-api/keys/")
	switch r.Method {
	case http.MethodGet:
		rows, err := b.db.Query(r.Context(), `SELECT id FROM external_api_key WHERE user_id=$1 ORDER BY created_at DESC,id DESC`, s.User.ID)
		if err != nil {
			return err
		}
		defer rows.Close()
		out := []any{}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				return err
			}
			item, e := b.apiKeySummary(r, s.User.ID, id, true)
			if e != nil {
				return e
			}
			out = append(out, item)
		}
		groups, err := b.selectableAPIKeyGroups(r)
		if err != nil {
			return err
		}
		writeJSON(w, 200, map[string]any{"keys": out, "editableGroups": groups})
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
		limit, err := normalizeAPIKeyCreditLimit(in.CreditLimit)
		if err != nil {
			return err
		}
		if in.GenerationGroupID != nil && strings.TrimSpace(*in.GenerationGroupID) != "" && *in.GenerationGroupID != "default" {
			var selectable bool
			if err := b.db.QueryRow(r.Context(), `SELECT is_enabled AND is_user_selectable FROM image_backend_group WHERE id=$1`, *in.GenerationGroupID).Scan(&selectable); err != nil || !selectable {
				return invalid("所选生图分组当前不可用")
			}
		} else {
			in.GenerationGroupID = nil
		}
		secret, err := randomAPIKey()
		if err != nil {
			return err
		}
		encrypted, err := b.encryptAPIKey(secret)
		if err != nil {
			return err
		}
		hash := sha256.Sum256([]byte(secret))
		id := newRequestID()
		now := time.Now().UTC()
		var outID string
		err = b.db.QueryRow(r.Context(), `INSERT INTO external_api_key(id,user_id,name,key_prefix,key_hash,encrypted_key,last_four,generation_group_id,credit_limit,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING id`, id, s.User.ID, in.Name, secret[:7], hex.EncodeToString(hash[:]), encrypted, secret[len(secret)-4:], in.GenerationGroupID, limit, now).Scan(&outID)
		if err != nil {
			return err
		}
		key, err := b.apiKeySummary(r, s.User.ID, outID, false)
		if err != nil {
			return err
		}
		writeJSON(w, 201, map[string]any{"apiKey": secret, "key": key})
		return nil
	case http.MethodPatch:
		body, err := decodeObject(r)
		if err != nil {
			return err
		}
		for field := range body {
			if field != "keyId" && field != "generationGroupId" && field != "creditLimit" {
				return invalid("请求包含未知字段")
			}
		}
		var suppliedKeyID string
		if raw, ok := body["keyId"]; ok {
			if e := json.Unmarshal(raw, &suppliedKeyID); e != nil {
				return invalid("API 密钥 ID 无效")
			}
		}
		if keyID == "" {
			return invalid("API 密钥 ID 无效")
		}
		if suppliedKeyID != "" && suppliedKeyID != keyID {
			return invalid("API 密钥 ID 无效")
		}
		groupSupplied := false
		var groupValue *string
		if raw, ok := body["generationGroupId"]; ok {
			groupSupplied = true
			if string(raw) != "null" {
				var value string
				if e := json.Unmarshal(raw, &value); e != nil {
					return invalid("生图分组无效")
				}
				groupValue = &value
			}
		}
		if groupSupplied {
			group := ""
			if groupValue != nil {
				group = strings.TrimSpace(*groupValue)
			}
			if group == "" || group == "default" {
				groupValue = nil
			} else {
				var selectable bool
				if err := b.db.QueryRow(r.Context(), `SELECT is_enabled AND is_user_selectable FROM image_backend_group WHERE id=$1`, group).Scan(&selectable); err != nil || !selectable {
					return invalid("所选生图分组当前不可用")
				}
			}
		}
		quotaSupplied := false
		var requestedLimit *float64
		if raw, ok := body["creditLimit"]; ok {
			quotaSupplied = true
			if string(raw) != "null" {
				var value float64
				if e := json.Unmarshal(raw, &value); e != nil {
					return invalid("API Key 额度无效")
				}
				requestedLimit = &value
			}
		}
		limit, err := normalizeAPIKeyCreditLimit(requestedLimit)
		if err != nil {
			return err
		}
		var tag pgconn.CommandTag
		if groupSupplied || quotaSupplied {
			if groupSupplied {
				tag, err = b.db.Exec(r.Context(), `UPDATE external_api_key SET generation_group_id=$3,updated_at=now() WHERE id=$1 AND user_id=$2 AND is_active`, keyID, s.User.ID, groupValue)
			} else {
				tag, err = b.db.Exec(r.Context(), `UPDATE external_api_key SET credit_limit=$3,updated_at=now() WHERE id=$1 AND user_id=$2 AND is_active`, keyID, s.User.ID, limit)
			}
		} else {
			return invalid("请至少提供一个更新字段")
		}
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			var active bool
			if e := b.db.QueryRow(r.Context(), `SELECT is_active FROM external_api_key WHERE id=$1 AND user_id=$2`, keyID, s.User.ID).Scan(&active); errors.Is(e, pgx.ErrNoRows) {
				return &apiError{http.StatusNotFound, "NOT_FOUND", "API 密钥不存在"}
			} else if e == nil && !active {
				return &apiError{http.StatusConflict, "STATE_CONFLICT", "已撤销的 API 密钥不能修改"}
			}
		}
		key, err := b.apiKeySummary(r, s.User.ID, keyID, false)
		if err != nil {
			return err
		}
		writeJSON(w, 200, key)
		return nil
	case http.MethodDelete:
		if keyID == "" {
			return invalid("API 密钥 ID 无效")
		}
		hardDelete := r.URL.Query().Get("hard") == "1"
		if hardDelete {
			result, e := b.db.Exec(r.Context(), `DELETE FROM external_api_key WHERE id=$1 AND user_id=$2 AND NOT is_active`, keyID, s.User.ID)
			err = e
			if e == nil && result.RowsAffected() == 0 {
				var active bool
				if e = b.db.QueryRow(r.Context(), `SELECT is_active FROM external_api_key WHERE id=$1 AND user_id=$2`, keyID, s.User.ID).Scan(&active); errors.Is(e, pgx.ErrNoRows) {
					return &apiError{http.StatusNotFound, "NOT_FOUND", "API 密钥不存在"}
				} else if e == nil {
					return &apiError{http.StatusConflict, "STATE_CONFLICT", "请先撤销 API 密钥再删除"}
				}
			}
		} else {
			result, e := b.db.Exec(r.Context(), `UPDATE external_api_key SET is_active=false,updated_at=now() WHERE id=$1 AND user_id=$2 AND is_active`, keyID, s.User.ID)
			err = e
			if e == nil && result.RowsAffected() == 0 {
				var active bool
				if e = b.db.QueryRow(r.Context(), `SELECT is_active FROM external_api_key WHERE id=$1 AND user_id=$2`, keyID, s.User.ID).Scan(&active); errors.Is(e, pgx.ErrNoRows) {
					return &apiError{http.StatusNotFound, "NOT_FOUND", "API 密钥不存在"}
				} else if e == nil {
					return &apiError{http.StatusConflict, "STATE_CONFLICT", "API 密钥已被撤销"}
				}
			}
		}
		if err != nil {
			return err
		}
		if err != nil {
			return err
		}
		if hardDelete {
			writeJSON(w, 200, map[string]any{"id": keyID})
			return nil
		}
		key, summaryErr := b.apiKeySummary(r, s.User.ID, keyID, false)
		if summaryErr != nil {
			return summaryErr
		}
		writeJSON(w, 200, key)
		return nil
	}
	return invalid("不支持的请求方法")
}

func (b *backend) registerAccountRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/internal/credits/service", b.endpoint(b.handleInternalCreditService))
	mux.HandleFunc("GET /api/internal/payments/epay/orders/{orderId}", b.endpoint(b.handleInternalEpayOrder))
	mux.HandleFunc("POST /api/internal/credits/operation", b.endpoint(b.handleInternalCreditsOperation))
	mux.HandleFunc("POST /api/internal/external-api/quota", b.endpoint(b.handleInternalExternalQuota))
	mux.HandleFunc("GET /api/user/profile", b.endpoint(b.handleProfile))
	mux.HandleFunc("PATCH /api/user/profile", b.endpoint(b.handleProfile))
	mux.HandleFunc("GET /api/credits/balance", b.endpoint(b.handleCreditsBalance))
	mux.HandleFunc("POST /api/credits/registration-bonus", b.endpoint(b.handleRegistrationBonus))
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
