package main

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type creditPackageCheckoutInput struct {
	PackageID       string `json:"packageId"`
	ClientRequestID string `json:"clientRequestId"`
	Locale          string `json:"locale"`
	Quantity        int    `json:"quantity"`
}

func (b *backend) handleCreditPackageCheckout(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireSession(r)
	if err != nil {
		return err
	}
	in := creditPackageCheckoutInput{Quantity: 1}
	if err = decodeBody(r, &in); err != nil {
		return err
	}
	if strings.TrimSpace(in.PackageID) == "" || len(in.PackageID) > 512 || !uuidPattern.MatchString(in.ClientRequestID) || (in.Locale != "en" && in.Locale != "zh") || in.Quantity < 1 || in.Quantity > 999 {
		return invalid("积分包结账参数无效")
	}
	out, err := b.createCreditPackageCheckout(r.Context(), s.User.ID, in)
	if err != nil {
		return err
	}
	noStore(w)
	writeJSON(w, http.StatusOK, out)
	return nil
}
func (b *backend) handleCreditPackageCheckoutMethod(w http.ResponseWriter, r *http.Request) error {
	w.Header().Set("Allow", http.MethodPost)
	return &apiError{405, "METHOD_NOT_ALLOWED", "积分包结账仅支持 POST 请求"}
}
func recordCreditPackageEvent(ctx context.Context, tx pgx.Tx, order topUpCheckoutOrder, kind, ref string, at time.Time) error {
	_, err := tx.Exec(ctx, `INSERT INTO payment_lifecycle_event(id,payment_order_id,event_type,source_ref,occurred_at,recorded_at,timestamp_source,provider) VALUES($1,$2,$3,$4,$5,now(),'server_generated',$6) ON CONFLICT(payment_order_id,event_type,source_ref) DO NOTHING`, stablePaymentEventID(order.ID, kind, ref), order.ID, kind, ref, at, order.Provider)
	return err
}
func (b *backend) createCreditPackageCheckout(ctx context.Context, user string, in creditPackageCheckoutInput) (map[string]any, error) {
	packages, err := b.creditPackages(ctx)
	if err != nil {
		return nil, err
	}
	var pkg *creditPackage
	for i := range packages {
		if packages[i].ID == in.PackageID && packages[i].Visible {
			pkg = &packages[i]
			break
		}
	}
	if pkg == nil {
		return nil, &apiError{400, "INVALID_PACKAGE", "无效的积分包"}
	}
	if !pkg.AllowQuantity && in.Quantity != 1 {
		return nil, &apiError{400, "QUANTITY_NOT_SUPPORTED", "该积分包不支持数量购买"}
	}
	if in.Quantity > pkg.MaxQuantity {
		return nil, &apiError{400, "QUANTITY_EXCEEDED", fmt.Sprintf("购买数量不能超过 %d", pkg.MaxQuantity)}
	}
	amount := pkg.Price * float64(in.Quantity)
	minor := math.Round(amount * math.Pow10(creditPackageCurrencyExponent(pkg.Currency)))
	credits := pkg.Credits * float64(in.Quantity)
	if minor <= 0 || minor > 9007199254740991 || !isFinitePaymentNumber(minor) || credits <= 0 || !isFinitePaymentNumber(credits) {
		return nil, &apiError{400, "INVALID_AMOUNT", "积分包金额无效"}
	}
	provider, err := b.creditPackageProvider(ctx)
	if err != nil {
		return nil, err
	}
	if provider == "none" {
		return nil, &apiError{503, "PAYMENT_DISABLED", "支付功能当前未启用"}
	}
	if provider == "alipay_f2f" {
		return nil, &apiError{503, "UNSUPPORTED_PROVIDER", "支付宝当面付仅支持按金额充值，请使用支付宝扫码充值"}
	}
	if provider == "epay" && pkg.Currency != "CNY" {
		return nil, &apiError{400, "PROVIDER_CURRENCY_UNSUPPORTED", "易支付当前仅支持人民币积分包"}
	}
	if provider == "creem" && in.Quantity > 1 {
		return nil, &apiError{400, "PROVIDER_QUANTITY_UNSUPPORTED", "当前支付通道暂不支持数量购买，请分次购买"}
	}
	gateway, err := b.readCreditPackageGateway(ctx, provider)
	if err != nil {
		return nil, err
	}
	value, e := b.setting(ctx, "CREDITS_EXPIRY_DAYS", 0)
	if e != nil {
		return nil, e
	}
	days := imageCreditValue(value, 0)
	if days < 0 || days > 36500 {
		return nil, invalid("购买积分有效期无效")
	}

	// One database session owns this user's idempotency key through the remote
	// checkout. A process crash releases the lock; Creem receives the same stable
	// request_id when the persisted creating order is recovered.
	conn, err := b.db.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Release()
	lock := "credit-package:" + user + ":" + in.ClientRequestID
	if _, err = conn.Exec(ctx, `SELECT pg_advisory_lock(hashtextextended($1,0))`, lock); err != nil {
		return nil, err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if _, e := conn.Exec(cleanup, `SELECT pg_advisory_unlock(hashtextextended($1,0))`, lock); e != nil {
			_ = conn.Conn().Close(cleanup)
		}
	}()
	order, err := readTopUpCheckoutOrder(ctx, conn, "user_id=$1 AND client_request_id=$2", user, in.ClientRequestID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if err == nil {
		if order.Provider != provider || order.Purpose != "credit_package" || order.Currency != pkg.Currency || order.AmountMinor != int64(minor) || order.CreditsAmount != credits || stringValue(order.Snapshot["packageId"]) != pkg.ID || int(imageCreditValue(order.Snapshot["quantity"], 0)) != in.Quantity {
			return nil, &apiError{409, "IDEMPOTENCY_CONFLICT", "该支付请求已用于另一份积分包"}
		}
	} else {
		now := time.Now().UTC()
		expiry := now.Add(30 * time.Minute)
		var creditsExpiry *time.Time
		if days > 0 {
			v := now.Add(time.Duration(days * 24 * float64(time.Hour)))
			creditsExpiry = &v
		}
		product := pkg.CreemProductID
		if product == "" {
			product = "credits_" + pkg.ID
		}
		order = topUpCheckoutOrder{ID: fmt.Sprintf("CP%d%s", now.UnixMilli(), newRequestID()[:12]), UserID: user, Provider: provider, Purpose: "credit_package", Status: "creating", Currency: pkg.Currency, Amount: amount, AmountMinor: int64(minor), CreditsAmount: credits, ExpiresAt: &expiry, CreatedAt: now, UpdatedAt: now, Payload: map[string]any{}, Snapshot: map[string]any{"packageId": pkg.ID, "quantity": in.Quantity, "currency": pkg.Currency, "amountMinor": int64(minor), "creditsAmount": credits, "creditsExpiresAt": creditsExpiry, "unitPrice": pkg.Price, "unitCredits": pkg.Credits, "creemProductId": product, "locale": in.Locale}}
		if provider == "epay" {
			order.Payload["outTradeNo"] = "CR" + order.ID
		}
		tx, e := conn.Begin(ctx)
		if e != nil {
			return nil, e
		}
		defer rollback(tx)
		inserted, e := tx.Exec(ctx, `INSERT INTO payment_order(id,user_id,client_request_id,provider,purpose,status,currency,amount,amount_minor,credits_amount,pricing_snapshot,provider_payload,expires_at,created_at,updated_at) VALUES($1,$2,$3,$4,'credit_package','creating',$5,$6,$7,$8,$9,$10,$11,$12,$12) ON CONFLICT(user_id,client_request_id) DO NOTHING`, order.ID, user, in.ClientRequestID, provider, order.Currency, order.Amount, order.AmountMinor, credits, mustJSON(order.Snapshot), mustJSON(order.Payload), expiry, now)
		if e != nil {
			return nil, e
		}
		if inserted.RowsAffected() != 1 {
			return nil, &apiError{409, "IDEMPOTENCY_CONFLICT", "该支付请求已用于另一份订单"}
		}
		if e = recordCreditPackageEvent(ctx, tx, order, "order_created", "request:"+user+":"+in.ClientRequestID, now); e != nil {
			return nil, e
		}
		if provider == "epay" {
			metadata := map[string]any{"type": "credit_purchase", "userId": user, "outTradeNo": order.Payload["outTradeNo"], "paymentOrderId": order.ID, "locale": in.Locale, "packageId": pkg.ID, "quantity": in.Quantity, "currency": order.Currency}
			if _, e = tx.Exec(ctx, `INSERT INTO epay_order(out_trade_no,user_id,business_type,amount,status,metadata) VALUES($1,$2,'credit_purchase',$3,'pending',$4)`, order.Payload["outTradeNo"], user, amount, mustJSON(metadata)); e != nil {
				return nil, e
			}
		}
		if e = tx.Commit(ctx); e != nil {
			return nil, e
		}
	}
	resultURL := gateway.BaseURL + "/" + in.Locale + "/dashboard/credits/payment/" + order.ID
	if order.Status == "fulfilled" || order.Status == "fulfilling" {
		return map[string]any{"url": resultURL, "orderId": order.ID}, nil
	}
	if order.Status == "failed" {
		return nil, &apiError{409, "PAYMENT_CHECKOUT_FAILED", "该积分包订单已失败，请重新发起购买"}
	}
	if order.ExpiresAt != nil && !order.ExpiresAt.After(time.Now()) {
		return nil, &apiError{409, "PAYMENT_ORDER_EXPIRED", "该积分包订单已过期，请重新发起购买"}
	}
	if checkout := stringValue(order.Payload["checkoutUrl"]); checkout != "" {
		out := map[string]any{"url": checkout, "orderId": order.ID}
		if provider == "epay" {
			params, ok := order.Payload["params"].(map[string]any)
			if !ok {
				return nil, errors.New("invalid stored Epay checkout")
			}
			out["params"] = params
			out["method"] = "POST"
		}
		return out, nil
	}
	if order.Status != "creating" && !(provider == "epay" && order.Status == "pending") {
		return nil, &apiError{409, "PAYMENT_CHECKOUT_FAILED", "积分包订单缺少结账信息，请重新发起购买"}
	}
	var payload map[string]any
	if provider == "epay" {
		if err = ensureCreditPackageEpayOrder(ctx, conn, order, in.Locale); err != nil {
			return nil, err
		}
		payload, err = buildCreditPackageEpayCheckout(gateway, order)
	} else {
		payload, err = b.createCreditPackageCreemCheckout(ctx, gateway, order, resultURL)
	}
	if err != nil {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if _, saveErr := b.finishCreditPackageCheckout(cleanup, conn, order, nil, false); saveErr != nil {
			return nil, saveErr
		}
		return nil, err
	}
	current, err := b.finishCreditPackageCheckout(ctx, conn, order, payload, true)
	if err != nil {
		return nil, err
	}
	if current.Status == "fulfilled" || current.Status == "fulfilling" {
		return map[string]any{"url": resultURL, "orderId": order.ID}, nil
	}
	if current.Status != "pending" {
		return nil, &apiError{409, "PAYMENT_CHECKOUT_FAILED", "积分包订单状态已变化"}
	}
	out := map[string]any{"url": stringValue(current.Payload["checkoutUrl"]), "orderId": current.ID}
	if provider == "epay" {
		out["params"] = current.Payload["params"]
		out["method"] = "POST"
	}
	return out, nil
}
func (b *backend) finishCreditPackageCheckout(ctx context.Context, conn *pgxpool.Conn, order topUpCheckoutOrder, payload map[string]any, success bool) (topUpCheckoutOrder, error) {
	tx, err := conn.Begin(ctx)
	if err != nil {
		return order, err
	}
	defer rollback(tx)
	status, kind := "failed", "checkout_failed"
	if success {
		status, kind = "pending", "checkout_ready"
	} else {
		payload = order.Payload
	}
	tag, err := tx.Exec(ctx, `UPDATE payment_order SET status=$2,provider_payload=$3,updated_at=now() WHERE id=$1 AND purpose='credit_package' AND (status='creating' OR ($4 AND status='pending' AND provider='epay'))`, order.ID, status, mustJSON(payload), success)
	if err != nil {
		return order, err
	}
	if tag.RowsAffected() == 1 && order.Status == "creating" {
		if err = recordCreditPackageEvent(ctx, tx, order, kind, "checkout:"+order.ID, time.Now().UTC()); err != nil {
			return order, err
		}
	}
	current, err := readTopUpCheckoutOrder(ctx, tx, "id=$1", order.ID)
	if err != nil {
		return order, err
	}
	if err = tx.Commit(ctx); err != nil {
		return order, err
	}
	return current, nil
}

// Legacy creating orders may predate the durable Epay reference write. Repair
// that reference before exposing any payable form, while preserving paid state.
func ensureCreditPackageEpayOrder(ctx context.Context, conn *pgxpool.Conn, order topUpCheckoutOrder, locale string) error {
	outTrade := stringValue(order.Payload["outTradeNo"])
	if outTrade == "" {
		outTrade = "CR" + order.ID
		if order.Payload == nil {
			order.Payload = map[string]any{}
		}
		order.Payload["outTradeNo"] = outTrade
	}
	metadata := map[string]any{"type": "credit_purchase", "userId": order.UserID, "outTradeNo": outTrade, "paymentOrderId": order.ID, "locale": locale, "packageId": order.Snapshot["packageId"], "quantity": order.Snapshot["quantity"], "currency": order.Currency}
	tag, err := conn.Exec(ctx, `INSERT INTO epay_order(out_trade_no,user_id,business_type,amount,status,metadata) VALUES($1,$2,'credit_purchase',$3,'pending',$4) ON CONFLICT(out_trade_no) DO UPDATE SET metadata=epay_order.metadata::jsonb||EXCLUDED.metadata::jsonb,updated_at=now() WHERE epay_order.user_id=EXCLUDED.user_id AND epay_order.business_type='credit_purchase' AND epay_order.amount=EXCLUDED.amount AND (epay_order.metadata->>'paymentOrderId' IS NULL OR epay_order.metadata->>'paymentOrderId'=EXCLUDED.metadata->>'paymentOrderId')`, outTrade, order.UserID, order.Amount, mustJSON(metadata))
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return &apiError{409, "IDEMPOTENCY_CONFLICT", "易支付商户订单归属不匹配"}
	}
	return nil
}
