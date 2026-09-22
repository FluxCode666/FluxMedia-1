package main

import (
	"errors"
	"github.com/jackc/pgx/v5"
	"net/http"
	"strconv"
	"strings"
	"time"
)

func (b *backend) registerPaymentRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/credits/payment-orders", b.endpoint(b.handleMyRecentPaymentOrders))
	mux.HandleFunc("POST /api/admin/payment/overview", b.endpoint(b.handleAdminPaymentOverview))
	mux.HandleFunc("POST /api/admin/payment/orders", b.endpoint(b.handleAdminPaymentOrders))
	mux.HandleFunc("POST /api/admin/payment/users/search", b.endpoint(b.handleAdminPaymentUsers))
	mux.HandleFunc("POST /api/credits/top-up/checkout", b.endpoint(b.handleTopUpCheckout))
	mux.HandleFunc("POST /api/credits/top-up/order-status", b.endpoint(b.handleTopUpOrderStatus))
	mux.HandleFunc("POST /api/credits/payment/status", b.endpoint(b.handleCreditPaymentStatus))
	// These endpoints are called by the server-side scheduler/UOL bindings with
	// CRON_SECRET. Public provider callbacks continue to enter through the
	// signature-verifying webhook routes in payments.go.
	mux.HandleFunc("POST /api/internal/payment-fulfillment/recover", b.endpoint(b.handlePaymentFulfillmentRecovery))
	mux.HandleFunc("POST /api/internal/payment-fulfillment/epay", b.endpoint(b.handleInternalPaymentEpay))
	mux.HandleFunc("POST /api/internal/payment-fulfillment/creem", b.endpoint(b.handleInternalPaymentCreem))
	mux.HandleFunc("POST /api/internal/payment-fulfillment/alipay", b.endpoint(b.handleInternalPaymentAlipay))
}

// handleMyRecentPaymentOrders returns the current user's recent credit top-up
// orders using the same public shape as the wallet UOL operation. The user ID
// is always derived from the authenticated session; query parameters can only
// control the bounded page size.
func (b *backend) handleMyRecentPaymentOrders(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireSession(r)
	if err != nil {
		return err
	}
	limit := 8
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, parseErr := strconv.Atoi(raw)
		if parseErr != nil || n < 1 || n > 20 {
			return invalid("充值订单数量无效")
		}
		limit = n
	}

	asOf := time.Now().UTC()
	var timeZone *string
	if err := b.db.QueryRow(r.Context(), `SELECT time_zone FROM "user" WHERE id=$1`, s.User.ID).Scan(&timeZone); err != nil {
		return err
	}
	effectiveZone := "UTC"
	if configured, settingErr := b.settingString(r.Context(), "APP_TIME_ZONE", "UTC"); settingErr == nil {
		if _, loadErr := time.LoadLocation(configured); loadErr == nil {
			effectiveZone = configured
		}
	}
	if timeZone != nil {
		if _, loadErr := time.LoadLocation(*timeZone); loadErr == nil {
			effectiveZone = *timeZone
		}
	}

	rows, err := b.db.Query(r.Context(), `
		SELECT id,provider,purpose,status,currency,amount_minor,credits_amount,created_at,expires_at,fulfilled_at
		FROM payment_order
		WHERE user_id=$1 AND purpose IN ('credit_top_up','credit_package')
		ORDER BY created_at DESC,id DESC LIMIT $2`, s.User.ID, limit)
	if err != nil {
		return err
	}
	defer rows.Close()
	records := make([]map[string]any, 0, limit)
	for rows.Next() {
		var id, provider, purpose, status, currency string
		var amountMinor int64
		var creditsAmount float64
		var createdAt time.Time
		var expiresAt, fulfilledAt *time.Time
		if err := rows.Scan(&id, &provider, &purpose, &status, &currency, &amountMinor, &creditsAmount, &createdAt, &expiresAt, &fulfilledAt); err != nil {
			return err
		}
		displayStatus := "waiting_payment"
		if status == "fulfilled" {
			displayStatus = "fulfilled"
		} else if status == "failed" {
			displayStatus = "failed"
		} else if status == "fulfilling" {
			displayStatus = "payment_confirmed"
		} else if expiresAt != nil && !expiresAt.After(asOf) {
			displayStatus = "expired"
		}
		records = append(records, map[string]any{
			"id": id, "provider": provider, "purpose": purpose, "status": displayStatus,
			"currency": strings.ToUpper(currency), "amountMinor": amountMinor,
			"creditsAmount": creditsAmount, "createdAt": createdAt.UTC(),
			"fulfilledAt": func() any {
				if fulfilledAt == nil {
					return nil
				}
				return fulfilledAt.UTC()
			}(),
		})
	}
	if err := rows.Err(); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"asOf": asOf, "timeZone": effectiveZone, "records": records})
	return nil
}

func (b *backend) handleTopUpOrderStatus(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireSession(r)
	if err != nil {
		return err
	}
	var in struct {
		OrderID string `json:"orderId"`
	}
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	return b.writePaymentStatus(w, r, s.User.ID, in.OrderID, false)
}
func (b *backend) handleCreditPaymentStatus(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireSession(r)
	if err != nil {
		return err
	}
	var in struct {
		OrderID string `json:"orderId"`
	}
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	return b.writePaymentStatus(w, r, s.User.ID, in.OrderID, true)
}
func (b *backend) writePaymentStatus(w http.ResponseWriter, r *http.Request, uid, id string, unified bool) error {
	id = strings.TrimSpace(id)
	if id == "" || len(id) > 128 {
		return invalid("支付订单ID无效")
	}
	order, err := readTopUpCheckoutOrder(r.Context(), b.db, "id=$1 AND user_id=$2", id, uid)
	if errors.Is(err, pgx.ErrNoRows) {
		return &apiError{404, "NOT_FOUND", "积分支付订单不存在"}
	}
	if err != nil {
		return err
	}
	if !containsString([]string{"alipay_f2f", "creem", "epay"}, order.Provider) || (order.Purpose != "credit_top_up" && order.Purpose != "credit_package") || (!unified && (order.Provider != "alipay_f2f" || order.Purpose != "credit_top_up")) {
		return &apiError{404, "NOT_FOUND", "积分支付订单不存在"}
	}
	view := order.view()
	view["fulfilledAt"] = order.FulfilledAt
	if unified {
		delete(view, "amountMinor")
		view["provider"] = order.Provider
		status := "waiting_payment"
		switch order.Status {
		case "fulfilled":
			status = "fulfilled"
		case "failed":
			status = "failed"
		case "fulfilling":
			status = "payment_confirmed"
		default:
			if order.ExpiresAt != nil && !order.ExpiresAt.After(time.Now()) {
				status = "expired"
			}
		}
		view["status"] = status
	}
	writeJSON(w, http.StatusOK, view)
	return nil
}
