package main

import (
	"crypto/hmac"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/mail"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type paymentAdminRange struct {
	From, To, Zone string
	Start, End     time.Time
	Dates          []string
}

func resolvePaymentAdminRange(from, to, zone string, now time.Time, orders bool) (paymentAdminRange, error) {
	out := paymentAdminRange{Zone: zone, Dates: []string{}}
	loc, err := time.LoadLocation(zone)
	if err != nil {
		return out, invalid("支付报表时区无效")
	}
	today := now.In(loc).Format("2006-01-02")
	if (from == "") != (to == "") {
		return out, invalid("开始日期和结束日期必须同时提供")
	}
	if from == "" {
		if orders {
			from, to = operationsAddDate(today, -6), today
		} else {
			from = today[:7] + "-01"
			first, _ := time.Parse("2006-01-02", from)
			to = first.AddDate(0, 1, -1).Format("2006-01-02")
		}
	}
	f, e1 := time.Parse("2006-01-02", from)
	t, e2 := time.Parse("2006-01-02", to)
	if e1 != nil || e2 != nil || f.Year() < 2000 || t.Year() > 2099 || from > to || t.Sub(f) > 365*24*time.Hour {
		return out, invalid("支付日期范围无效或超过366天")
	}
	maxEnd := today[:4] + "-12-31"
	if orders {
		maxEnd = today
	}
	if from > today || to > maxEnd {
		return out, invalid("支付日期范围不能处于未来")
	}
	out.From, out.To = from, to
	out.Start = operationsDateStart(from, loc)
	out.End = operationsDateStart(operationsAddDate(to, 1), loc)
	for d := f; !d.After(t); d = d.AddDate(0, 0, 1) {
		out.Dates = append(out.Dates, d.Format("2006-01-02"))
	}
	return out, nil
}

func (b *backend) paymentAdminSnapshot(r *http.Request) (pgx.Tx, time.Time, string, error) {
	zone, err := b.settingString(r.Context(), "APP_TIME_ZONE", "UTC")
	if err != nil {
		return nil, time.Time{}, "", err
	}
	tx, err := b.db.BeginTx(r.Context(), pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, time.Time{}, "", err
	}
	var now time.Time
	if err = tx.QueryRow(r.Context(), `SELECT transaction_timestamp()`).Scan(&now); err != nil {
		rollback(tx)
		return nil, time.Time{}, "", err
	}
	// Business timestamps store UTC without a time zone; bind a UTC clock even
	// when pgx decodes transaction_timestamp() in the machine's local zone.
	return tx, now.UTC(), zone, nil
}

