package main

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type creditWallet struct {
	Balance, Earned, Spent, Refunded float64
	Status                           string
}
type creditMutation struct {
	Operation          string         `json:"operation"`
	UserID             string         `json:"userId"`
	Amount             float64        `json:"amount"`
	Type               string         `json:"type"`
	SourceType         string         `json:"sourceType"`
	SourceRef          string         `json:"sourceRef"`
	Reason             string         `json:"reason"`
	DebitAccount       string         `json:"debitAccount"`
	ServiceName        string         `json:"serviceName"`
	ExpiresAt          *time.Time     `json:"expiresAt"`
	NoExpiry           bool           `json:"noExpiry"`
	OperationType      string         `json:"operationType"`
	OperationID        string         `json:"operationId"`
	OperationCreatedAt *time.Time     `json:"operationCreatedAt"`
	Metadata           map[string]any `json:"metadata"`
}
type creditMutationResult struct {
	BatchID       string  `json:"batchId,omitempty"`
	TransactionID string  `json:"transactionId,omitempty"`
	Balance       float64 `json:"balance"`
	Replayed      bool    `json:"replayed"`
}

func creditRound(n float64) float64 { return math.Round(n*100) / 100 }
func validateCreditAmount(n float64, allowZero bool) (float64, error) {
	if math.IsNaN(n) || math.IsInf(n, 0) || n > 1e12 || n < 0 {
		return 0, invalid("积分数量无效")
	}
	n = creditRound(n)
	if n == 0 && !allowZero {
		return 0, invalid("积分数量必须大于 0")
	}
	return n, nil
}
func creditConflict() error {
	return &apiError{409, "IDEMPOTENCY_CONFLICT", "积分请求与原账本记录不一致"}
}

// All ledger mutations lock the wallet before any batch. This serializes grant,
// spend, refund and admin set operations for a user, including expiry writes.
func (b *backend) lockCreditWallet(r *http.Request, tx pgx.Tx, uid string) (creditWallet, error) {
	var wallet creditWallet
	if _, e := tx.Exec(r.Context(), `INSERT INTO credits_balance(id,user_id) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING`, newRequestID(), uid); e != nil {
		return wallet, e
	}
	if e := tx.QueryRow(r.Context(), `SELECT balance,total_earned,total_spent,total_refunded,status FROM credits_balance WHERE user_id=$1 FOR UPDATE`, uid).Scan(&wallet.Balance, &wallet.Earned, &wallet.Spent, &wallet.Refunded, &wallet.Status); e != nil {
		return wallet, e
	}
	if _, e := b.expireUserCreditsTx(r.Context(), tx, uid); e != nil {
		return wallet, e
	}
	e := tx.QueryRow(r.Context(), `SELECT balance,total_earned,total_spent,total_refunded,status FROM credits_balance WHERE user_id=$1`, uid).Scan(&wallet.Balance, &wallet.Earned, &wallet.Spent, &wallet.Refunded, &wallet.Status)
	return wallet, e
}

type expiredCreditBatch struct {
	BatchID       string  `json:"batchId"`
	UserID        string  `json:"userId"`
	ExpiredAmount float64 `json:"expiredAmount"`
}

