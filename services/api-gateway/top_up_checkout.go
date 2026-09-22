package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type topUpCheckoutInput struct {
	ClientRequestID string `json:"clientRequestId"`
	Currency        string `json:"currency"`
	Provider        string `json:"provider"`
	AmountMinor     int64  `json:"amountMinor"`
}
type topUpCheckoutOrder struct {
	ID, UserID, Provider, Purpose, Status, Currency string
	AmountMinor                                     int64
	Amount, CreditsAmount                           float64
	ExpiresAt, FulfilledAt                          *time.Time
	CreatedAt, UpdatedAt                            time.Time
	Payload                                         map[string]any
	Snapshot                                        map[string]any
}
type topUpOrderStore interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func readTopUpCheckoutOrder(ctx context.Context, db topUpOrderStore, where string, args ...any) (topUpCheckoutOrder, error) {
	var o topUpCheckoutOrder
	var payload, snapshot []byte
	err := db.QueryRow(ctx, `SELECT id,user_id,provider,purpose,status,currency,amount_minor,amount,credits_amount,expires_at,fulfilled_at,created_at,updated_at,provider_payload,pricing_snapshot FROM payment_order WHERE `+where, args...).Scan(&o.ID, &o.UserID, &o.Provider, &o.Purpose, &o.Status, &o.Currency, &o.AmountMinor, &o.Amount, &o.CreditsAmount, &o.ExpiresAt, &o.FulfilledAt, &o.CreatedAt, &o.UpdatedAt, &payload, &snapshot)
	if err != nil {
		return o, err
	}
	if len(payload) > 0 && json.Unmarshal(payload, &o.Payload) != nil {
		return o, errors.New("invalid payment provider payload")
	}
	if json.Unmarshal(snapshot, &o.Snapshot) != nil {
		return o, errors.New("invalid payment pricing snapshot")
	}
	return o, nil
}
func (o topUpCheckoutOrder) view() map[string]any {
	var qr any
	if value := stringValue(o.Payload["qrCode"]); value != "" && (o.Status == "pending" || o.Status == "creating") && (o.ExpiresAt == nil || o.ExpiresAt.After(time.Now())) {
		qr = value
	}
	return map[string]any{"orderId": o.ID, "status": o.Status, "currency": o.Currency, "amount": o.Amount, "amountMinor": o.AmountMinor, "creditsAmount": o.CreditsAmount, "qrCode": qr, "expiresAt": o.ExpiresAt}
}
func topUpRequestMatches(o topUpCheckoutOrder, in topUpCheckoutInput) error {
	if o.Provider != in.Provider || o.Purpose != "credit_top_up" || o.Currency != in.Currency || o.AmountMinor != in.AmountMinor {
		return &apiError{409, "IDEMPOTENCY_CONFLICT", "该支付请求已用于另一笔充值"}
	}
	return nil
}
func recordTopUpEvent(ctx context.Context, tx pgx.Tx, o topUpCheckoutOrder, kind, ref string, occurred time.Time) error {
	_, err := tx.Exec(ctx, `INSERT INTO payment_lifecycle_event(id,payment_order_id,event_type,source_ref,occurred_at,recorded_at,timestamp_source,provider) VALUES($1,$2,$3,$4,$5,now(),'server_generated','alipay_f2f') ON CONFLICT(payment_order_id,event_type,source_ref) DO NOTHING`, stablePaymentEventID(o.ID, kind, ref), o.ID, kind, ref, occurred)
	return err
}
func (b *backend) handleTopUpCheckout(w http.ResponseWriter, r *http.Request) error {
	session, err := b.requireSession(r)
	if err != nil {
		return err
	}
	var in topUpCheckoutInput
	if err = decodeBody(r, &in); err != nil {
		return err
	}
	in.Currency = strings.ToUpper(strings.TrimSpace(in.Currency))
	in.ClientRequestID = strings.TrimSpace(in.ClientRequestID)
	if !uuidPattern.MatchString(in.ClientRequestID) || in.Provider != "alipay_f2f" || !topUpCurrencyPattern.MatchString(in.Currency) || in.AmountMinor <= 0 || in.AmountMinor > 1e12 {
		return invalid("充值参数无效")
	}
	order, err := b.createTopUpCheckout(r.Context(), session.User.ID, in)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, order.view())
	return nil
}
func (b *backend) createTopUpCheckout(ctx context.Context, user string, in topUpCheckoutInput) (topUpCheckoutOrder, error) {
	order, err := readTopUpCheckoutOrder(ctx, b.db, "user_id=$1 AND client_request_id=$2", user, in.ClientRequestID)
	if err == nil {
		return b.resumeTopUpCheckout(ctx, order, in)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return order, err
	}
	config, err := b.readTopUpConfig(ctx)
	if err != nil {
		return order, err
	}
	credits, rate, err := quoteTopUp(config, in.Currency, in.AmountMinor)
	if err != nil {
		return order, err
	}
	gateway, err := b.readAlipayCheckoutConfig(ctx)
	if err != nil {
		return order, err
	}
	expiryValue, err := b.setting(ctx, "CREDITS_EXPIRY_DAYS", 0)
	if err != nil {
		return order, err
	}
	days := imageCreditValue(expiryValue, 0)
	if math.IsNaN(days) || math.IsInf(days, 0) || days < 0 || days > 36500 {
		return order, invalid("购买积分有效期无效")
	}
	now := time.Now().UTC()
	expires := now.Add(time.Duration(gateway.TimeoutMinutes) * time.Minute)
	var creditsExpires *time.Time
	if days > 0 {
		value := now.Add(time.Duration(days * 24 * float64(time.Hour)))
		creditsExpires = &value
	}
	token := newRequestID()
	order = topUpCheckoutOrder{ID: fmt.Sprintf("AT%d%s", now.UnixMilli(), newRequestID()[:12]), UserID: user, Provider: "alipay_f2f", Purpose: "credit_top_up", Status: "creating", Currency: in.Currency, AmountMinor: in.AmountMinor, Amount: float64(in.AmountMinor) / 100, CreditsAmount: credits, ExpiresAt: &expires, CreatedAt: now, UpdatedAt: now, Payload: map[string]any{"checkoutLeaseToken": token, "merchantAppId": gateway.AppID}, Snapshot: map[string]any{"currency": in.Currency, "amountMinor": in.AmountMinor, "creditsAmount": credits, "creditsPerMajorUnit": rate, "creditsExpiresAt": creditsExpires, "provider": "alipay_f2f"}}
	tx, err := b.db.Begin(ctx)
	if err != nil {
		return order, err
	}
	defer rollback(tx)
	result, err := tx.Exec(ctx, `INSERT INTO payment_order(id,user_id,client_request_id,provider,purpose,status,currency,amount,amount_minor,credits_amount,pricing_snapshot,provider_payload,expires_at,created_at,updated_at) VALUES($1,$2,$3,'alipay_f2f','credit_top_up','creating',$4,$5,$6,$7,$8,$9,$10,$11,$11) ON CONFLICT(user_id,client_request_id) DO NOTHING`, order.ID, user, in.ClientRequestID, in.Currency, order.Amount, in.AmountMinor, credits, mustJSON(order.Snapshot), mustJSON(order.Payload), expires, now)
	if err != nil {
		return order, err
	}
	if result.RowsAffected() == 0 {
		order, err = readTopUpCheckoutOrder(ctx, tx, "user_id=$1 AND client_request_id=$2", user, in.ClientRequestID)
		if err != nil {
			return order, err
		}
		if err = tx.Commit(ctx); err != nil {
			return order, err
		}
		return b.resumeTopUpCheckout(ctx, order, in)
	}
	if err = recordTopUpEvent(ctx, tx, order, "order_created", "request:"+user+":"+in.ClientRequestID, now); err != nil {
		return order, err
	}
	if err = tx.Commit(ctx); err != nil {
		return order, err
	}
	return b.completeTopUpCheckout(ctx, order, gateway, token)
}
func (b *backend) resumeTopUpCheckout(ctx context.Context, order topUpCheckoutOrder, in topUpCheckoutInput) (topUpCheckoutOrder, error) {
	if err := topUpRequestMatches(order, in); err != nil {
		return order, err
	}
	switch order.Status {
	case "fulfilled", "fulfilling":
		return order, nil
	case "failed":
		return order, &apiError{409, "PAYMENT_CHECKOUT_FAILED", "该充值订单不可继续支付，请重新发起充值"}
	case "pending":
		if stringValue(order.Payload["qrCode"]) == "" {
			return order, &apiError{409, "PAYMENT_CHECKOUT_FAILED", "该充值订单缺少支付信息，请重新发起充值"}
		}
		return order, nil
	case "creating":
	default:
		return order, &apiError{409, "PAYMENT_ORDER_INVALID", "充值订单状态无效"}
	}
	if order.ExpiresAt != nil && !order.ExpiresAt.After(time.Now()) {
		return order, &apiError{409, "PAYMENT_ORDER_EXPIRED", "充值订单已过期，请重新发起充值"}
	}
	if order.UpdatedAt.After(time.Now().Add(-30 * time.Second)) {
		return order, nil
	}
	config, err := b.readAlipayCheckoutConfig(ctx)
	if err != nil {
		return order, err
	}
	if app := stringValue(order.Payload["merchantAppId"]); app != "" && app != config.AppID {
		return order, &apiError{409, "PAYMENT_CONFIG_CHANGED", "充值通道已变更，请重新发起充值"}
	}
	token := newRequestID()
	result, err := b.db.Exec(ctx, `UPDATE payment_order SET updated_at=now(),provider_payload=COALESCE(provider_payload::jsonb,'{}'::jsonb)||jsonb_build_object('checkoutLeaseToken',$2::text) WHERE id=$1 AND status='creating' AND updated_at<now()-interval '30 seconds' AND (expires_at IS NULL OR expires_at>now())`, order.ID, token)
	if err != nil {
		return order, err
	}
	if result.RowsAffected() == 0 {
		return readTopUpCheckoutOrder(ctx, b.db, "id=$1", order.ID)
	}
	return b.completeTopUpCheckout(ctx, order, config, token)
}
func (b *backend) completeTopUpCheckout(ctx context.Context, order topUpCheckoutOrder, config alipayCheckoutConfig, token string) (topUpCheckoutOrder, error) {
	if order.ExpiresAt == nil {
		expires := time.Now().UTC().Add(time.Duration(config.TimeoutMinutes) * time.Minute)
		order.ExpiresAt = &expires
	}
	qr, err := b.precreateAlipayOrder(ctx, config, order)
	if err != nil {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if _, saveErr := b.finishTopUpCheckout(cleanup, order, token, "", false); saveErr != nil {
			return order, saveErr
		}
		return order, err
	}
	return b.finishTopUpCheckout(ctx, order, token, qr, true)
}
func (b *backend) finishTopUpCheckout(ctx context.Context, order topUpCheckoutOrder, token, qr string, success bool) (topUpCheckoutOrder, error) {
	tx, err := b.db.Begin(ctx)
	if err != nil {
		return order, err
	}
	defer rollback(tx)
	status, event := "failed", "checkout_failed"
	if success {
		status, event = "pending", "checkout_ready"
	}
	payload := map[string]any{}
	for key, value := range order.Payload {
		if key != "checkoutLeaseToken" {
			payload[key] = value
		}
	}
	if success {
		payload["qrCode"] = qr
	}
	result, err := tx.Exec(ctx, `UPDATE payment_order SET status=$3,provider_payload=$4,expires_at=COALESCE(expires_at,$5::timestamptz),updated_at=now() WHERE id=$1 AND status='creating' AND provider_payload->>'checkoutLeaseToken'=$2`, order.ID, token, status, mustJSON(payload), order.ExpiresAt)
	if err != nil {
		return order, err
	}
	if result.RowsAffected() == 1 {
		if err = recordTopUpEvent(ctx, tx, order, event, "checkout:"+order.ID, time.Now().UTC()); err != nil {
			return order, err
		}
	}
	current, err := readTopUpCheckoutOrder(ctx, tx, "id=$1 AND user_id=$2", order.ID, order.UserID)
	if err != nil {
		return order, err
	}
	if err = tx.Commit(ctx); err != nil {
		return order, err
	}
	return current, nil
}
