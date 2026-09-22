//go:build integration

package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/jackc/pgx/v5/pgxpool"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type creditPackageRoundTripper func(*http.Request) (*http.Response, error)

func (f creditPackageRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func packageCheckoutFixture(t *testing.T, provider, currency string) (*backend, string, *http.Cookie) {
	t.Helper()
	b := integrationBackend(t)
	uid, email := seedAuthUser(t, b)
	cookie := signInTestUser(t, b, email)
	b.config.publicAppURL = "http://localhost:3000"
	setStorageTestSetting(t, b, "PAYMENT_PROVIDER", provider)
	setStorageTestSetting(t, b, "CREDIT_PACKAGE_MATRIX", map[string]any{"packages": []any{map[string]any{"id": "test-package", "name": "Test credits", "credits": 123, "price": 12.34, "currency": currency, "visible": true, "allowQuantity": true, "maxQuantity": 4, "creemProductId": "prod-package"}, map[string]any{"id": "hidden-package", "credits": 999, "price": 1, "visible": false}}})
	setStorageTestSetting(t, b, "CREDITS_EXPIRY_DAYS", 7)
	setStorageTestSetting(t, b, "REFERRAL_REWARD_CONFIG", map[string]any{"enabled": false})
	setStorageTestSetting(t, b, "EPAY_PID", "package-merchant")
	setStorageTestSetting(t, b, "EPAY_KEY", "test-package-epay-secret")
	setStorageTestSetting(t, b, "EPAY_API_URL", "https://pay.example.test/merchant")
	setStorageTestSetting(t, b, "EPAY_NOTIFY_URL", "")
	setStorageTestSetting(t, b, "CREEM_API_KEY", "creem_test_package_key")
	setStorageTestSetting(t, b, "CREEM_WEBHOOK_SECRET", "test-package-creem-secret")
	return b, uid, cookie
}
func packageCheckoutInput(quantity int) map[string]any {
	raw := newRequestID()
	id := fmt.Sprintf("%s-%s-4%s-8%s-%s", raw[:8], raw[8:12], raw[13:16], raw[17:20], raw[20:])
	return map[string]any{"packageId": "test-package", "clientRequestId": id, "quantity": quantity, "locale": "zh"}
}
func assertPackageCreditState(t *testing.T, b *backend, uid, orderID string, amount float64) {
	t.Helper()
	var status string
	var balance, remaining float64
	var batches, transactions, events int
	var expires *time.Time
	if err := b.db.QueryRow(context.Background(), `SELECT status FROM payment_order WHERE id=$1`, orderID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if err := b.db.QueryRow(context.Background(), `SELECT balance,(SELECT sum(remaining) FROM credits_batch WHERE user_id=$1),(SELECT count(*) FROM credits_batch WHERE user_id=$1),(SELECT count(*) FROM credits_transaction WHERE user_id=$1),(SELECT max(expires_at) FROM credits_batch WHERE user_id=$1),(SELECT count(*) FROM payment_lifecycle_event WHERE payment_order_id=$2 AND event_type='fulfillment_succeeded') FROM credits_balance WHERE user_id=$1`, uid, orderID).Scan(&balance, &remaining, &batches, &transactions, &expires, &events); err != nil {
		t.Fatal(err)
	}
	if status != "fulfilled" || balance != amount || remaining != amount || batches != 1 || transactions != 1 || events != 1 || expires == nil || expires.Before(time.Now().Add(6*24*time.Hour)) {
		t.Fatalf("incorrect payment ledger: status=%s balance=%v remaining=%v batches=%d transactions=%d events=%d expiry=%v", status, balance, remaining, batches, transactions, events, expires)
	}
}
func TestCreditPackageEpayCheckoutConcurrentReplayAndSignedFulfillment(t *testing.T) {
	b, uid, cookie := packageCheckoutFixture(t, "epay", "CNY")
	input := packageCheckoutInput(2)
	if w := authRequest(t, b, "POST", "/api/credits/purchase-checkout", mustJSON(input)); w.Code != 401 {
		t.Fatalf("anonymous checkout %d", w.Code)
	}
	list := authRequest(t, b, "GET", "/api/credits/packages", "", cookie)
	var packages []creditPackage
	if err := json.Unmarshal(list.Body.Bytes(), &packages); err != nil || list.Code != 200 || len(packages) != 1 || packages[0].ID != "test-package" {
		t.Fatalf("visible packages: %d %s", list.Code, list.Body.String())
	}
	var wg sync.WaitGroup
	responses := make(chan *httptest.ResponseRecorder, 12)
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			responses <- authRequest(t, b, "POST", "/api/credits/purchase-checkout", mustJSON(input), cookie)
		}()
	}
	wg.Wait()
	close(responses)
	orderID := ""
	var form map[string]any
	for response := range responses {
		out := requireCreditResponse(t, response, 200)
		if orderID == "" {
			orderID = out["orderId"].(string)
		}
		if out["orderId"] != orderID || out["method"] != "POST" || out["url"] != "https://pay.example.test/merchant/submit.php" {
			t.Fatalf("checkout replay changed: %+v", out)
		}
		form = out["params"].(map[string]any)
	}
	if form["money"] != "24.68" || form["pid"] != "package-merchant" || form["notify_url"] != "http://localhost:3000/api/webhooks/epay" {
		t.Fatalf("invalid Epay form: %+v", form)
	}
	params := map[string]string{}
	for k, v := range form {
		params[k] = v.(string)
	}
	if params["sign"] != epaySign(params, "test-package-epay-secret") {
		t.Fatal("Epay signature mismatch")
	}
	var amount float64
	var minor int64
	var count int
	if err := b.db.QueryRow(context.Background(), `SELECT amount,amount_minor,(SELECT count(*) FROM payment_order WHERE user_id=$2) FROM payment_order WHERE id=$1`, orderID, uid).Scan(&amount, &minor, &count); err != nil || amount != 24.68 || minor != 2468 || count != 1 {
		t.Fatalf("local order amount=%v minor=%d count=%d err=%v", amount, minor, count, err)
	}
	callback := map[string]string{"out_trade_no": params["out_trade_no"], "trade_no": "trade-" + orderID, "trade_status": "TRADE_SUCCESS", "money": "24.68", "pid": "package-merchant"}
	callback["sign"] = epaySign(callback, "test-package-epay-secret")
	encoded := url.Values{}
	for k, v := range callback {
		encoded.Set(k, v)
	}
	for i := 0; i < 2; i++ {
		w := storageTestRequest(b, "POST", "/api/webhooks/epay", []byte(encoded.Encode()), nil, map[string]string{"Content-Type": "application/x-www-form-urlencoded"})
		if w.Code != 200 || w.Body.String() != "success" {
			t.Fatalf("Epay callback: %d %s", w.Code, w.Body.String())
		}
	}
	assertPackageCreditState(t, b, uid, orderID, 246)
	replay := requireCreditResponse(t, authRequest(t, b, "POST", "/api/credits/purchase-checkout", mustJSON(input), cookie), 200)
	if replay["url"] != "http://localhost:3000/zh/dashboard/credits/payment/"+orderID || replay["method"] != nil {
		t.Fatalf("fulfilled checkout reopens payment: %+v", replay)
	}
	input["quantity"] = 3
	requireCreditResponse(t, authRequest(t, b, "POST", "/api/credits/purchase-checkout", mustJSON(input), cookie), 409)
}
func TestCreditPackageCreemCheckoutAndHMACFulfillment(t *testing.T) {
	b, uid, cookie := packageCheckoutFixture(t, "creem", "USD")
	input := packageCheckoutInput(1)
	var calls atomic.Int32
	var received map[string]any
	b.creemHTTPClient = &http.Client{Transport: creditPackageRoundTripper(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		if r.URL.String() != "https://test-api.creem.io/v1/checkouts" || r.Header.Get("x-api-key") != "creem_test_package_key" {
			t.Errorf("wrong Creem channel %s", r.URL)
		}
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &received); err != nil {
			t.Error(err)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"id":"checkout-package","checkout_url":"https://checkout.creem.io/package"}`))}, nil
	})}
	out := requireCreditResponse(t, authRequest(t, b, "POST", "/api/credits/purchase-checkout", mustJSON(input), cookie), 200)
	orderID := out["orderId"].(string)
	if out["url"] != "https://checkout.creem.io/package" || out["method"] != nil || received["product_id"] != "prod-package" || received["request_id"] != "credit_purchase_"+orderID || received["success_url"] != "http://localhost:3000/zh/dashboard/credits/payment/"+orderID {
		t.Fatalf("Creem checkout mismatch %+v %+v", out, received)
	}
	requireCreditResponse(t, authRequest(t, b, "POST", "/api/credits/purchase-checkout", mustJSON(input), cookie), 200)
	if calls.Load() != 1 {
		t.Fatal("Creem replay created another checkout")
	}
	metadata := received["metadata"].(map[string]any)
	if metadata["userId"] != uid || metadata["type"] != "credit_purchase" || metadata["currency"] != "USD" {
		t.Fatalf("wrong fulfillment metadata %+v", metadata)
	}
	webhook := map[string]any{"id": "event-package", "eventType": "checkout.completed", "object": map[string]any{"id": "checkout-package", "metadata": metadata, "customer": map[string]any{"id": "customer-package"}, "order": map[string]any{"id": "trade-" + orderID, "amount": 1234, "currency": "USD"}}}
	body := []byte(mustJSON(webhook))
	mac := hmac.New(sha256.New, []byte("test-package-creem-secret"))
	mac.Write(body)
	headers := map[string]string{"creem-signature": hex.EncodeToString(mac.Sum(nil))}
	for i := 0; i < 2; i++ {
		requireCreditResponse(t, storageTestRequest(b, "POST", "/api/webhooks/creem", body, nil, headers), 200)
	}
	assertPackageCreditState(t, b, uid, orderID, 123)
}
func TestCreditPackageCheckoutGatesAndFailedRemotePersistence(t *testing.T) {
	b, uid, cookie := packageCheckoutFixture(t, "creem", "USD")
	requireCreditResponse(t, authRequest(t, b, "POST", "/api/credits/purchase-checkout", mustJSON(packageCheckoutInput(2)), cookie), 400)
	hidden := packageCheckoutInput(1)
	hidden["packageId"] = "hidden-package"
	requireCreditResponse(t, authRequest(t, b, "POST", "/api/credits/purchase-checkout", mustJSON(hidden), cookie), 400)
	injected := packageCheckoutInput(1)
	injected["userId"] = "other-user"
	requireCreditResponse(t, authRequest(t, b, "POST", "/api/credits/purchase-checkout", mustJSON(injected), cookie), 400)
	b.creemHTTPClient = &http.Client{Transport: creditPackageRoundTripper(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"id":"broken","checkout_url":"javascript:alert(1)"}`))}, nil
	})}
	in := packageCheckoutInput(1)
	requireCreditResponse(t, authRequest(t, b, "POST", "/api/credits/purchase-checkout", mustJSON(in), cookie), 502)
	var status string
	var failed, ready int
	if err := b.db.QueryRow(context.Background(), `SELECT status,(SELECT count(*) FROM payment_lifecycle_event WHERE payment_order_id=p.id AND event_type='checkout_failed'),(SELECT count(*) FROM payment_lifecycle_event WHERE payment_order_id=p.id AND event_type='checkout_ready') FROM payment_order p WHERE user_id=$1 AND client_request_id=$2`, uid, in["clientRequestId"]).Scan(&status, &failed, &ready); err != nil || status != "failed" || failed != 1 || ready != 0 {
		t.Fatalf("failed remote falsely ready: status=%s failed=%d ready=%d err=%v", status, failed, ready, err)
	}
	requireCreditResponse(t, authRequest(t, b, "POST", "/api/credits/purchase-checkout", mustJSON(in), cookie), 409)
}