func (b *backend) expireUserCreditsTx(ctx context.Context, tx pgx.Tx, uid string) (int, error) {
	details, err := b.expireUserCreditDetailsTx(ctx, tx, uid)
	return len(details), err
}
func (b *backend) expireUserCreditDetailsTx(ctx context.Context, tx pgx.Tx, uid string) ([]expiredCreditBatch, error) {
	rows, err := tx.Query(ctx, `WITH expired AS (UPDATE credits_batch SET status='expired',updated_at=now() WHERE user_id=$1 AND status='active' AND expires_at<=now() AND remaining>0 RETURNING id,user_id,remaining,expires_at), ledger AS (INSERT INTO credits_transaction(id,user_id,type,amount,debit_account,credit_account,description,metadata) SELECT $2||id,user_id,'expiration',remaining,'WALLET:'||user_id,'SYSTEM:expired','积分批次过期',json_build_object('batchId',id,'expiredAmount',remaining,'expiresAt',expires_at) FROM expired RETURNING amount), updated AS (UPDATE credits_balance SET balance=GREATEST(0,balance-COALESCE((SELECT sum(amount) FROM ledger),0)),updated_at=now() WHERE user_id=$1 AND EXISTS(SELECT 1 FROM ledger)) SELECT id,user_id,remaining FROM expired`, uid, newRequestID())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	details := []expiredCreditBatch{}
	for rows.Next() {
		var item expiredCreditBatch
		if err = rows.Scan(&item.BatchID, &item.UserID, &item.ExpiredAmount); err != nil {
			return nil, err
		}
		details = append(details, item)
	}
	return details, rows.Err()
}
func (b *backend) creditExpiry(ctx context.Context, source string, explicit *time.Time) (*time.Time, error) {
	if explicit != nil {
		utc := explicit.UTC()
		return &utc, nil
	}
	key, fallback := "CREDITS_EXPIRY_DAYS", float64(0)
	if source == "bonus" || source == "referral" {
		key, fallback = "FREE_CREDITS_EXPIRY_DAYS", 7
	}
	raw, e := b.setting(ctx, key, fallback)
	if e != nil {
		return nil, e
	}
	days := imageCreditValue(raw, fallback)
	if days <= 0 {
		if fallback > 0 {
			days = fallback
		} else {
			return nil, nil
		}
	}
	if math.IsNaN(days) || math.IsInf(days, 0) || days > 36500 {
		return nil, invalid("积分有效期配置无效")
	}
	expires := time.Now().UTC().Add(time.Duration(days * 24 * float64(time.Hour)))
	return &expires, nil
}

