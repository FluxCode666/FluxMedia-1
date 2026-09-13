package main

// Durable payment fulfilment lives in the Go process.  Webhook handlers only
// authenticate and validate provider payloads; this file owns the shared
// payment_order -> work item -> credits ledger state machine used by both the
// synchronous webhook path and the recovery job.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	paymentFulfillmentLease    = 5 * time.Minute
	paymentFulfillmentMaxRetry = 30 * time.Minute
	paymentFulfillmentBatch    = 25
)

type paymentFulfillmentItem struct {
	ID, PaymentOrderID, UserID, Provider, ProviderTradeNo string
	CreditSourceRef, DebitAccount, Description            string
	CreditsAmount                                         float64
	CreditsExpiresAt                                      *time.Time
	Metadata                                              map[string]any
	LeaseToken                                            string
	AttemptCount                                          int
}

type paymentFulfillmentStats struct {
	ExpiredEventCount int `json:"expiredEventCount"`
	ClaimedCount      int `json:"claimedCount"`
	SucceededCount    int `json:"succeededCount"`
	RetryCount        int `json:"retryCount"`
	FailedCount       int `json:"failedCount"`
	SupersededCount   int `json:"supersededCount"`
}

func paymentRetryDelay(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	exponent := attempt - 1
	if exponent > 16 {
		exponent = 16
	}
	d := 30 * time.Second * time.Duration(1<<exponent)
	if d > paymentFulfillmentMaxRetry {
		return paymentFulfillmentMaxRetry
	}
	return d
}

func paymentProviderName(provider string) string {
	if provider == "alipay_f2f" {
		return "alipay"
	}
	return provider
}