func (b *backend) handleAdminPaymentOverview(w http.ResponseWriter, r *http.Request) error {
	if _, err := b.requireAdmin(r, false); err != nil {
		return err
	}
	var in struct {
		StartDate string `json:"startDate"`
		EndDate   string `json:"endDate"`
	}
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	tx, now, zone, err := b.paymentAdminSnapshot(r)
	if err != nil {
		return err
	}
	defer rollback(tx)
	rng, err := resolvePaymentAdminRange(in.StartDate, in.EndDate, zone, now, false)
	if err != nil {
		return err
	}
	end := rng.End
	if end.After(now) {
		end = now
	}
	// Order volume follows creation, while revenue follows fulfillment. Both
	// use deployment calendar days and exclude facts beyond this snapshot.
	rows, err := tx.Query(r.Context(), `SELECT to_char((created_at AT TIME ZONE 'UTC') AT TIME ZONE $3,'YYYY-MM-DD'),upper(btrim(currency)),count(*) FROM payment_order WHERE purpose IN ('credit_top_up','credit_package') AND created_at >= $1 AND created_at < $2 GROUP BY 1,2`, rng.Start, end, zone)
	if err != nil {
		return err
	}
	counts := map[string]int64{}
	currencies := map[string]bool{}
	total := int64(0)
	for rows.Next() {
		var date, currency string
		var n int64
		if err = rows.Scan(&date, &currency, &n); err != nil {
			rows.Close()
			return err
		}
		counts[date] += n
		total += n
		currencies[currency] = true
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	rows, err = tx.Query(r.Context(), `SELECT to_char((fulfilled_at AT TIME ZONE 'UTC') AT TIME ZONE $3,'YYYY-MM-DD'),upper(btrim(currency)),sum(amount_minor)::bigint FROM payment_order WHERE purpose IN ('credit_top_up','credit_package') AND status='fulfilled' AND fulfilled_at >= $1 AND fulfilled_at < $2 GROUP BY 1,2`, rng.Start, end, zone)
	if err != nil {
		return err
	}
	revenue := map[string]map[string]int64{}
	totals := map[string]int64{}
	for rows.Next() {
		var date, currency string
		var amount int64
		if err = rows.Scan(&date, &currency, &amount); err != nil {
			rows.Close()
			return err
		}
		if amount < 0 || amount > 9007199254740991 {
			rows.Close()
			return fmt.Errorf("invalid payment revenue")
		}
		if revenue[date] == nil {
			revenue[date] = map[string]int64{}
		}
		revenue[date][currency] = amount
		totals[currency] += amount
		currencies[currency] = true
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	sorted := []string{}
	for currency := range currencies {
		if len(currency) != 3 {
			return fmt.Errorf("invalid payment currency")
		}
		for _, c := range currency {
			if c < 'A' || c > 'Z' {
				return fmt.Errorf("invalid payment currency")
			}
		}
		sorted = append(sorted, currency)
	}
	sort.Strings(sorted)
	if len(sorted) > 32 {
		return fmt.Errorf("too many payment currencies")
	}
	daily := []any{}
	revenueDays := 0
	for _, date := range rng.Dates {
		amounts := []any{}
		positive := false
		for _, currency := range sorted {
			amount := revenue[date][currency]
			amounts = append(amounts, map[string]any{"currency": currency, "amountMinor": amount})
			positive = positive || amount > 0
		}
		if positive {
			revenueDays++
		}
		daily = append(daily, map[string]any{"date": date, "orderCount": counts[date], "revenue": amounts})
	}
	revenueTotals := []any{}
	for _, currency := range sorted {
		if totals[currency] > 9007199254740991 {
			return fmt.Errorf("payment total exceeds safe integer")
		}
		revenueTotals = append(revenueTotals, map[string]any{"currency": currency, "amountMinor": totals[currency]})
	}
	noStore(w)
	writeJSON(w, 200, map[string]any{"startDate": rng.From, "endDate": rng.To, "timeZone": zone, "rangeStart": rng.Start, "rangeEnd": rng.End, "rechargeOrderCount": total, "revenueDayCount": revenueDays, "revenueTotals": revenueTotals, "daily": daily})
	return nil
}

type paymentAdminListInput struct {
	Cursor    string  `json:"cursor"`
	StartDate string  `json:"startDate"`
	EndDate   string  `json:"endDate"`
	Page      int     `json:"page"`
	PageSize  *int    `json:"pageSize"`
	Limit     *int    `json:"limit"`
	OrderID   *string `json:"orderId"`
	Status    *string `json:"status"`
	UserEmail *string `json:"userEmail"`
}

type paymentAdminCursor struct {
	Version   int       `json:"v"`
	Actor     string    `json:"sub"`
	Filter    string    `json:"filter"`
	Direction string    `json:"direction"`
	Page      int       `json:"page"`
	PageSize  int       `json:"pageSize"`
	AsOf      time.Time `json:"asOf"`
	CreatedAt time.Time `json:"createdAt"`
	ID        string    `json:"id"`
}

// Payment cursors cannot be reused as history cursors or by another actor,
// filter, page size, or reporting time zone.
const paymentCursorDomain = "fluxmedia:go:payment-orders:v1"

func signPaymentAdminCursor(c paymentAdminCursor, secret string) string {
	raw, _ := json.Marshal(c)
	payload := base64.RawURLEncoding.EncodeToString(raw)
	return payload + "." + base64.RawURLEncoding.EncodeToString(historyMAC(secret, paymentCursorDomain, payload))
}

func parsePaymentAdminCursor(token, secret, actor, filter string, page, size int, now time.Time, rng paymentAdminRange) (*paymentAdminCursor, error) {
	bad := func() (*paymentAdminCursor, error) { return nil, invalid("支付分页游标无效") }
	parts := strings.Split(token, ".")
	if len(parts) != 2 || len(token) > 4096 || strings.TrimSpace(secret) == "" {
		return bad()
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(parts[0])
	if err != nil || base64.RawURLEncoding.EncodeToString(raw) != parts[0] {
		return bad()
	}
	sig, err := base64.RawURLEncoding.Strict().DecodeString(parts[1])
	if err != nil || base64.RawURLEncoding.EncodeToString(sig) != parts[1] || !hmac.Equal(sig, historyMAC(secret, paymentCursorDomain, parts[0])) {
		return bad()
	}
	var c paymentAdminCursor
	if json.Unmarshal(raw, &c) != nil || c.Version != 1 || c.Actor != actor || c.Filter != filter || c.Page != page || c.PageSize != size || c.AsOf.IsZero() || c.AsOf.After(now) || c.CreatedAt.IsZero() || c.CreatedAt.After(c.AsOf) || c.CreatedAt.Before(rng.Start) || !c.CreatedAt.Before(rng.End) || c.ID == "" || len(c.ID) > 128 || (c.Direction != "next" && c.Direction != "previous") {
		return bad()
	}
	return &c, nil
}

func (b *backend) handleAdminPaymentOrders(w http.ResponseWriter, r *http.Request) error {
	s, err := b.requireAdmin(r, false)
	if err != nil {
		return err
	}
	in := paymentAdminListInput{Page: 1}
	if err = decodeBody(r, &in); err != nil {
		return err
	}
	size := 20
	if in.Limit != nil {
		size = *in.Limit
	}
	if in.PageSize != nil {
		if in.Limit != nil && *in.PageSize != *in.Limit {
			return invalid("limit与pageSize必须一致")
		}
		size = *in.PageSize
	}
	if in.Page < 1 || int64(in.Page) > 9007199254740991 || size < 1 || size > 100 {
		return invalid("支付分页参数无效")
	}
	if in.Cursor != "" && (in.StartDate == "" || in.EndDate == "") {
		return invalid("分页游标必须携带原日期范围")
	}
	if in.OrderID != nil {
		v := strings.TrimSpace(*in.OrderID)
		if v == "" || len([]rune(v)) > 128 {
			return invalid("订单号无效")
		}
		in.OrderID = &v
	}
	if in.Status != nil {
		switch *in.Status {
		case "creating", "pending", "fulfilling", "fulfilled", "failed":
		default:
			return invalid("订单状态无效")
		}
	}
	if in.UserEmail != nil {
		v := strings.TrimSpace(*in.UserEmail)
		a, e := mail.ParseAddress(v)
		if e != nil || a.Address != v || len(v) > 320 {
			return invalid("用户邮箱无效")
		}
		in.UserEmail = &v
	}
	tx, now, zone, err := b.paymentAdminSnapshot(r)
	if err != nil {
		return err
	}
	defer rollback(tx)
	rng, err := resolvePaymentAdminRange(in.StartDate, in.EndDate, zone, now, true)
	if err != nil {
		return err
	}
	if strings.TrimSpace(b.config.authSecret) == "" {
		return fmt.Errorf("payment cursor secret missing")
	}
	filters, _ := json.Marshal(map[string]any{"from": rng.From, "to": rng.To, "zone": zone, "size": size, "orderId": in.OrderID, "status": in.Status, "email": in.UserEmail})
	filter := base64.RawURLEncoding.EncodeToString(historyMAC(b.config.authSecret, paymentCursorDomain+":filter", string(filters)))
	asOf := now
	var cursor *paymentAdminCursor
	if in.Cursor != "" {
		cursor, err = parsePaymentAdminCursor(in.Cursor, b.config.authSecret, s.User.ID, filter, in.Page, size, now, rng)
		if err != nil {
			return err
		}
		asOf = cursor.AsOf.UTC()
	}
	q := &historySQL{}
	where := `p.purpose IN ('credit_top_up','credit_package') AND p.created_at >= ` + q.bind(rng.Start) + ` AND p.created_at < ` + q.bind(rng.End) + ` AND p.created_at <= ` + q.bind(asOf)
	if in.OrderID != nil {
		where += " AND p.id=" + q.bind(*in.OrderID)
	}
	if in.Status != nil {
		where += " AND p.status=" + q.bind(*in.Status)
	}
	if in.UserEmail != nil {
		where += " AND u.email=" + q.bind(*in.UserEmail)
	}
	from := ` FROM payment_order p JOIN "user" u ON u.id=p.user_id WHERE `
	var total int
	if err = tx.QueryRow(r.Context(), `SELECT count(*)`+from+where, q.args...).Scan(&total); err != nil {
		return err
	}
	page := in.Page
	offset := 0
	direction := "DESC"
	if cursor == nil {
		pages := (total + size - 1) / size
		if pages < 1 {
			pages = 1
		}
		if page > pages {
			page = pages
		}
		offset = (page - 1) * size
	} else {
		op := "<"
		if cursor.Direction == "previous" {
			op = ">"
			direction = "ASC"
		}
		where += ` AND (p.created_at,p.id) ` + op + ` (` + q.bind(cursor.CreatedAt.UTC()) + `,` + q.bind(cursor.ID) + `)`
	}
	query := `SELECT p.id,p.user_id,u.email,p.provider,p.purpose,p.status,p.currency,p.amount_minor,p.credits_amount,p.provider_trade_no,p.created_at,p.updated_at,p.expires_at,p.fulfilled_at` + from + where + ` ORDER BY p.created_at ` + direction + `,p.id ` + direction + ` LIMIT ` + q.bind(size+1) + ` OFFSET ` + q.bind(offset)
	rows, err := tx.Query(r.Context(), query, q.args...)
	if err != nil {
		return err
	}
	records := []map[string]any{}
	for rows.Next() {
		var id, uid, email, provider, purpose, status, currency string
		var amount int64
		var credits float64
		var trade *string
		var created, updated time.Time
		var exp, ful *time.Time
		if err = rows.Scan(&id, &uid, &email, &provider, &purpose, &status, &currency, &amount, &credits, &trade, &created, &updated, &exp, &ful); err != nil {
			rows.Close()
			return err
		}
		records = append(records, map[string]any{"id": id, "userId": uid, "userEmail": email, "provider": provider, "purpose": purpose, "status": status, "currency": currency, "amountMinor": amount, "creditsAmount": credits, "providerTradeNo": trade, "createdAt": created.UTC(), "updatedAt": updated.UTC(), "expiresAt": exp, "fulfilledAt": ful})
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	extra := len(records) > size
	if extra {
		records = records[:size]
	}
	previousDirection := cursor != nil && cursor.Direction == "previous"
	if previousDirection {
		for i, j := 0, len(records)-1; i < j; i, j = i+1, j-1 {
			records[i], records[j] = records[j], records[i]
		}
	}
	var prev, next any
	encode := func(record map[string]any, direction string, targetPage int) string {
		return signPaymentAdminCursor(paymentAdminCursor{Version: 1, Actor: s.User.ID, Filter: filter, Direction: direction, Page: targetPage, PageSize: size, AsOf: asOf, CreatedAt: record["createdAt"].(time.Time), ID: record["id"].(string)}, b.config.authSecret)
	}
	if len(records) > 0 {
		if page > 1 && ((cursor == nil) || (cursor.Direction != "previous") || extra) {
			prev = encode(records[0], "previous", page-1)
		}
		if previousDirection || extra {
			next = encode(records[len(records)-1], "next", page+1)
		}
	}
	noStore(w)
	writeJSON(w, 200, map[string]any{"asOf": asOf, "page": page, "pageSize": size, "totalCount": total, "records": records, "nextCursor": next, "previousCursor": prev})
	return nil
}

func (b *backend) handleAdminPaymentUsers(w http.ResponseWriter, r *http.Request) error {
	if _, err := b.requireAdmin(r, false); err != nil {
		return err
	}
	in := struct {
		Query string `json:"query"`
		Limit int    `json:"limit"`
	}{Limit: 20}
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	in.Query = strings.TrimSpace(in.Query)
	if len([]rune(in.Query)) > 160 || in.Limit < 1 || in.Limit > 50 {
		return invalid("充值用户搜索参数无效")
	}
	pattern := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(in.Query)
	rows, err := b.db.Query(r.Context(), `SELECT u.id,u.email FROM payment_order p JOIN "user" u ON u.id=p.user_id WHERE p.purpose IN ('credit_top_up','credit_package') AND u.email ILIKE $1 GROUP BY u.id,u.email ORDER BY max(p.created_at) DESC,u.email ASC LIMIT $2`, "%"+pattern+"%", in.Limit)
	if err != nil {
		return err
	}
	defer rows.Close()
	users := []any{}
	for rows.Next() {
		var id, email string
		if err = rows.Scan(&id, &email); err != nil {
			return err
		}
		users = append(users, map[string]string{"id": id, "email": email})
	}
	if err = rows.Err(); err != nil {
		return err
	}
	noStore(w)
	writeJSON(w, 200, map[string]any{"users": users})
	return nil
}