func (b *backend) grantCreditTx(r *http.Request, tx pgx.Tx, wallet creditWallet, in creditMutation) (creditMutationResult, error) {
	result := creditMutationResult{Balance: wallet.Balance}
	amount, e := validateCreditAmount(in.Amount, false)
	if e != nil {
		return result, e
	}
	source, typ := in.SourceType, "admin_grant"
	if in.Type != "" {
		typ = in.Type
	}
	if source == "purchase" {
		typ = "purchase"
	}
	if in.Operation == "refund" {
		if in.Type != "" && in.Type != "refund" {
			return result, invalid("退款交易类型无效")
		}
		source, typ = "refund", "refund"
	}
	if in.Type == "registration_bonus" {
		source, typ = "bonus", "registration_bonus"
	}
	if source != "purchase" && source != "bonus" && source != "refund" && source != "referral" && source != "subscription" {
		return result, invalid("积分来源类型无效")
	}
	if (typ == "refund") != (source == "refund") {
		return result, invalid("退款必须使用退款积分批次")
	}
	switch typ {
	case "purchase", "monthly_grant", "registration_bonus", "admin_grant", "refund", "referral_reward":
	default:
		return result, invalid("积分交易类型无效")
	}
	debit := in.DebitAccount
	if debit == "" {
		debit = "SYSTEM:" + source
	}
	if in.SourceRef != "" {
		var uid, batchID string
		var previous float64
		e = tx.QueryRow(r.Context(), `SELECT id,user_id,amount FROM credits_batch WHERE source_type=$1 AND source_ref=$2`, source, in.SourceRef).Scan(&batchID, &uid, &previous)
		if e == nil {
			if uid != in.UserID || creditRound(previous) != amount {
				return result, creditConflict()
			}
			if typ == "refund" {
				var opType, opID string
				var opAt time.Time
				if e = tx.QueryRow(r.Context(), `SELECT operation_type,operation_id,operation_created_at FROM credits_transaction WHERE user_id=$1 AND type='refund' AND source_ref=$2`, in.UserID, in.SourceRef).Scan(&opType, &opID, &opAt); e != nil {
					return result, creditConflict()
				}
				if opType != in.OperationType || opID != in.OperationID || in.OperationCreatedAt == nil || !opAt.Equal(*in.OperationCreatedAt) {
					return result, creditConflict()
				}
			}
			result.BatchID, result.Replayed = batchID, true
			return result, nil
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return result, e
		}
	}
	if wallet.Status != "active" && typ != "refund" {
		return result, &apiError{403, "ACCOUNT_FROZEN", "积分账户已冻结"}
	}
	if typ == "refund" {
		if in.SourceRef == "" || in.OperationID == "" || in.OperationType == "" || in.OperationCreatedAt == nil {
			return result, invalid("退款必须引用原计费操作")
		}
		var gross, refunded float64
		var minAt, maxAt *time.Time
		e = tx.QueryRow(r.Context(), `SELECT COALESCE(sum(amount) FILTER(WHERE type='consumption'),0),COALESCE(sum(amount) FILTER(WHERE type='refund'),0),min(operation_created_at),max(operation_created_at) FROM credits_transaction WHERE user_id=$1 AND operation_type=$2 AND operation_id=$3 AND type IN ('consumption','refund')`, in.UserID, in.OperationType, in.OperationID).Scan(&gross, &refunded, &minAt, &maxAt)
		if e != nil {
			return result, e
		}
		if minAt == nil || maxAt == nil || !minAt.Equal(*in.OperationCreatedAt) || !maxAt.Equal(*in.OperationCreatedAt) || creditRound(refunded+amount) > creditRound(gross) {
			return result, creditConflict()
		}
	}
	var expires *time.Time
	if !in.NoExpiry {
		expires, e = b.creditExpiry(r.Context(), source, in.ExpiresAt)
	}
	if e != nil {
		return result, e
	}
	result.BatchID, result.TransactionID = newRequestID(), newRequestID()
	tag, e := tx.Exec(r.Context(), `INSERT INTO credits_batch(id,user_id,amount,remaining,source_type,source_ref,expires_at) VALUES($1,$2,$3,$3,$4,NULLIF($5,''),$6) ON CONFLICT(source_type,source_ref) WHERE source_ref IS NOT NULL DO NOTHING`, result.BatchID, in.UserID, amount, source, in.SourceRef, expires)
	if e != nil {
		return result, e
	}
	if tag.RowsAffected() == 0 {
		return result, creditConflict()
	}
	var opType, opID any
	var opAt any
	if typ == "refund" {
		opType, opID, opAt = in.OperationType, in.OperationID, in.OperationCreatedAt
	}
	_, e = tx.Exec(r.Context(), `INSERT INTO credits_transaction(id,user_id,type,amount,debit_account,credit_account,description,source_ref,operation_type,operation_id,operation_created_at,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,NULLIF($8,''),$9,$10,$11,$12)`, result.TransactionID, in.UserID, typ, amount, debit, "WALLET:"+in.UserID, in.Reason, in.SourceRef, opType, opID, opAt, mustJSON(in.Metadata))
	if e != nil {
		return result, e
	}
	if typ == "refund" {
		if e = b.rebuildCreditOperationTx(r.Context(), tx, in.UserID, in.OperationType, in.OperationID, *in.OperationCreatedAt); e != nil {
			return result, e
		}
	}
	_, e = tx.Exec(r.Context(), `UPDATE credits_balance SET balance=balance+$2,total_earned=total_earned+$2,total_refunded=total_refunded+CASE WHEN $3 THEN $2 ELSE 0 END,updated_at=now() WHERE user_id=$1`, in.UserID, amount, typ == "refund")
	result.Balance = creditRound(wallet.Balance + amount)
	return result, e
}

