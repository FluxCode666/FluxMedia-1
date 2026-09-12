package main

import (
	"encoding/json"
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

func (b *backend) handleAdminPaymentOverview(w http.ResponseWriter, r *http.Request) error {
	if _, err := b.requireAdmin(r, false); err != nil {
		return err
	}
	var in struct{ StartDate, EndDate string }
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	now := time.Now().UTC()
	start := now.AddDate(0, 0, -6)
	if in.StartDate != "" {
		if t, e := time.Parse("2006-01-02", in.StartDate); e == nil {
			start = t.UTC()
		}
	}
	end := now
	if in.EndDate != "" {
		if t, e := time.Parse("2006-01-02", in.EndDate); e == nil {
			end = t.UTC().Add(24 * time.Hour)
		}
	}
	if end.Before(start) {
		return invalid("结束日期不能早于开始日期")
	}
	rows, err := b.db.Query(r.Context(), `SELECT created_at::date, count(*) FROM payment_order WHERE purpose IN ('credit_top_up','credit_package') AND created_at >= $1 AND created_at < $2 GROUP BY 1 ORDER BY 1`, start, end)
	if err != nil {
		return err
	}
	defer rows.Close()
	counts := map[string]int{}
	total := 0
	for rows.Next() {
		var d time.Time
		var n int
		if err := rows.Scan(&d, &n); err != nil {
			return err
		}
		counts[d.Format("2006-01-02")] = n
		total += n
	}
	revRows, err := b.db.Query(r.Context(), `SELECT fulfilled_at::date,currency,COALESCE(sum(amount_minor),0) FROM payment_order WHERE purpose IN ('credit_top_up','credit_package') AND status='fulfilled' AND fulfilled_at >= $1 AND fulfilled_at < $2 GROUP BY 1,2 ORDER BY 1,2`, start, end)
	if err != nil {
		return err
	}
	defer revRows.Close()
	rev := map[string]map[string]int64{}
	totals := map[string]int64{}
	for revRows.Next() {
		var d time.Time
		var c string
		var a int64
		if err := revRows.Scan(&d, &c, &a); err != nil {
			return err
		}
		if rev[d.Format("2006-01-02")] == nil {
			rev[d.Format("2006-01-02")] = map[string]int64{}
		}
		rev[d.Format("2006-01-02")][strings.ToUpper(c)] = a
		totals[strings.ToUpper(c)] += a
	}
	daily := []any{}
	for d := start; d.Before(end); d = d.AddDate(0, 0, 1) {
		ds := d.Format("2006-01-02")
		arr := []any{}
		for c, a := range rev[ds] {
			arr = append(arr, map[string]any{"currency": c, "amountMinor": a})
		}
		daily = append(daily, map[string]any{"date": ds, "orderCount": counts[ds], "revenue": arr})
	}
	rt := []any{}
	for c, a := range totals {
		rt = append(rt, map[string]any{"currency": c, "amountMinor": a})
	}
	writeJSON(w, 200, map[string]any{"startDate": start.Format("2006-01-02"), "endDate": end.Add(-24 * time.Hour).Format("2006-01-02"), "timeZone": "UTC", "rangeStart": start.Format(time.RFC3339Nano), "rangeEnd": end.Format(time.RFC3339Nano), "rechargeOrderCount": total, "revenueDayCount": len(rev), "revenueTotals": rt, "daily": daily})
	return nil
}

func (b *backend) handleAdminPaymentOrders(w http.ResponseWriter, r *http.Request) error {
	if _, err := b.requireAdmin(r, false); err != nil {
		return err
	}
	var in struct {
		Page, PageSize, Limit                          int
		StartDate, EndDate, OrderID, Status, UserEmail string
	}
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	size := in.PageSize
	if size == 0 {
		size = in.Limit
	}
	if size < 1 {
		size = 20
	}
	if size > 100 {
		size = 100
	}
	page := in.Page
	if page < 1 {
		page = 1
	}
	start := time.Now().UTC().AddDate(0, 0, -6)
	end := time.Now().UTC()
	if in.StartDate != "" {
		if t, e := time.Parse("2006-01-02", in.StartDate); e == nil {
			start = t.UTC()
		}
	}
	if in.EndDate != "" {
		if t, e := time.Parse("2006-01-02", in.EndDate); e == nil {
			end = t.UTC().Add(24 * time.Hour)
		}
	}
	where := []string{"p.purpose IN ('credit_top_up','credit_package')", "p.created_at >= $1", "p.created_at < $2"}
	args := []any{start, end}
	if in.OrderID != "" {
		args = append(args, in.OrderID)
		where = append(where, "p.id=$"+strconv.Itoa(len(args)))
	}
	if in.Status != "" {
		args = append(args, in.Status)
		where = append(where, "p.status=$"+strconv.Itoa(len(args)))
	}
	if in.UserEmail != "" {
		args = append(args, "%"+in.UserEmail+"%")
		where = append(where, "u.email ILIKE $"+strconv.Itoa(len(args)))
	}
	base := len(args)
	args = append(args, size, (page-1)*size)
	q := `SELECT p.id,p.user_id,u.email,p.provider,p.purpose,p.status,p.currency,p.amount_minor,p.credits_amount,p.provider_trade_no,p.created_at,p.updated_at,p.expires_at,p.fulfilled_at FROM payment_order p JOIN "user" u ON u.id=p.user_id WHERE ` + strings.Join(where, " AND ") + ` ORDER BY p.created_at DESC,p.id DESC LIMIT $` + strconv.Itoa(base+1) + ` OFFSET $` + strconv.Itoa(base+2)
	rows, err := b.db.Query(r.Context(), q, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	records := []any{}
	for rows.Next() {
		var id, uid, email, provider, purpose, status, currency string
		var amountMinor int64
		var credits float64
		var trade *string
		var created, updated time.Time
		var exp, ful *time.Time
		if err := rows.Scan(&id, &uid, &email, &provider, &purpose, &status, &currency, &amountMinor, &credits, &trade, &created, &updated, &exp, &ful); err != nil {
			return err
		}
		records = append(records, map[string]any{"id": id, "userId": uid, "userEmail": email, "provider": provider, "purpose": purpose, "status": status, "currency": currency, "amountMinor": amountMinor, "creditsAmount": credits, "providerTradeNo": trade, "createdAt": created, "updatedAt": updated, "expiresAt": exp, "fulfilledAt": ful})
	}
	var total int
	countQ := `SELECT count(*) FROM payment_order p JOIN "user" u ON u.id=p.user_id WHERE ` + strings.Join(where, " AND ")
	if err := b.db.QueryRow(r.Context(), countQ, args[:base]...).Scan(&total); err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"asOf": time.Now().UTC(), "page": page, "pageSize": size, "totalCount": total, "records": records, "nextCursor": nil, "previousCursor": nil})
	return nil
}