// confirmPaymentWorkItem is the Go equivalent of
// confirmPaymentAndCreateFulfillmentWorkItem.  All provider callbacks enter
// here after signature and amount checks, and every frozen value is copied into
// the work item so recovery never rereads mutable pricing configuration.
func (b *backend) confirmPaymentWorkItem(ctx context.Context, orderID, provider, userID, tradeNo, eventRef, sourceRef string, metadata map[string]any) (string, error) {
	if orderID == "" || provider == "" || userID == "" || tradeNo == "" || sourceRef == "" {
		return "", invalid("支付确认字段不完整")
	}
	tx, err := b.db.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer rollback(tx)
	var uid, purpose, status, currency, pricingRaw string
	var credits float64
	var expiresAt *time.Time
	err = tx.QueryRow(ctx, `SELECT user_id,purpose,status,currency,credits_amount,pricing_snapshot::text FROM payment_order WHERE id=$1 AND provider=$2 FOR UPDATE`, orderID, provider).Scan(&uid, &purpose, &status, &currency, &credits, &pricingRaw)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", &apiError{404, "NOT_FOUND", "支付订单不存在"}
	}
	if err != nil {
		return "", err
	}
	if uid != userID || (provider == "alipay_f2f" && purpose != "credit_top_up") || provider != "alipay_f2f" && purpose != "credit_package" {
		return "", &apiError{400, "PAYMENT_ORDER_MISMATCH", "支付确认与订单归属或用途不匹配"}
	}
	var snapshot map[string]any
	if err := json.Unmarshal([]byte(pricingRaw), &snapshot); err != nil {
		return "", fmt.Errorf("decode payment pricing snapshot: %w", err)
	}
	if v, ok := snapshot["creditsExpiresAt"].(string); ok && v != "" {
		if parsed, parseErr := time.Parse(time.RFC3339Nano, v); parseErr == nil {
			expiresAt = &parsed
		}
	}
	if existing := strings.TrimSpace(status); existing == "fulfilled" {
		if _, err := tx.Exec(ctx, `UPDATE payment_order SET provider_trade_no=COALESCE(provider_trade_no,$2) WHERE id=$1 AND (provider_trade_no IS NULL OR provider_trade_no=$2)`, orderID, tradeNo); err != nil {
			return "", err
		}
		if err := tx.Commit(ctx); err != nil {
			return "", err
		}
		return "", nil
	}
	var existingTrade *string
	if err := tx.QueryRow(ctx, `SELECT provider_trade_no FROM payment_order WHERE id=$1`, orderID).Scan(&existingTrade); err != nil {
		return "", err
	}
	if existingTrade != nil && *existingTrade != tradeNo {
		return "", &apiError{400, "PAYMENT_TRADE_MISMATCH", "渠道交易号与本地订单不匹配"}
	}
	if credits <= 0 || !isFinitePaymentNumber(credits) {
		return "", &apiError{400, "INVALID_PAYMENT_ORDER", "支付订单积分快照无效"}
	}
	debitAccount := "PAYMENT:" + tradeNo
	description := fmt.Sprintf("%s credit pack purchase: %v credits", provider, credits)
	if provider == "alipay_f2f" {
		debitAccount = "ALIPAY:" + tradeNo
		description = fmt.Sprintf("Alipay credit top-up: %v credits", credits)
	}
	if _, err := tx.Exec(ctx, `UPDATE payment_order SET status='fulfilling',provider_trade_no=$2,updated_at=now() WHERE id=$1 AND (status IN ('creating','pending','fulfilling') OR status='failed') AND (provider_trade_no IS NULL OR provider_trade_no=$2)`, orderID, tradeNo); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO payment_lifecycle_event(id,payment_order_id,event_type,source_ref,occurred_at,recorded_at,timestamp_source,provider) VALUES($1,$2,'payment_confirmed',$3,now(),now(),'server_received',$4) ON CONFLICT(payment_order_id,event_type,source_ref) DO NOTHING`, stablePaymentEventID(orderID, "payment_confirmed", eventRef), orderID, eventRef, provider); err != nil {
		return "", err
	}
	if metadata == nil {
		metadata = map[string]any{}
	}
	metadata["provider"] = provider
	metadata["paymentOrderId"] = orderID
	metadataRaw, _ := json.Marshal(metadata)
	workID := newRequestID()
	workResult, err := tx.Exec(ctx, `INSERT INTO payment_fulfillment_work_item(id,payment_order_id,user_id,provider,provider_trade_no,credit_source_ref,credits_amount,credits_expires_at,debit_account,description,metadata,status,next_attempt_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',now(),now(),now()) ON CONFLICT(payment_order_id) DO NOTHING`, workID, orderID, uid, provider, tradeNo, sourceRef, credits, expiresAt, debitAccount, description, metadataRaw)
	if err != nil {
		return "", err
	}
	if workResult.RowsAffected() == 0 {
		if err := tx.QueryRow(ctx, `SELECT id FROM payment_fulfillment_work_item WHERE payment_order_id=$1 AND user_id=$2 AND provider=$3 AND provider_trade_no=$4 AND credit_source_ref=$5 AND credits_amount=$6`, orderID, uid, provider, tradeNo, sourceRef, credits).Scan(&workID); err != nil {
			return "", fmt.Errorf("payment fulfilment replay mismatch: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return workID, nil
}

func isFinitePaymentNumber(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }

func stablePaymentEventID(orderID, eventType, sourceRef string) string {
	sum := sha256.Sum256([]byte(orderID + ":" + eventType + ":" + sourceRef))
	return hex.EncodeToString(sum[:])[:32]
}

func (b *backend) claimPaymentFulfillment(ctx context.Context, orderID string) (*paymentFulfillmentItem, error) {
	now := time.Now().UTC()
	lease := newRequestID()
	tx, err := b.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer rollback(tx)
	query := `WITH candidate AS (SELECT id FROM payment_fulfillment_work_item WHERE ((status IN ('pending','retry') AND next_attempt_at <= $1) OR (status='processing' AND lease_expires_at <= $1))` + func() string {
		if orderID != "" {
			return ` AND payment_order_id=$2`
		}
		return ""
	}() + ` ORDER BY next_attempt_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE payment_fulfillment_work_item w SET status='processing',attempt_count=w.attempt_count+1,lease_token=$` + func() string {
		if orderID != "" {
			return "3"
		}
		return "2"
	}() + `,lease_expires_at=$1 + interval '5 minutes',updated_at=$1 FROM candidate WHERE w.id=candidate.id RETURNING w.id,w.payment_order_id,w.user_id,w.provider,w.provider_trade_no,w.credit_source_ref,w.credits_amount,w.credits_expires_at,w.debit_account,w.description,w.metadata,w.attempt_count`
	args := []any{now}
	if orderID != "" {
		args = append(args, orderID)
	}
	args = append(args, lease)
	var item paymentFulfillmentItem
	var metadataRaw []byte
	err = tx.QueryRow(ctx, query, args...).Scan(&item.ID, &item.PaymentOrderID, &item.UserID, &item.Provider, &item.ProviderTradeNo, &item.CreditSourceRef, &item.CreditsAmount, &item.CreditsExpiresAt, &item.DebitAccount, &item.Description, &metadataRaw, &item.AttemptCount)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(metadataRaw, &item.Metadata); err != nil {
		return nil, fmt.Errorf("decode payment fulfilment metadata: %w", err)
	}
	item.LeaseToken = lease
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &item, nil
}

func (b *backend) renewPaymentFulfillment(ctx context.Context, item *paymentFulfillmentItem) bool {
	command, err := b.db.Exec(ctx, `UPDATE payment_fulfillment_work_item SET lease_expires_at=now()+interval '5 minutes',updated_at=now() WHERE id=$1 AND status='processing' AND lease_token=$2 AND lease_expires_at>now()`, item.ID, item.LeaseToken)
	return err == nil && command.RowsAffected() == 1
}

func (b *backend) grantPaymentCredits(ctx context.Context, item *paymentFulfillmentItem) (string, error) {
	tx, err := b.db.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer rollback(tx)
	var batchID string
	var batchUser string
	var batchAmount float64
	err = tx.QueryRow(ctx, `SELECT id,user_id,amount FROM credits_batch WHERE source_type='purchase' AND source_ref=$1`, item.CreditSourceRef).Scan(&batchID, &batchUser, &batchAmount)
	if errors.Is(err, pgx.ErrNoRows) {
		batchID = newRequestID()
		result, insertErr := tx.Exec(ctx, `INSERT INTO credits_batch(id,user_id,amount,remaining,source_type,source_ref,expires_at,updated_at) VALUES($1,$2,$3,$3,'purchase',$4,$5,now()) ON CONFLICT(source_type,source_ref) DO NOTHING`, batchID, item.UserID, item.CreditsAmount, item.CreditSourceRef, item.CreditsExpiresAt)
		if insertErr != nil {
			return "", insertErr
		}
		if result.RowsAffected() == 0 {
			if err := tx.QueryRow(ctx, `SELECT id,user_id,amount FROM credits_batch WHERE source_type='purchase' AND source_ref=$1`, item.CreditSourceRef).Scan(&batchID, &batchUser, &batchAmount); err != nil {
				return "", err
			}
		} else {
			batchUser, batchAmount = item.UserID, item.CreditsAmount
			raw, _ := json.Marshal(item.Metadata)
			if _, err := tx.Exec(ctx, `INSERT INTO credits_transaction(id,user_id,type,amount,debit_account,credit_account,description,source_ref,metadata) VALUES($1,$2,'purchase',$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`, newRequestID(), item.UserID, item.CreditsAmount, item.DebitAccount, "WALLET:"+item.UserID, item.Description, item.CreditSourceRef, raw); err != nil {
				return "", err
			}
			if _, err := tx.Exec(ctx, `INSERT INTO credits_balance(id,user_id,balance,total_earned) VALUES($1,$2,$3,$3) ON CONFLICT(user_id) DO UPDATE SET balance=credits_balance.balance+EXCLUDED.balance,total_earned=credits_balance.total_earned+EXCLUDED.total_earned,updated_at=now()`, newRequestID(), item.UserID, item.CreditsAmount); err != nil {
				return "", err
			}
		}
	} else if err != nil {
		return "", err
	}
	if batchUser != item.UserID || math.Abs(batchAmount-item.CreditsAmount) > 0.000001 {
		return "", &apiError{409, "PAYMENT_FULFILLMENT_MISMATCH", "积分批次与支付订单不匹配"}
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return batchID, nil
}

func (b *backend) completePaymentFulfillment(ctx context.Context, item *paymentFulfillmentItem, batchID string) (bool, error) {
	tx, err := b.db.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer rollback(tx)
	result, err := tx.Exec(ctx, `UPDATE payment_fulfillment_work_item SET status='succeeded',credits_batch_id=$3,completed_at=now(),lease_token=NULL,lease_expires_at=NULL,last_error_code=NULL,updated_at=now() WHERE id=$1 AND status='processing' AND lease_token=$2`, item.ID, item.LeaseToken, batchID)
	if err != nil || result.RowsAffected() == 0 {
		return false, err
	}
	result, err = tx.Exec(ctx, `UPDATE payment_order SET status='fulfilled',provider_trade_no=$2,fulfilled_at=now(),updated_at=now() WHERE id=$1 AND status='fulfilling' AND provider_trade_no=$2`, item.PaymentOrderID, item.ProviderTradeNo)
	if err != nil {
		return false, err
	}
	if result.RowsAffected() != 1 {
		return false, &apiError{409, "PAYMENT_FULFILLMENT_STATE_CHANGED", "支付订单履约状态已变化"}
	}
	if item.Provider == "epay" {
		_, err = tx.Exec(ctx, `UPDATE epay_order SET status='success',updated_at=now() WHERE out_trade_no=$1`, strings.TrimPrefix(item.CreditSourceRef, "epay:"))
		if err != nil {
			return false, err
		}
	}
	if _, err = tx.Exec(ctx, `INSERT INTO payment_lifecycle_event(id,payment_order_id,event_type,source_ref,occurred_at,recorded_at,timestamp_source,provider) VALUES($1,$2,'fulfillment_succeeded',$3,now(),now(),'server_received',$4) ON CONFLICT(payment_order_id,event_type,source_ref) DO NOTHING`, stablePaymentEventID(item.PaymentOrderID, "fulfillment_succeeded", "work:"+item.ID), item.PaymentOrderID, "work:"+item.ID, item.Provider); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return true, nil
}

func (b *backend) finishPaymentFulfillment(ctx context.Context, item *paymentFulfillmentItem, batchID string, processErr error) (string, error) {
	if processErr == nil {
		completed, err := b.completePaymentFulfillment(ctx, item, batchID)
		if err != nil {
			processErr = err
		} else if completed {
			return "succeeded", nil
		} else {
			return "superseded", nil
		}
	}
	code := "fulfillment_attempt_failed"
	if strings.Contains(processErr.Error(), "mismatch") || strings.Contains(processErr.Error(), "不匹配") {
		code = "credits_batch_mismatch"
	}
	if code == "credits_batch_mismatch" {
		result, err := b.db.Exec(ctx, `UPDATE payment_fulfillment_work_item SET status='failed',lease_token=NULL,lease_expires_at=NULL,last_error_code=$3,completed_at=now(),updated_at=now() WHERE id=$1 AND status='processing' AND lease_token=$2`, item.ID, item.LeaseToken, code)
		if err != nil {
			return "", err
		}
		if result.RowsAffected() == 0 {
			return "superseded", nil
		}
		_, _ = b.db.Exec(ctx, `UPDATE payment_order SET status='failed',updated_at=now() WHERE id=$1 AND status='fulfilling'`, item.PaymentOrderID)
		_, _ = b.db.Exec(ctx, `INSERT INTO payment_lifecycle_event(id,payment_order_id,event_type,source_ref,occurred_at,recorded_at,timestamp_source,provider) VALUES($1,$2,'fulfillment_failed_terminal',$3,now(),now(),'server_received',$4) ON CONFLICT(payment_order_id,event_type,source_ref) DO NOTHING`, stablePaymentEventID(item.PaymentOrderID, "fulfillment_failed_terminal", "work:"+item.ID+":terminal"), item.PaymentOrderID, "work:"+item.ID+":terminal", item.Provider)
		return "failed_terminal", nil
	}
	next := time.Now().UTC().Add(paymentRetryDelay(item.AttemptCount))
	result, err := b.db.Exec(ctx, `UPDATE payment_fulfillment_work_item SET status='retry',next_attempt_at=$3,lease_token=NULL,lease_expires_at=NULL,last_error_code=$4,updated_at=now() WHERE id=$1 AND status='processing' AND lease_token=$2`, item.ID, item.LeaseToken, next, code)
	if err != nil {
		return "", err
	}
	if result.RowsAffected() == 0 {
		return "superseded", nil
	}
	return "retry_scheduled", nil
}

func (b *backend) processPaymentFulfillmentItem(ctx context.Context, item *paymentFulfillmentItem) (string, error) {
	if !b.renewPaymentFulfillment(ctx, item) {
		return "superseded", nil
	}
	batchID, grantErr := b.grantPaymentCredits(ctx, item)
	if grantErr == nil {
		if !b.renewPaymentFulfillment(ctx, item) {
			return "superseded", nil
		}
		// Referral rewards are deliberately best-effort from the provider's point
		// of view: any DB/setting outage returns retry and never loses the work item.
		grantErr = b.fulfillReferralFirstPayment(ctx, item)
	}
	return b.finishPaymentFulfillment(ctx, item, batchID, grantErr)
}

func (b *backend) recoverPaymentFulfillments(ctx context.Context, limit int) (paymentFulfillmentStats, error) {
	if limit < 1 || limit > 100 {
		limit = paymentFulfillmentBatch
	}
	var stats paymentFulfillmentStats
	if err := b.recordExpiredPaymentEvents(ctx); err != nil {
		return stats, err
	}
	for i := 0; i < limit; i++ {
		item, err := b.claimPaymentFulfillment(ctx, "")
		if err != nil {
			return stats, err
		}
		if item == nil {
			break
		}
		stats.ClaimedCount++
		status, processErr := b.processPaymentFulfillmentItem(ctx, item)
		if processErr != nil {
			return stats, processErr
		}
		switch status {
		case "succeeded":
			stats.SucceededCount++
		case "retry_scheduled":
			stats.RetryCount++
		case "failed_terminal":
			stats.FailedCount++
		default:
			stats.SupersededCount++
		}
	}
	return stats, nil
}

func (b *backend) processPaymentOrder(ctx context.Context, orderID string) (string, error) {
	item, err := b.claimPaymentFulfillment(ctx, orderID)
	if err != nil || item == nil {
		return "superseded", err
	}
	return b.processPaymentFulfillmentItem(ctx, item)
}

func (b *backend) recordExpiredPaymentEvents(ctx context.Context) error {
	_, err := b.db.Exec(ctx, `WITH candidates AS (SELECT id,provider,expires_at FROM payment_order WHERE provider IN ('alipay_f2f','creem','epay') AND purpose IN ('credit_top_up','credit_package') AND status IN ('creating','pending') AND expires_at<=now() AND NOT EXISTS (SELECT 1 FROM payment_lifecycle_event e WHERE e.payment_order_id=payment_order.id AND e.event_type='expired') ORDER BY expires_at,id FOR UPDATE SKIP LOCKED LIMIT 100) INSERT INTO payment_lifecycle_event(id,payment_order_id,event_type,source_ref,occurred_at,recorded_at,timestamp_source,provider) SELECT md5('expired:'||id),id,'expired','expiry:'||id,expires_at,now(),'server_generated',provider FROM candidates ON CONFLICT(payment_order_id,event_type,source_ref) DO NOTHING`)
	return err
}

func (b *backend) fulfillReferralFirstPayment(ctx context.Context, item *paymentFulfillmentItem) error {
	var relationshipID, inviterID, status string
	var inviteeID string
	var firstOrder *string
	var snapshotRaw []byte
	err := b.db.QueryRow(ctx, `SELECT id,inviter_user_id,invitee_user_id,status,first_payment_order_id,reward_config_snapshot FROM referral_relationship WHERE invitee_user_id=$1`, item.UserID).Scan(&relationshipID, &inviterID, &inviteeID, &status, &firstOrder, &snapshotRaw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if firstOrder != nil && *firstOrder != item.PaymentOrderID {
		return nil
	}
	config := map[string]any{"enabled": false, "inviter": map[string]any{"mode": "percentage", "value": 10.0}, "invitee": map[string]any{"mode": "percentage", "value": 10.0}}
	if firstOrder != nil && len(snapshotRaw) > 0 {
		_ = json.Unmarshal(snapshotRaw, &config)
	} else if value, loadErr := b.setting(ctx, "REFERRAL_REWARD_CONFIG", config); loadErr == nil {
		if candidate, ok := value.(map[string]any); ok {
			config = candidate
		}
	}
	if enabled, _ := config["enabled"].(bool); !enabled {
		_, err = b.db.Exec(ctx, `UPDATE referral_relationship SET first_payment_order_id=$2,status='skipped',reward_config_snapshot=$3,updated_at=now() WHERE id=$1 AND first_payment_order_id IS NULL`, relationshipID, item.PaymentOrderID, paymentMustJSON(config))
		return err
	}
	if firstOrder == nil {
		result, claimErr := b.db.Exec(ctx, `UPDATE referral_relationship SET first_payment_order_id=$2,reward_config_snapshot=$3,updated_at=now() WHERE id=$1 AND first_payment_order_id IS NULL`, relationshipID, item.PaymentOrderID, paymentMustJSON(config))
		if claimErr != nil {
			return claimErr
		}
		if result.RowsAffected() == 0 {
			return nil
		}
	}
	inviterReward := referralRewardAmount(config["inviter"], item.CreditsAmount)
	inviteeReward := referralRewardAmount(config["invitee"], item.CreditsAmount)
	for _, reward := range []struct {
		user, role string
		amount     float64
	}{{inviterID, "inviter", inviterReward}, {inviteeID, "invitee", inviteeReward}} {
		if reward.amount <= 0 {
			continue
		}
		source := "referral:first_payment:" + item.PaymentOrderID + ":" + reward.role
		tx, txErr := b.db.Begin(ctx)
		if txErr != nil {
			return txErr
		}
		result, txErr := tx.Exec(ctx, `INSERT INTO credits_batch(id,user_id,amount,remaining,source_type,source_ref,updated_at) VALUES($1,$2,$3,$3,'referral',$4,now()) ON CONFLICT(source_type,source_ref) DO NOTHING`, newRequestID(), reward.user, reward.amount, source)
		if txErr == nil && result.RowsAffected() > 0 {
			meta := paymentMustJSON(map[string]any{"role": reward.role, "orderId": item.PaymentOrderID, "provider": paymentProviderName(item.Provider)})
			_, txErr = tx.Exec(ctx, `INSERT INTO credits_transaction(id,user_id,type,amount,debit_account,credit_account,description,source_ref,metadata) VALUES($1,$2,'referral_reward',$3,'SYSTEM:referral_reward','WALLET:'||$2,$4,$5,$6) ON CONFLICT DO NOTHING`, newRequestID(), reward.user, reward.amount, "推广首充奖励（"+reward.role+"）", source, meta)
		}
		if txErr == nil && result.RowsAffected() > 0 {
			_, txErr = tx.Exec(ctx, `INSERT INTO credits_balance(id,user_id,balance,total_earned) VALUES($1,$2,$3,$3) ON CONFLICT(user_id) DO UPDATE SET balance=credits_balance.balance+EXCLUDED.balance,total_earned=credits_balance.total_earned+EXCLUDED.total_earned,updated_at=now()`, newRequestID(), reward.user, reward.amount)
		}
		if txErr == nil {
			txErr = tx.Commit(ctx)
		}
		if txErr != nil {
			rollback(tx)
			return txErr
		}
	}
	_, err = b.db.Exec(ctx, `UPDATE referral_relationship SET status='rewarded',inviter_reward_credits=$2,invitee_reward_credits=$3,rewarded_at=COALESCE(rewarded_at,now()),updated_at=now() WHERE id=$1 AND first_payment_order_id=$4`, relationshipID, inviterReward, inviteeReward, item.PaymentOrderID)
	return err
}

// validateCreemWebhookAmount mirrors the web amount gate. Creem reports the
// provider amount in minor units while payment_order stores the frozen amount
// in minor units too. Missing or non-comparable provider fields retain the
// historical soft-gate behavior unless the explicit enforcement flag is set.
func (b *backend) validateCreemWebhookAmount(ctx context.Context, orderID string, actual float64, currency string) error {
	var expected int64
	var expectedCurrency string
	if err := b.db.QueryRow(ctx, `SELECT amount_minor,currency FROM payment_order WHERE id=$1 AND provider='creem'`, orderID).Scan(&expected, &expectedCurrency); err != nil {
		return err
	}
	actualMinor := int64(math.Round(actual))
	comparable := isFinitePaymentNumber(actual) && actual >= 0 && strings.TrimSpace(currency) != "" && strings.EqualFold(strings.TrimSpace(currency), strings.TrimSpace(expectedCurrency))
	matches := comparable && actualMinor >= expected && actualMinor <= expected+10
	enforced := false
	if raw := strings.TrimSpace(strings.ToLower(getenvValue("CREEM_WEBHOOK_ENFORCE_AMOUNT"))); raw == "1" || raw == "true" || raw == "yes" || raw == "on" {
		enforced = true
	}
	if comparable && !matches && enforced {
		_, _ = b.db.Exec(ctx, `UPDATE payment_order SET status='failed',provider_trade_no=COALESCE(provider_trade_no,$2),updated_at=now() WHERE id=$1 AND provider='creem' AND status IN ('creating','pending','fulfilling','failed')`, orderID, fmt.Sprintf("creem-amount-mismatch:%d", actualMinor))
		_, _ = b.db.Exec(ctx, `INSERT INTO payment_lifecycle_event(id,payment_order_id,event_type,source_ref,occurred_at,recorded_at,timestamp_source,provider) VALUES($1,$2,'fulfillment_failed_terminal','provider_amount_mismatch',now(),now(),'provider','creem') ON CONFLICT(payment_order_id,event_type,source_ref) DO NOTHING`, stablePaymentEventID(orderID, "fulfillment_failed_terminal", "provider_amount_mismatch"), orderID)
		return &apiError{400, "PAYMENT_AMOUNT_MISMATCH", "Creem 支付金额或币种不匹配"}
	}
	return nil
}

func getenvValue(key string) string {
	// Kept as a tiny indirection to make amount-gate behavior easy to exercise
	// in Go tests without coupling the payment state machine to os.LookupEnv.
	return strings.TrimSpace(os.Getenv(key))
}

func referralRewardAmount(side any, credits float64) float64 {
	obj, _ := side.(map[string]any)
	mode, _ := obj["mode"].(string)
	value, _ := obj["value"].(float64)
	if value <= 0 || !isFinitePaymentNumber(value) || credits <= 0 {
		return 0
	}
	amount := value
	if mode != "fixed" {
		amount = credits * value / 100
	}
	amount = math.Floor((amount+1e-9)*100) / 100
	if amount > 1_000_000 {
		amount = 1_000_000
	}
	return amount
}

func paymentMustJSON(value any) []byte {
	raw, _ := json.Marshal(value)
	return raw
}

func (b *backend) handlePaymentFulfillmentRecovery(w http.ResponseWriter, r *http.Request) error {
	if !b.cronAuthorized(r) {
		return unauthorized()
	}
	stats, err := b.recoverPaymentFulfillments(r.Context(), paymentFulfillmentBatch)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, stats)
	return nil
}

func (b *backend) handleInternalPaymentEpay(w http.ResponseWriter, r *http.Request) error {
	if !b.cronAuthorized(r) {
		return unauthorized()
	}
	var input struct {
		Type        string `json:"type"`
		TradeNo     string `json:"tradeNo"`
		OutTradeNo  string `json:"outTradeNo"`
		Money       string `json:"money"`
		TradeStatus string `json:"tradeStatus"`
		Param       string `json:"param"`
	}
	if err := decodeBody(r, &input); err != nil {
		return err
	}
	if input.TradeStatus != "TRADE_SUCCESS" || input.TradeNo == "" || input.OutTradeNo == "" {
		return invalid("Epay 支付通知无效")
	}
	metadata := map[string]any{}
	var raw []byte
	if err := b.db.QueryRow(r.Context(), `SELECT metadata FROM epay_order WHERE out_trade_no=$1`, input.OutTradeNo).Scan(&raw); err == nil {
		_ = json.Unmarshal(raw, &metadata)
	}
	orderID, _ := metadata["paymentOrderId"].(string)
	if orderID == "" {
		orderID = input.OutTradeNo
	}
	userID := paymentStringValue(metadata["userId"])
	if userID == "" {
		if err := b.db.QueryRow(r.Context(), `SELECT user_id FROM payment_order WHERE id=$1`, orderID).Scan(&userID); err != nil {
			return &apiError{404, "NOT_FOUND", "支付订单不存在"}
		}
	}
	if err := b.validateEpayWebhook(r.Context(), orderID, input.OutTradeNo, input.TradeNo, input.Money, metadata); err != nil {
		return err
	}
	source := "epay:" + input.OutTradeNo
	if _, err := b.confirmPaymentWorkItem(r.Context(), orderID, "epay", userID, input.TradeNo, "epay:"+input.TradeNo, source, metadata); err != nil {
		return err
	}
	status, err := b.processPaymentOrder(r.Context(), orderID)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"metadataType": paymentStringValueDefault(metadata["type"], "credit_purchase"), "status": status})
	return nil
}

// validateEpayWebhook keeps the provider-specific checks that used to live in
// the Next service at the Go boundary. The signature proves origin; this check
// proves the notification belongs to the frozen local credit order.
func (b *backend) validateEpayWebhook(ctx context.Context, orderID, outTradeNo, tradeNo, money string, metadata map[string]any) error {
	var userID, purpose, provider string
	var credits float64
	var amountMinor int64
	var snapshotRaw []byte
	var existingTrade *string
	err := b.db.QueryRow(ctx, `SELECT user_id,purpose,provider,amount_minor,credits_amount,pricing_snapshot::text,provider_trade_no FROM payment_order WHERE id=$1`, orderID).Scan(&userID, &purpose, &provider, &amountMinor, &credits, &snapshotRaw, &existingTrade)
	if errors.Is(err, pgx.ErrNoRows) {
		return &apiError{404, "NOT_FOUND", "支付订单不存在"}
	}
	if err != nil {
		return err
	}
	if provider != "epay" || purpose != "credit_package" || orderID == "" || outTradeNo == "" || tradeNo == "" {
		return &apiError{400, "PAYMENT_ORDER_MISMATCH", "Epay 通知与本地订单不匹配"}
	}
	if existingTrade != nil && *existingTrade != tradeNo {
		return &apiError{400, "PAYMENT_TRADE_MISMATCH", "Epay 渠道交易号与本地订单不匹配"}
	}
	if paid := parseMinor(money); paid < 0 || paid < amountMinor || paid > amountMinor+10 {
		return &apiError{400, "PAYMENT_AMOUNT_MISMATCH", "Epay 支付金额不匹配"}
	}
	if v := paymentStringValue(metadata["userId"]); v != "" && v != userID {
		return &apiError{400, "PAYMENT_ORDER_MISMATCH", "Epay 通知用户与本地订单不匹配"}
	}
	var snapshot map[string]any
	if err := json.Unmarshal(snapshotRaw, &snapshot); err != nil {
		return &apiError{400, "INVALID_PAYMENT_ORDER", "支付订单冻结快照无效"}
	}
	if value, ok := snapshot["amountMinor"].(float64); ok && int64(value) != amountMinor {
		return &apiError{400, "INVALID_PAYMENT_ORDER", "支付订单冻结快照不一致"}
	}
	if value, ok := snapshot["creditsAmount"].(float64); ok && math.Abs(value-credits) > 0.000001 {
		return &apiError{400, "INVALID_PAYMENT_ORDER", "支付订单积分快照不一致"}
	}
	if rawOut := paymentStringValue(metadata["outTradeNo"]); rawOut != "" && rawOut != outTradeNo {
		return &apiError{400, "PAYMENT_ORDER_MISMATCH", "Epay 商户订单号不匹配"}
	}
	return nil
}

// handleInternalPaymentAlipay receives a provider payload that has already
// passed signature validation at the web boundary.  The CRON_SECRET gate keeps
// this normalization endpoint private while the durable work-item state
// machine remains shared with native webhook and recovery paths.
func (b *backend) handleInternalPaymentAlipay(w http.ResponseWriter, r *http.Request) error {
	if !b.cronAuthorized(r) {
		return unauthorized()
	}
	var input struct {
		OutTradeNo  string `json:"outTradeNo"`
		TradeNo     string `json:"tradeNo"`
		TradeStatus string `json:"tradeStatus"`
		TotalAmount string `json:"totalAmount"`
		AppID       string `json:"appId"`
		SellerID    string `json:"sellerId"`
		GMT         string `json:"gmtPayment"`
	}
	if err := decodeBody(r, &input); err != nil {
		return err
	}
	if input.TradeStatus != "TRADE_SUCCESS" && input.TradeStatus != "TRADE_FINISHED" {
		return invalid("支付宝交易未完成")
	}
	if input.OutTradeNo == "" || input.TradeNo == "" || input.TotalAmount == "" {
		return invalid("支付宝支付通知字段不完整")
	}
	var userID string
	var expected int64
	var provider string
	if err := b.db.QueryRow(r.Context(), `SELECT user_id,amount_minor,provider FROM payment_order WHERE id=$1`, input.OutTradeNo).Scan(&userID, &expected, &provider); err != nil || provider != "alipay_f2f" {
		return &apiError{404, "NOT_FOUND", "支付订单不存在"}
	}
	if paid := parseMinor(input.TotalAmount); paid < 0 || paid != expected {
		return &apiError{400, "PAYMENT_AMOUNT_MISMATCH", "支付金额不匹配"}
	}
	metadata := map[string]any{"provider": "alipay_f2f", "tradeNo": input.TradeNo, "appId": input.AppID, "sellerId": input.SellerID, "gmtPayment": input.GMT}
	if _, err := b.confirmPaymentWorkItem(r.Context(), input.OutTradeNo, "alipay_f2f", userID, input.TradeNo, "alipay:"+input.TradeNo, "alipay:"+input.OutTradeNo, metadata); err != nil {
		return err
	}
	status, err := b.processPaymentOrder(r.Context(), input.OutTradeNo)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": status, "processed": true})
	return nil
}

func (b *backend) handleInternalPaymentCreem(w http.ResponseWriter, r *http.Request) error {
	if !b.cronAuthorized(r) {
		return unauthorized()
	}
	var input struct {
		CheckoutID     string `json:"checkoutId"`
		RequestID      string `json:"requestId"`
		CustomerID     string `json:"customerId"`
		PaymentOrderID string `json:"paymentOrderId"`
		PackageID      string `json:"packageId"`
		UserID         string `json:"userId"`
		Order          *struct {
			ID        string  `json:"id"`
			Amount    float64 `json:"amount"`
			Currency  string  `json:"currency"`
			ProductID string  `json:"productId"`
		} `json:"order"`
		Product   map[string]any `json:"product"`
		CreatedAt int64          `json:"createdAt"`
		Metadata  map[string]any `json:"metadata"`
	}
	if err := decodeBody(r, &input); err != nil {
		return err
	}
	if input.PaymentOrderID == "" || input.Order == nil || input.Order.ID == "" {
		return invalid("Creem 支付通知缺少订单")
	}
	if input.UserID == "" {
		if err := b.db.QueryRow(r.Context(), `SELECT user_id FROM payment_order WHERE id=$1`, input.PaymentOrderID).Scan(&input.UserID); err != nil {
			return &apiError{404, "NOT_FOUND", "支付订单不存在"}
		}
	}
	metadata := input.Metadata
	if metadata == nil {
		metadata = map[string]any{}
	}
	metadata["checkoutId"] = input.CheckoutID
	metadata["customerId"] = input.CustomerID
	metadata["paymentOrderId"] = input.PaymentOrderID
	metadata["packageId"] = input.PackageID
	metadata["reportedPackageId"] = input.PackageID
	metadata["amount"] = input.Order.Amount
	metadata["currency"] = input.Order.Currency
	metadata["createdAt"] = input.CreatedAt
	if input.RequestID != "" {
		metadata["requestId"] = input.RequestID
	}
	if err := b.validateCreemWebhookAmount(r.Context(), input.PaymentOrderID, input.Order.Amount, input.Order.Currency); err != nil {
		return err
	}
	if _, err := b.confirmPaymentWorkItem(r.Context(), input.PaymentOrderID, "creem", input.UserID, input.Order.ID, "creem:"+input.Order.ID, "creem:"+input.PaymentOrderID, metadata); err != nil {
		return err
	}
	status, err := b.processPaymentOrder(r.Context(), input.PaymentOrderID)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"processed": true, "status": status})
	return nil
}

func paymentStringValue(v any) string { s, _ := v.(string); return s }
func paymentStringValueDefault(v any, fallback string) string {
	if s := paymentStringValue(v); s != "" {
		return s
	}
	return fallback
}