func (b *backend) consumeCreditTx(r *http.Request, tx pgx.Tx, wallet creditWallet, in creditMutation) (creditMutationResult, error) {
	result := creditMutationResult{Balance: wallet.Balance}
	amount, e := validateCreditAmount(in.Amount, false)
	if e != nil {
		return result, e
	}
	service := in.ServiceName
	if service == "" {
		service = in.Type
	}
	if strings.TrimSpace(service) == "" {
		return result, invalid("服务名称不能为空")
	}
	if in.SourceRef != "" {
		var amountBefore float64
		var serviceBefore string
		var storedType, storedID *string
		var storedAt *time.Time
		e = tx.QueryRow(r.Context(), `SELECT id,amount,credit_account,operation_type,operation_id,operation_created_at FROM credits_transaction WHERE user_id=$1 AND type='consumption' AND source_ref=$2`, in.UserID, in.SourceRef).Scan(&result.TransactionID, &amountBefore, &serviceBefore, &storedType, &storedID, &storedAt)
		if e == nil {
			if creditRound(amountBefore) != amount || serviceBefore != "SERVICE:"+service {
				return result, creditConflict()
			}
			if in.OperationType != "" && (storedType == nil || *storedType != in.OperationType) {
				return result, creditConflict()
			}
			if in.OperationID != "" && (storedID == nil || *storedID != in.OperationID) {
				return result, creditConflict()
			}
			if in.OperationCreatedAt != nil && (storedAt == nil || !storedAt.Equal(*in.OperationCreatedAt)) {
				return result, creditConflict()
			}
			result.Replayed = true
			return result, nil
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return result, e
		}
	}
	if wallet.Status != "active" {
		return result, &apiError{403, "ACCOUNT_FROZEN", "积分账户已冻结"}
	}
	if creditRound(wallet.Balance) < amount {
		return result, &apiError{402, "INSUFFICIENT_CREDITS", "积分不足"}
	}
	rows, e := tx.Query(r.Context(), `SELECT id,remaining FROM credits_batch WHERE user_id=$1 AND status='active' AND remaining>0 AND (expires_at IS NULL OR expires_at>now()) ORDER BY expires_at NULLS LAST,CASE source_type WHEN 'bonus' THEN 1 WHEN 'referral' THEN 1 WHEN 'subscription' THEN 2 WHEN 'purchase' THEN 3 ELSE 4 END,issued_at,id FOR UPDATE`, in.UserID)
	if e != nil {
		return result, e
	}
	type batch struct {
		ID        string
		Remaining float64
	}
	batches := []batch{}
	for rows.Next() {
		var row batch
		if e = rows.Scan(&row.ID, &row.Remaining); e != nil {
			rows.Close()
			return result, e
		}
		batches = append(batches, row)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return result, e
	}
	remaining := amount
	consumed := []map[string]any{}
	for _, batch := range batches {
		take := math.Min(remaining, batch.Remaining)
		if take <= 0 {
			break
		}
		_, e = tx.Exec(r.Context(), `UPDATE credits_batch SET remaining=remaining-$2,status=CASE WHEN remaining-$2<=0 THEN 'consumed'::credits_batch_status ELSE status END,updated_at=now() WHERE id=$1`, batch.ID, take)
		if e != nil {
			return result, e
		}
		consumed = append(consumed, map[string]any{"batchId": batch.ID, "consumedFromBatch": take})
		remaining = creditRound(remaining - take)
	}
	if remaining > 0 {
		return result, &apiError{402, "INSUFFICIENT_CREDITS", "可用积分批次不足"}
	}
	result.TransactionID = newRequestID()
	created := time.Now().UTC().Truncate(time.Microsecond)
	opType := in.OperationType
	if opType == "" {
		opType = "uol_credit_consumption"
	}
	opID := in.OperationID
	if opID == "" {
		opID = result.TransactionID
	}
	opAt := created
	if in.OperationCreatedAt != nil {
		opAt = *in.OperationCreatedAt
	}
	metadata := in.Metadata
	if metadata == nil {
		metadata = map[string]any{}
	}
	metadata["consumedBatches"] = consumed
	_, e = tx.Exec(r.Context(), `INSERT INTO credits_transaction(id,user_id,type,amount,debit_account,credit_account,description,source_ref,operation_type,operation_id,operation_created_at,metadata,created_at) VALUES($1,$2,'consumption',$3,$4,$5,$6,NULLIF($7,''),$8,$9,$10,$11,$12)`, result.TransactionID, in.UserID, amount, "WALLET:"+in.UserID, "SERVICE:"+service, in.Reason, in.SourceRef, opType, opID, opAt, mustJSON(metadata), created)
	if e != nil {
		return result, e
	}
	if e = b.rebuildCreditOperationTx(r.Context(), tx, in.UserID, opType, opID, opAt); e != nil {
		return result, e
	}
	_, e = tx.Exec(r.Context(), `UPDATE credits_balance SET balance=balance-$2,total_spent=total_spent+$2,updated_at=now() WHERE user_id=$1`, in.UserID, amount)
	result.Balance = creditRound(wallet.Balance - amount)
	return result, e
}

