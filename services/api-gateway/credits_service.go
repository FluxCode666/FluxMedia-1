package main

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
)

// The shared compatibility API has no database driver. These internal reads
// and maintenance operations share the same ledger used by the native routes.
func (b *backend) handleInternalCreditService(w http.ResponseWriter, r *http.Request) error {
	if !b.cronAuthorized(r) {
		return unauthorized()
	}
	var in struct {
		Operation, UserID, TransactionID string
		Limit, Offset                    int
	}
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	if in.UserID == "" && in.Operation != "processExpired" {
		return invalid("userId is required")
	}
	var output any
	var err error
	switch in.Operation {
	case "balance":
		if _, err = b.creditWalletSnapshot(r, in.UserID); err != nil {
			return err
		}
		var raw json.RawMessage
		err = b.db.QueryRow(r.Context(), `SELECT to_jsonb(b) FROM credits_balance b WHERE user_id=$1`, in.UserID).Scan(&raw)
		output = raw
	case "registrationBonus":
		output, err = b.grantRegistrationBonus(r, in.UserID)
	case "registrationBonusExpiry":
		err = b.repairRegistrationBonusExpiry(r, in.UserID)
		output = map[string]any{"success": err == nil}
	case "activeBatches":
		var raw json.RawMessage
		err = b.db.QueryRow(r.Context(), `SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY expires_at NULLS LAST,issued_at,id),'[]') FROM credits_batch b WHERE user_id=$1 AND status='active' AND remaining>0 AND (expires_at IS NULL OR expires_at>now())`, in.UserID).Scan(&raw)
		output = raw
	case "transactions":
		if in.Limit == 0 {
			in.Limit = 20
		}
		if in.Limit < 1 || in.Limit > 1000 || in.Offset < 0 {
			return invalid("Invalid pagination")
		}
		var raw json.RawMessage
		err = b.db.QueryRow(r.Context(), `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY created_at DESC,id DESC),'[]') FROM (SELECT * FROM credits_transaction WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3) t`, in.UserID, in.Limit, in.Offset).Scan(&raw)
		output = raw
	case "transaction":
		var raw json.RawMessage
		err = b.db.QueryRow(r.Context(), `SELECT to_jsonb(t) FROM credits_transaction t WHERE user_id=$1 AND id=$2`, in.UserID, in.TransactionID).Scan(&raw)
		output = raw
	case "transactionsCount":
		var count int
		err = b.db.QueryRow(r.Context(), `SELECT count(*) FROM credits_transaction WHERE user_id=$1`, in.UserID).Scan(&count)
		output = count
	case "processExpired":
		users := []string{in.UserID}
		if in.UserID == "" {
			users = nil
			rows, e := b.db.Query(r.Context(), `SELECT DISTINCT user_id FROM credits_batch WHERE status='active' AND expires_at<=now() AND remaining>0 ORDER BY user_id`)
			if e != nil {
				return e
			}
			for rows.Next() {
				var id string
				if e = rows.Scan(&id); e != nil {
					rows.Close()
					return e
				}
				users = append(users, id)
			}
			e = rows.Err()
			rows.Close()
			if e != nil {
				return e
			}
		}
		details := []expiredCreditBatch{}
		for _, uid := range users {
			tx, e := b.db.Begin(r.Context())
			if e != nil {
				return e
			}
			if _, e = tx.Exec(r.Context(), `INSERT INTO credits_balance(id,user_id) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING`, newRequestID(), uid); e == nil {
				_, e = tx.Exec(r.Context(), `SELECT id FROM credits_balance WHERE user_id=$1 FOR UPDATE`, uid)
			}
			var items []expiredCreditBatch
			if e == nil {
				items, e = b.expireUserCreditDetailsTx(r.Context(), tx, uid)
			}
			if e == nil {
				e = tx.Commit(r.Context())
			}
			if e != nil {
				rollback(tx)
				return e
			}
			details = append(details, items...)
		}
		output = details
	default:
		return invalid("Unknown credit service operation")
	}
	if err != nil {
		return err
	}
	writeJSON(w, 200, output)
	return nil
}

func (b *backend) handleInternalEpayOrder(w http.ResponseWriter, r *http.Request) error {
	if !b.cronAuthorized(r) {
		return unauthorized()
	}
	var raw json.RawMessage
	err := b.db.QueryRow(r.Context(), `SELECT json_build_object('metadata',metadata,'status',status) FROM epay_order WHERE out_trade_no=$1`, r.PathValue("orderId")).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, 200, nil)
		return nil
	}
	if err != nil {
		return err
	}
	writeJSON(w, 200, raw)
	return nil
}