func TestCreditPackageCheckoutUsesSingleDatabaseConnection(t *testing.T) {
	b, uid, _ := packageCheckoutFixture(t, "epay", "CNY")
	original := b.db
	config := original.Config()
	config.MaxConns = 1
	config.MinConns = 1
	single, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	b.db = single
	t.Cleanup(func() { b.db = original; single.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	input := creditPackageCheckoutInput{PackageID: "test-package", ClientRequestID: packageCheckoutInput(1)["clientRequestId"].(string), Locale: "en", Quantity: 1}
	out, err := b.createCreditPackageCheckout(ctx, uid, input)
	if err != nil || out["method"] != "POST" {
		t.Fatalf("single-connection checkout: %v %v", out, err)
	}
}

func TestCreditPackageCheckoutRepairsLegacyEpayReference(t *testing.T) {
	b, uid, cookie := packageCheckoutFixture(t, "epay", "CNY")
	input := packageCheckoutInput(1)
	first := requireCreditResponse(t, authRequest(t, b, "POST", "/api/credits/purchase-checkout", mustJSON(input), cookie), 200)
	id := first["orderId"].(string)
	outTrade := first["params"].(map[string]any)["out_trade_no"].(string)
	if _, err := b.db.Exec(context.Background(), `DELETE FROM epay_order WHERE out_trade_no=$1`, outTrade); err != nil {
		t.Fatal(err)
	}
	// Old pending orders stored only outTradeNo, never checkoutUrl/params.
	if _, err := b.db.Exec(context.Background(), `UPDATE payment_order SET provider_payload=json_build_object('outTradeNo',$2::text) WHERE id=$1`, id, outTrade); err != nil {
		t.Fatal(err)
	}
	replay := requireCreditResponse(t, authRequest(t, b, "POST", "/api/credits/purchase-checkout", mustJSON(input), cookie), 200)
	if replay["orderId"] != id || replay["method"] != "POST" || replay["params"].(map[string]any)["out_trade_no"] != outTrade {
		t.Fatalf("legacy replay lost reference %+v", replay)
	}
	var owner, orderID string
	if err := b.db.QueryRow(context.Background(), `SELECT user_id,metadata->>'paymentOrderId' FROM epay_order WHERE out_trade_no=$1`, outTrade).Scan(&owner, &orderID); err != nil || owner != uid || orderID != id {
		t.Fatalf("callback reference missing: %s %s %v", owner, orderID, err)
	}
}