// Ledger rows remain the authority. Rebuilding a single operation also repairs
// older Go rows that existed before projection entries were written.
func (b *backend) rebuildCreditOperationTx(ctx context.Context, tx pgx.Tx, uid, typ, id string, at time.Time) error {
	var minAt, maxAt *time.Time
	var gross, refunded float64
	if e := tx.QueryRow(ctx, `SELECT min(operation_created_at),max(operation_created_at),COALESCE(sum(amount) FILTER(WHERE type='consumption'),0),COALESCE(sum(amount) FILTER(WHERE type='refund'),0) FROM credits_transaction WHERE user_id=$1 AND operation_type=$2 AND operation_id=$3 AND type IN ('consumption','refund')`, uid, typ, id).Scan(&minAt, &maxAt, &gross, &refunded); e != nil {
		return e
	}
	if minAt == nil || maxAt == nil || !minAt.Equal(at) || !maxAt.Equal(at) || creditRound(refunded) > creditRound(gross) {
		return creditConflict()
	}
	if _, e := tx.Exec(ctx, `INSERT INTO credit_usage_operation(user_id,operation_type,operation_id,operation_created_at,gross_consumed,refunded,net_consumed) VALUES($1,$2,$3,$4,$5,$6,$5::numeric-$6::numeric) ON CONFLICT(user_id,operation_type,operation_id) DO UPDATE SET operation_created_at=EXCLUDED.operation_created_at,gross_consumed=EXCLUDED.gross_consumed,refunded=EXCLUDED.refunded,net_consumed=EXCLUDED.net_consumed,updated_at=now()`, uid, typ, id, at, gross, refunded); e != nil {
		return e
	}
	_, e := tx.Exec(ctx, `INSERT INTO credit_usage_projection_entry(transaction_id,user_id,contribution_kind,amount,operation_type,operation_id,operation_created_at,transaction_created_at) SELECT id,user_id,type::text::credit_usage_contribution_kind,amount,operation_type,operation_id,operation_created_at,created_at FROM credits_transaction WHERE user_id=$1 AND operation_type=$2 AND operation_id=$3 AND type IN ('consumption','refund') ON CONFLICT(transaction_id) DO NOTHING`, uid, typ, id)
	return e
}

