//go:build integration

package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"reflect"
	"testing"
	"time"
)

func paymentReadFixture(t *testing.T, b *backend, uid, id, status, currency, purpose string, minor int64, created time.Time, fulfilled *time.Time) {
	t.Helper()
	_, err := b.db.Exec(context.Background(), `INSERT INTO payment_order(id,user_id,client_request_id,provider,purpose,status,currency,amount,amount_minor,credits_amount,pricing_snapshot,created_at,updated_at,fulfilled_at) VALUES($1,$2,$1,'alipay_f2f',$3,$4,$5,$6,$7,12.34,'{}',$8,$8,$9)`, id, uid, purpose, status, currency, float64(minor)/100, minor, created, fulfilled)
	if err != nil {
		t.Fatal(err)
	}
}
func paymentReadAdmin(t *testing.T, b *backend) (string, *http.Cookie) {
	t.Helper()
	uid, email := seedAuthUser(t, b)
	if _, err := b.db.Exec(context.Background(), `UPDATE "user" SET role='super_admin' WHERE id=$1`, uid); err != nil {
		t.Fatal(err)
	}
	return uid, signInTestUser(t, b, email)
}
func TestPaymentAdminOverviewRealTimezoneAndCurrencyBuckets(t *testing.T) {
	b := integrationBackend(t)
	uid, cookie := paymentReadAdmin(t, b)
	setStorageTestSetting(t, b, "APP_TIME_ZONE", "Asia/Shanghai")
	var err error
	a := time.Date(2024, 8, 31, 16, 0, 0, 0, time.UTC)
	outside := a.Add(-time.Microsecond)
	next := a.Add(24 * time.Hour)
	paymentReadFixture(t, b, uid, "read-outside", "fulfilled", "CNY", "credit_top_up", 9900, outside, &outside)
	paymentReadFixture(t, b, uid, "read-boundary", "fulfilled", "CNY", "credit_top_up", 1234, a, &a)
	paymentReadFixture(t, b, uid, "read-pending", "pending", "USD", "credit_top_up", 500, a.Add(time.Hour), nil)
	paymentReadFixture(t, b, uid, "read-second", "fulfilled", "CNY", "credit_package", 456, next, &next)
	paymentReadFixture(t, b, uid, "read-old-created", "fulfilled", "USD", "credit_package", 789, outside, &next)
	paymentReadFixture(t, b, uid, "read-retired", "fulfilled", "CNY", "subscription", 500000, a, &a)
	out := requireCreditResponse(t, authRequest(t, b, "POST", "/api/admin/payment/overview", `{"startDate":"2024-09-01","endDate":"2024-09-02"}`, cookie), 200)
	if out["timeZone"] != "Asia/Shanghai" || out["rangeStart"] != "2024-08-31T16:00:00Z" || out["rangeEnd"] != "2024-09-02T16:00:00Z" || out["rechargeOrderCount"] != float64(3) || out["revenueDayCount"] != float64(2) {
		t.Fatalf("overview=%v", out)
	}
	totals := []any{map[string]any{"currency": "CNY", "amountMinor": float64(1690)}, map[string]any{"currency": "USD", "amountMinor": float64(789)}}
	if !reflect.DeepEqual(out["revenueTotals"], totals) {
		t.Fatalf("totals=%v", out["revenueTotals"])
	}
	daily := out["daily"].([]any)
	day1 := daily[0].(map[string]any)
	if day1["orderCount"] != float64(2) || day1["revenue"].([]any)[1].(map[string]any)["amountMinor"] != float64(0) {
		t.Fatalf("zero currency series=%v", daily)
	}
	// Default report covers the complete deployment calendar month, and never includes future-dated facts.
	future := time.Now().UTC().Add(10 * 24 * time.Hour)
	paymentReadFixture(t, b, uid, "read-future", "fulfilled", "CNY", "credit_top_up", 900000, future, &future)
	defaultOut := requireCreditResponse(t, authRequest(t, b, "POST", "/api/admin/payment/overview", `{}`, cookie), 200)
	loc, _ := time.LoadLocation("Asia/Shanghai")
	month := time.Now().In(loc).Format("2006-01")
	if defaultOut["startDate"] != month+"-01" || defaultOut["rechargeOrderCount"] != float64(0) {
		t.Fatalf("default or future bound=%v", defaultOut)
	}
	for _, body := range []string{`{"startDate":"2024-09-01"}`, `{"startDate":"2024-09-02","endDate":"2024-09-01"}`, `{"startDate":"2024-02-30","endDate":"2024-03-01"}`} {
		requireCreditResponse(t, authRequest(t, b, "POST", "/api/admin/payment/overview", body, cookie), 400)
	}
	if path := os.Getenv("GO_PAYMENT_ADMIN_OVERVIEW_FIXTURE"); path != "" {
		raw, _ := json.Marshal(out)
		if err = os.WriteFile(path, raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestPaymentAdminOrdersRealCursorAndSnapshot(t *testing.T) {
	b := integrationBackend(t)
	uid, cookie := paymentReadAdmin(t, b)
	_, otherCookie := paymentReadAdmin(t, b)
	setStorageTestSetting(t, b, "APP_TIME_ZONE", "Asia/Shanghai")
	var err error
	var email string
	if err = b.db.QueryRow(context.Background(), `SELECT email FROM "user" WHERE id=$1`, uid).Scan(&email); err != nil {
		t.Fatal(err)
	}
	at := time.Date(2024, 9, 1, 1, 0, 0, 123456000, time.UTC)
	for _, id := range []string{"order-a", "order-b", "order-c", "order-d", "order-e"} {
		paymentReadFixture(t, b, uid, id, "pending", "CNY", "credit_top_up", 100, at, nil)
	}
	input := map[string]any{"startDate": "2024-09-01", "endDate": "2024-09-01", "pageSize": 2, "page": 1, "userEmail": email}
	read := func(input map[string]any, c *http.Cookie, status int) map[string]any {
		return requireCreditResponse(t, authRequest(t, b, "POST", "/api/admin/payment/orders", mustJSON(input), c), status)
	}
	first := read(input, cookie, 200)
	historyExpectIDs(t, first, "order-e", "order-d")
	if first["nextCursor"] == nil || first["previousCursor"] != nil || first["totalCount"] != float64(5) {
		t.Fatalf("first=%v", first)
	}
	if first["records"].([]any)[0].(map[string]any)["providerTradeNo"] != nil {
		t.Fatal("nullable trade number changed")
	}
	input["cursor"], input["page"] = first["nextCursor"], 2
	second := read(input, cookie, 200)
	historyExpectIDs(t, second, "order-c", "order-b")
	input["cursor"], input["page"] = second["previousCursor"], 1
	historyExpectIDs(t, read(input, cookie, 200), "order-e", "order-d")
	input["cursor"], input["page"] = second["nextCursor"], 3
	last := read(input, cookie, 200)
	historyExpectIDs(t, last, "order-a")
	if last["nextCursor"] != nil {
		t.Fatal("last next cursor")
	}
	input["cursor"], input["page"] = first["nextCursor"], 2
	read(input, otherCookie, 400)
	input["status"] = "pending"
	read(input, cookie, 400)
	delete(input, "status")
	input["page"] = 3
	read(input, cookie, 400)
	input["page"] = 2
	input["cursor"] = first["nextCursor"].(string) + "A"
	read(input, cookie, 400)
	input["cursor"] = first["nextCursor"]
	input["pageSize"] = 1
	read(input, cookie, 400)
	input["pageSize"] = 2
	_, err = b.db.Exec(context.Background(), `UPDATE system_setting SET value='"UTC"' WHERE key='APP_TIME_ZONE'`)
	if err != nil {
		t.Fatal(err)
	}
	read(input, cookie, 400)
	_, err = b.db.Exec(context.Background(), `UPDATE system_setting SET value='"Asia/Shanghai"' WHERE key='APP_TIME_ZONE'`)
	if err != nil {
		t.Fatal(err)
	}
	delete(input, "cursor")
	input["page"] = 999
	clipped := read(input, cookie, 200)
	historyExpectIDs(t, clipped, "order-a")
	if clipped["page"] != float64(3) {
		t.Fatalf("clipped=%v", clipped)
	}
	input["userEmail"] = "different+" + email
	input["page"] = 1
	if got := read(input, cookie, 200); got["totalCount"] != float64(0) {
		t.Fatalf("email filter not exact=%v", got)
	}
	if path := os.Getenv("GO_PAYMENT_ADMIN_ORDERS_FIXTURE"); path != "" {
		raw, _ := json.Marshal(first)
		if err = os.WriteFile(path, raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	// A cursor freezes the upper creation clock even while new rows arrive.
	loc, _ := time.LoadLocation("Asia/Shanghai")
	today := time.Now().In(loc).Format("2006-01-02")
	recent := time.Now().UTC().Add(-time.Minute)
	for _, id := range []string{"now-a", "now-b", "now-c"} {
		paymentReadFixture(t, b, uid, id, "pending", "CNY", "credit_top_up", 100, recent, nil)
	}
	inNow := map[string]any{"startDate": today, "endDate": today, "pageSize": 1, "page": 1, "userEmail": email}
	nowFirst := read(inNow, cookie, 200)
	paymentReadFixture(t, b, uid, "now-new", "pending", "CNY", "credit_top_up", 100, time.Now().UTC(), nil)
	inNow["cursor"], inNow["page"] = nowFirst["nextCursor"], 2
	if got := read(inNow, cookie, 200); got["totalCount"] != float64(3) || got["asOf"] != nowFirst["asOf"] {
		t.Fatalf("snapshot drift=%v", got)
	}
}

func TestPaymentAdminSearchAndRoles(t *testing.T) {
	b := integrationBackend(t)
	uid, cookie := paymentReadAdmin(t, b)
	other, email := seedAuthUser(t, b)
	member := signInTestUser(t, b, email)
	at := time.Now().UTC().Add(-time.Hour)
	paymentReadFixture(t, b, uid, "search-a", "pending", "CNY", "credit_top_up", 1, at, nil)
	paymentReadFixture(t, b, other, "search-b", "pending", "CNY", "credit_top_up", 1, at.Add(time.Minute), nil)
	read := func(body string, cookie *http.Cookie, status int) map[string]any {
		return requireCreditResponse(t, authRequest(t, b, "POST", "/api/admin/payment/users/search", body, cookie), status)
	}
	out := read(`{"query":"","limit":1}`, cookie, 200)
	if out["users"].([]any)[0].(map[string]any)["id"] != other {
		t.Fatalf("recent user ordering=%v", out)
	}
	out = read(`{"query":"%"}`, cookie, 200)
	if len(out["users"].([]any)) != 0 {
		t.Fatalf("wildcard expanded=%v", out)
	}
	for _, path := range []string{"overview", "orders", "users/search"} {
		requireCreditResponse(t, authRequest(t, b, "POST", "/api/admin/payment/"+path, `{}`, member), 403)
		requireCreditResponse(t, authRequest(t, b, "POST", "/api/admin/payment/"+path, `{}`), 401)
	}
}
