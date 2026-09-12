package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
)

type apiPrincipal struct{ UserID, KeyID string }

func (b *backend) authenticateAPI(r *http.Request) (*apiPrincipal, error) {
	fields := strings.Fields(r.Header.Get("Authorization"))
	if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") || len(fields[1]) > 512 {
		return nil, &apiError{401, "invalid_api_key", "Invalid or missing API key"}
	}
	hash := sha256.Sum256([]byte(fields[1]))
	var p apiPrincipal
	err := b.db.QueryRow(r.Context(), `UPDATE external_api_key k SET last_used_at=now(),updated_at=now() FROM "user" u WHERE k.user_id=u.id AND k.key_hash=$1 AND k.is_active AND NOT u.banned RETURNING k.id,k.user_id`, hex.EncodeToString(hash[:])).Scan(&p.KeyID, &p.UserID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, &apiError{401, "invalid_api_key", "Invalid or missing API key"}
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}
func (b *backend) expireCredits(r *http.Request, tx pgx.Tx, userID string) error {
	_, err := tx.Exec(r.Context(), `WITH expired AS (
 UPDATE credits_batch SET status='expired',updated_at=now() WHERE user_id=$1 AND status='active' AND expires_at<now() AND remaining>0
 RETURNING id,user_id,amount,remaining,expires_at), ledger AS (
 INSERT INTO credits_transaction(id,user_id,type,amount,debit_account,credit_account,description,metadata)
 SELECT $2||id,user_id,'expiration',remaining,'WALLET:'||user_id,'SYSTEM:expired','批次 '||id||' 过期',json_build_object('batchId',id,'originalAmount',amount,'expiredAmount',remaining,'expiresAt',expires_at) FROM expired RETURNING amount)
 UPDATE credits_balance SET balance=GREATEST(0,balance-COALESCE((SELECT sum(amount) FROM ledger),0)),updated_at=now() WHERE user_id=$1 AND EXISTS(SELECT 1 FROM ledger)`, userID, newRequestID())
	return err
}
func (b *backend) handleExternalCredits(w http.ResponseWriter, r *http.Request) error {
	noStore(w)
	p, err := b.authenticateAPI(r)
	if err != nil {
		return err
	}
	tx, err := b.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer rollback(tx)
	if _, err := tx.Exec(r.Context(), `INSERT INTO credits_balance(id,user_id) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING`, newRequestID(), p.UserID); err != nil {
		return err
	}
	if _, err := tx.Exec(r.Context(), `SELECT id FROM credits_balance WHERE user_id=$1 FOR UPDATE`, p.UserID); err != nil {
		return err
	}
	if err := b.expireCredits(r, tx, p.UserID); err != nil {
		return err
	}
	var response []byte
	err = tx.QueryRow(r.Context(), `SELECT json_build_object('object','credit_balance','account',json_build_object('balance',b.balance,'total_earned',b.total_earned,'total_spent',b.total_spent,'status',b.status),'api_key',json_build_object('id',k.id,'name',k.name,'key_prefix',k.key_prefix,'last_four',k.last_four,'is_active',k.is_active,'credit_limit',k.credit_limit,'credits_used',k.credits_used,'credits_remaining',CASE WHEN k.credit_limit IS NULL THEN NULL ELSE GREATEST(0,k.credit_limit-k.credits_used) END,'unlimited',k.credit_limit IS NULL,'last_used_at',to_char(k.last_used_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'created_at',to_char(k.created_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) FROM credits_balance b JOIN external_api_key k ON k.user_id=b.user_id WHERE b.user_id=$1 AND k.id=$2`, p.UserID, p.KeyID).Scan(&response)
	if err != nil {
		return err
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	w.Header().Set("Content-Type", "application/json")
	_, err = w.Write(response)
	return err
}
func (b *backend) externalEndpoint(fn endpoint) http.HandlerFunc {
	return b.endpoint(func(w http.ResponseWriter, r *http.Request) error {
		enabled, err := b.settingBool(r.Context(), "EXTERNAL_API_CORS_ENABLED", true)
		if err != nil {
			return err
		}
		if enabled {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.Header().Set("Access-Control-Expose-Headers", "X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After")
			if r.Method == "OPTIONS" {
				w.Header().Set("Access-Control-Max-Age", "86400")
				if headers := r.Header.Get("Access-Control-Request-Headers"); headers != "" {
					w.Header().Set("Access-Control-Allow-Headers", headers)
				}
			}
		}
		if r.Method == "OPTIONS" {
			w.WriteHeader(204)
			return nil
		}
		return fn(w, r)
	})
}
func (b *backend) registerExternalAPI(mux *http.ServeMux) {
	for _, prefix := range []string{"/api/v1", "/v1"} {
		mux.HandleFunc("GET "+prefix+"/models", b.externalEndpoint(b.handleExternalModels))
		mux.HandleFunc("OPTIONS "+prefix+"/models", b.externalEndpoint(b.handleExternalModels))
		mux.HandleFunc("GET "+prefix+"/credits", b.externalEndpoint(b.handleExternalCredits))
		mux.HandleFunc("OPTIONS "+prefix+"/credits", b.externalEndpoint(b.handleExternalCredits))
	}
}