func (b *backend) requireCreditsUser(r *http.Request) (string, error) {
	if p, ok := b.signedInternalPrincipal(r); ok && p.Type == "apiKey" {
		table := "external_api_key"
		if p.CredentialKind == "mcp" {
			table = "mcp_api_key"
		}
		var valid bool
		e := b.db.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM `+table+` k JOIN "user" u ON u.id=k.user_id WHERE k.id=$1 AND k.user_id=$2 AND k.is_active AND NOT u.banned)`, p.APIKeyID, p.UserID).Scan(&valid)
		if e != nil {
			return "", e
		}
		if !valid {
			return "", unauthorized()
		}
		return p.UserID, nil
	}
	s, e := b.requireSession(r)
	if e != nil {
		return "", e
	}
	return s.User.ID, nil
}
func (b *backend) creditWalletSnapshot(r *http.Request, uid string) (map[string]any, error) {
	tx, e := b.db.Begin(r.Context())
	if e != nil {
		return nil, e
	}
	defer rollback(tx)
	wallet, e := b.lockCreditWallet(r, tx, uid)
	if e != nil {
		return nil, e
	}
	if e = tx.QueryRow(r.Context(), `SELECT COALESCE(sum(amount),0) FROM credits_transaction WHERE user_id=$1 AND type='refund'`, uid).Scan(&wallet.Refunded); e != nil {
		return nil, e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return nil, e
	}
	return map[string]any{"balance": wallet.Balance, "totalEarned": wallet.Earned, "totalSpent": wallet.Spent, "totalRefunded": wallet.Refunded, "totalNetSpent": math.Max(0, creditRound(wallet.Spent-wallet.Refunded)), "status": wallet.Status, "asOf": time.Now().UTC()}, nil
}
func (b *backend) creditsTransactionsForUser(r *http.Request, uid string) (map[string]any, error) {
	limit, offset := 50, 0
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, e := strconv.Atoi(raw)
		if e != nil || n < 1 || n > 1000 {
			return nil, invalid("分页数量必须在 1 到 1000 之间")
		}
		limit = n
	}
	if raw := r.URL.Query().Get("offset"); raw != "" {
		n, e := strconv.Atoi(raw)
		if e != nil || n < 0 {
			return nil, invalid("分页偏移量无效")
		}
		offset = n
	}
	tx, e := b.db.BeginTx(r.Context(), pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if e != nil {
		return nil, e
	}
	defer rollback(tx)
	rows, e := tx.Query(r.Context(), `SELECT id,type,amount,debit_account,credit_account,description,source_ref,metadata,created_at FROM credits_transaction WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3`, uid, limit, offset)
	if e != nil {
		return nil, e
	}
	items := []map[string]any{}
	for rows.Next() {
		var id, typ, debit, credit string
		var amount float64
		var description, ref *string
		var metadata json.RawMessage
		var created time.Time
		if e = rows.Scan(&id, &typ, &amount, &debit, &credit, &description, &ref, &metadata, &created); e != nil {
			rows.Close()
			return nil, e
		}
		items = append(items, map[string]any{"id": id, "type": typ, "amount": amount, "debitAccount": debit, "creditAccount": credit, "description": description, "sourceRef": ref, "metadata": metadata, "createdAt": created.UTC()})
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	var total int
	if e = tx.QueryRow(r.Context(), `SELECT count(*) FROM credits_transaction WHERE user_id=$1`, uid).Scan(&total); e != nil {
		return nil, e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return nil, e
	}
	return map[string]any{"transactions": items, "totalCount": total, "total": total}, nil
}
func (b *backend) creditsBatchesForUser(r *http.Request, uid string) ([]map[string]any, error) {
	rows, e := b.db.Query(r.Context(), `SELECT id,amount,remaining,issued_at,expires_at,source_type FROM credits_batch WHERE user_id=$1 AND status='active' AND remaining>0 AND (expires_at IS NULL OR expires_at>now()) ORDER BY expires_at NULLS LAST,issued_at,id`, uid)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id, source string
		var amount, remaining float64
		var issued time.Time
		var expires *time.Time
		if e = rows.Scan(&id, &amount, &remaining, &issued, &expires, &source); e != nil {
			return nil, e
		}
		items = append(items, map[string]any{"id": id, "amount": amount, "remaining": remaining, "issuedAt": issued.UTC(), "expiresAt": expires, "sourceType": source})
	}
	return items, rows.Err()
}
func (b *backend) handleAdminCreditsRead(w http.ResponseWriter, r *http.Request) error {
	if _, e := b.requireAdmin(r, false); e != nil {
		return e
	}
	uid := r.PathValue("id")
	switch r.PathValue("resource") {
	case "balance":
		v, e := b.creditWalletSnapshot(r, uid)
		if e != nil {
			return e
		}
		writeJSON(w, 200, v)
	case "transactions":
		v, e := b.creditsTransactionsForUser(r, uid)
		if e != nil {
			return e
		}
		writeJSON(w, 200, v)
	case "active-batches":
		v, e := b.creditsBatchesForUser(r, uid)
		if e != nil {
			return e
		}
		writeJSON(w, 200, v)
	default:
		return &apiError{404, "NOT_FOUND", "积分资源不存在"}
	}
	return nil
}

func (b *backend) handleInternalCreditsOperation(w http.ResponseWriter, r *http.Request) error {
	var in creditMutation
	if e := decodeBody(r, &in); e != nil {
		return e
	}
	if !b.cronAuthorized(r) {
		if in.Operation == "refund" || in.Operation == "processExpired" {
			return forbidden()
		}
		uid, e := b.requireCreditsUser(r)
		if e != nil {
			return e
		}
		// Public operation adapters only expose the controlled ledger fallback.
		if in.Operation == "consume" {
			in.OperationType = "uol_credit_consumption"
			in.OperationID = ""
			in.OperationCreatedAt = nil
		}
		if in.Operation == "grant" {
			in.DebitAccount = ""
			in.Type = ""
		}
		if in.Operation == "grant" || in.UserID != uid {
			actor, e := b.requireAdmin(r, false)
			if e != nil {
				return e
			}
			if in.Operation == "grant" && actor.User.ID == in.UserID {
				return forbidden()
			}
			if in.Operation != "getBalance" && in.Operation != "grant" {
				return forbidden()
			}
			var targetRole string
			if e = b.db.QueryRow(r.Context(), `SELECT role FROM "user" WHERE id=$1`, in.UserID).Scan(&targetRole); e != nil {
				return e
			}
			if actor.User.Role != "super_admin" && targetRole != "user" && targetRole != "observer_admin" {
				return forbidden()
			}
		}
	}

	if strings.TrimSpace(in.UserID) == "" {
		return invalid("userId is required")
	}
	switch in.Operation {
	case "grant", "consume", "refund", "getBalance", "processExpired":
	default:
		return invalid("unknown credits operation")
	}
	tx, e := b.db.Begin(r.Context())
	if e != nil {
		return e
	}
	defer rollback(tx)
	if in.Operation == "processExpired" {
		if _, e = tx.Exec(r.Context(), `SELECT id FROM credits_balance WHERE user_id=$1 FOR UPDATE`, in.UserID); e != nil {
			return e
		}
		count, e := b.expireUserCreditsTx(r.Context(), tx, in.UserID)
		if e != nil {
			return e
		}
		if e = tx.Commit(r.Context()); e != nil {
			return e
		}
		writeJSON(w, 200, map[string]any{"processedCount": count})
		return nil
	}
	wallet, e := b.lockCreditWallet(r, tx, in.UserID)
	if e != nil {
		return e
	}
	result := creditMutationResult{Balance: wallet.Balance}
	if in.Operation == "consume" {
		result, e = b.consumeCreditTx(r, tx, wallet, in)
	} else if in.Operation != "getBalance" {
		result, e = b.grantCreditTx(r, tx, wallet, in)
	}
	if e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	writeJSON(w, 200, result)
	return nil
}

// Registration rewards are lazy and idempotent for existing and new accounts.
// The balance lock serializes simultaneous wallet opens from different tabs.
func (b *backend) grantRegistrationBonus(r *http.Request, uid string) (map[string]any, error) {
	tx, e := b.db.Begin(r.Context())
	if e != nil {
		return nil, e
	}
	defer rollback(tx)
	wallet, e := b.lockCreditWallet(r, tx, uid)
	if e != nil {
		return nil, e
	}
	var exists bool
	if e = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM credits_transaction WHERE user_id=$1 AND type='registration_bonus')`, uid).Scan(&exists); e != nil {
		return nil, e
	}
	if exists {
		if e = b.repairRegistrationBonusExpiryTx(r, tx, uid); e != nil {
			return nil, e
		}
		if e = tx.QueryRow(r.Context(), `SELECT balance FROM credits_balance WHERE user_id=$1`, uid).Scan(&wallet.Balance); e != nil {
			return nil, e
		}
		if e = tx.Commit(r.Context()); e != nil {
			return nil, e
		}
		return map[string]any{"success": true, "alreadyGranted": true, "granted": false, "balance": wallet.Balance}, nil
	}
	raw, e := b.setting(r.Context(), "REGISTRATION_BONUS_CREDITS", 100)
	if e != nil {
		return nil, e
	}
	amount, e := validateCreditAmount(imageCreditValue(raw, 100), true)
	if e != nil {
		return nil, e
	}
	if amount == 0 {
		if e = tx.Commit(r.Context()); e != nil {
			return nil, e
		}
		return map[string]any{"success": true, "alreadyGranted": false, "granted": false, "balance": wallet.Balance}, nil
	}
	result, e := b.grantCreditTx(r, tx, wallet, creditMutation{Operation: "grant", Type: "registration_bonus", UserID: uid, SourceType: "bonus", SourceRef: "registration_bonus:" + uid, Amount: amount, Reason: "新用户注册奖励"})
	if e != nil {
		return nil, e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return nil, e
	}
	return map[string]any{"success": true, "alreadyGranted": result.Replayed, "granted": !result.Replayed, "balance": result.Balance}, nil
}
func (b *backend) handleRegistrationBonus(w http.ResponseWriter, r *http.Request) error {
	s, e := b.requireSession(r)
	if e != nil {
		return e
	}
	result, e := b.grantRegistrationBonus(r, s.User.ID)
	if e != nil {
		return e
	}
	writeJSON(w, 200, result)
	return nil
}