func (b *backend) handleAdminPaymentUsers(w http.ResponseWriter, r *http.Request) error {
	if _, err := b.requireAdmin(r, false); err != nil {
		return err
	}
	var in struct {
		Query string `json:"query"`
		Limit int    `json:"limit"`
	}
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	if in.Limit < 1 || in.Limit > 50 {
		in.Limit = 20
	}
	q := "%" + strings.TrimSpace(in.Query) + "%"
	rows, err := b.db.Query(r.Context(), `SELECT DISTINCT u.id,u.email FROM "user" u JOIN payment_order p ON p.user_id=u.id WHERE p.purpose IN ('credit_top_up','credit_package') AND u.email ILIKE $1 ORDER BY u.email LIMIT $2`, q, in.Limit)
	if err != nil {
		return err
	}
	defer rows.Close()
	users := []any{}
	for rows.Next() {
		var id, email string
		if err := rows.Scan(&id, &email); err != nil {
			return err
		}
		users = append(users, map[string]any{"id": id, "email": email})
	}
	writeJSON(w, 200, map[string]any{"users": users})
	return nil
}

func (b *backend) handleTopUpCheckout(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireSession(r)
	if err != nil {
		return err
	}
	var in struct {
		ClientRequestID, Currency, Provider string
		AmountMinor                         int64
	}
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	if in.ClientRequestID == "" || in.Currency == "" || in.AmountMinor <= 0 || in.Provider != "alipay_f2f" {
		return invalid("充值参数无效")
	}
	var credits float64 = float64(in.AmountMinor)
	id := newRequestID()
	var existing string
	_ = b.db.QueryRow(r.Context(), `SELECT id FROM payment_order WHERE user_id=$1 AND client_request_id=$2`, s.User.ID, in.ClientRequestID).Scan(&existing)
	if existing != "" {
		id = existing
	} else {
		_, err = b.db.Exec(r.Context(), `INSERT INTO payment_order(id,user_id,client_request_id,provider,purpose,status,currency,amount,amount_minor,credits_amount,pricing_snapshot,updated_at) VALUES($1,$2,$3,'alipay_f2f','credit_top_up','pending',$4,$5,$5,$6,$7,now())`, id, s.User.ID, in.ClientRequestID, strings.ToUpper(in.Currency), float64(in.AmountMinor)/100, float64(in.AmountMinor), `{}`)
		if err != nil {
			return err
		}
	}
	writeJSON(w, 200, map[string]any{"orderId": id, "status": "pending", "currency": strings.ToUpper(in.Currency), "amount": float64(in.AmountMinor) / 100, "amountMinor": in.AmountMinor, "creditsAmount": credits, "qrCode": nil, "expiresAt": nil})
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
	var oid, provider, status, currency string
	var amountMinor int64
	var amount, credits float64
	var qr []byte
	var exp, ful *time.Time
	err := b.db.QueryRow(r.Context(), `SELECT id,provider,status,currency,amount,amount_minor,credits_amount,provider_payload,expires_at,fulfilled_at FROM payment_order WHERE id=$1 AND user_id=$2`, id, uid).Scan(&oid, &provider, &status, &currency, &amount, &amountMinor, &credits, &qr, &exp, &ful)
	if err != nil {
		return invalid("积分支付订单不存在")
	}
	var q any
	if len(qr) > 0 {
		var m map[string]any
		_ = json.Unmarshal(qr, &m)
		q = m["qrCode"]
	}
	if unified {
		if status == "pending" && exp != nil && exp.Before(time.Now()) {
			status = "expired"
		}
		writeJSON(w, 200, map[string]any{"orderId": oid, "provider": provider, "status": status, "currency": currency, "amount": amount, "creditsAmount": credits, "qrCode": q, "expiresAt": exp, "fulfilledAt": ful})
	} else {
		writeJSON(w, 200, map[string]any{"orderId": oid, "status": status, "currency": currency, "amount": amount, "amountMinor": amountMinor, "creditsAmount": credits, "qrCode": q, "expiresAt": exp, "fulfilledAt": ful})
	}
	return nil
}