// Expiry shares the wallet-before-batch lock order used by live billing. Each
// account commits independently so the scheduler never holds a global lock.
func (b *backend) processExpiredCredits(ctx context.Context) (usersProcessed, batchesExpired int, err error) {
	rows, err := b.db.Query(ctx, `SELECT DISTINCT user_id FROM credits_batch WHERE status='active' AND expires_at<=now() AND remaining>0 ORDER BY user_id`)
	if err != nil {
		return 0, 0, err
	}
	var users []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return 0, 0, err
		}
		users = append(users, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return 0, 0, err
	}
	for _, uid := range users {
		count, e := b.processUserExpiredCredits(ctx, uid)
		if e != nil {
			return usersProcessed, batchesExpired, e
		}
		if count > 0 {
			usersProcessed++
			batchesExpired += count
		}
	}
	return usersProcessed, batchesExpired, nil
}
func (b *backend) processUserExpiredCredits(ctx context.Context, uid string) (int, error) {
	tx, err := b.db.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer rollback(tx)
	if _, err = tx.Exec(ctx, `INSERT INTO credits_balance(id,user_id) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING`, newRequestID(), uid); err != nil {
		return 0, err
	}
	if _, err = tx.Exec(ctx, `SELECT id FROM credits_balance WHERE user_id=$1 FOR UPDATE`, uid); err != nil {
		return 0, err
	}
	count, err := b.expireUserCreditsTx(ctx, tx, uid)
	if err != nil {
		return 0, err
	}
	if err = tx.Commit(ctx); err != nil {
		return 0, err
	}
	return count, nil
}

func (b *backend) repairRegistrationBonusExpiry(r *http.Request, uid string) error {
	tx, err := b.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer rollback(tx)
	if _, err = b.lockCreditWallet(r, tx, uid); err != nil {
		return err
	}
	if err = b.repairRegistrationBonusExpiryTx(r, tx, uid); err != nil {
		return err
	}
	return tx.Commit(r.Context())
}
func (b *backend) repairRegistrationBonusExpiryTx(r *http.Request, tx pgx.Tx, uid string) error {
	raw, err := b.setting(r.Context(), "FREE_CREDITS_EXPIRY_DAYS", 7)
	if err != nil {
		return err
	}
	days := imageCreditValue(raw, 7)
	if days <= 0 || math.IsNaN(days) || math.IsInf(days, 0) || days > 36500 {
		return invalid("积分有效期配置无效")
	}
	if _, err = tx.Exec(r.Context(), `UPDATE credits_batch SET expires_at=issued_at+($2*interval '1 day'),updated_at=now() WHERE user_id=$1 AND source_type='bonus' AND status='active' AND (source_ref='registration_bonus:'||$1 OR source_ref IS NULL) AND (expires_at IS NULL OR expires_at>issued_at+($2*interval '1 day'))`, uid, days); err != nil {
		return err
	}
	_, err = b.expireUserCreditsTx(r.Context(), tx, uid)
	return err
}
