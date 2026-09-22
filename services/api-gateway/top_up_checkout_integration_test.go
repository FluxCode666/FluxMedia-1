//go:build integration

package main

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type topUpTestProvider struct {
	key      *rsa.PrivateKey
	calls    atomic.Int32
	mode     atomic.Int32
	block    atomic.Bool
	started  chan struct{}
	release  chan struct{}
	once     sync.Once
	requests chan map[string]any
}

func topUpTestID() string {
	id := newRequestID()
	return id[:8] + "-" + id[8:12] + "-4" + id[13:16] + "-a" + id[17:20] + "-" + id[20:]
}
func topUpTestConfig(rate float64) map[string]any {
	return map[string]any{"enabled": true, "defaultCurrency": "CNY", "currencies": []any{map[string]any{"currency": "CNY", "creditsPerMajorUnit": rate, "minAmountMinor": 100, "maxAmountMinor": 10000, "enabled": true, "providers": []string{"alipay_f2f"}}}}
}
func setupTopUpTestProvider(t *testing.T, b *backend) *topUpTestProvider {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	appKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	f := &topUpTestProvider{key: key, started: make(chan struct{}), release: make(chan struct{}), requests: make(chan map[string]any, 32)}
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.calls.Add(1)
		if err := r.ParseForm(); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		if r.Method != "POST" || r.Form.Get("method") != "alipay.trade.precreate" || r.Form.Get("app_id") != "checkout-app" || r.Form.Get("sign_type") != "RSA2" || r.Form.Get("notify_url") != "https://pay.example.test/api/webhooks/alipay" {
			t.Error("incorrect Alipay request envelope")
		}
		// Alipay's gateway signature includes sign_type and every non-empty
		// request parameter in ASCII key order, without URL escaping values.
		canonical := "app_id=" + r.Form.Get("app_id") + "&biz_content=" + r.Form.Get("biz_content") + "&charset=utf-8&format=JSON&method=alipay.trade.precreate&notify_url=" + r.Form.Get("notify_url") + "&sign_type=RSA2&timestamp=" + r.Form.Get("timestamp") + "&version=1.0"
		digest := sha256.Sum256([]byte(canonical))
		signature, err := base64.StdEncoding.DecodeString(r.Form.Get("sign"))
		if err != nil || rsa.VerifyPKCS1v15(&appKey.PublicKey, crypto.SHA256, digest[:], signature) != nil {
			t.Error("request RSA2 signature invalid")
		}
		var biz map[string]any
		if json.Unmarshal([]byte(r.Form.Get("biz_content")), &biz) != nil {
			t.Error("invalid biz_content")
		}
		f.requests <- biz
		if biz["total_amount"] != "12.34" || biz["timeout_express"] != "15m" || biz["seller_id"] != "seller-test" {
			t.Errorf("wrong frozen payment amount/config: %v", biz)
		}
		if f.block.Load() {
			f.once.Do(func() { close(f.started) })
			select {
			case <-f.release:
			case <-r.Context().Done():
				return
			}
		}
		orderID := stringValue(biz["out_trade_no"])
		code := "10000"
		if f.mode.Load() == 2 {
			code = "40004"
		}
		if f.mode.Load() == 3 {
			orderID = "foreign-order"
		}
		if f.mode.Load() == 4 {
			orderID = ""
		}
		body := []byte(fmt.Sprintf("{\n  \"code\": %q, \"msg\": \"Success\", \"out_trade_no\": %q, \"qr_code\": \"https://qr.alipay.com/test-signed-code\"\n}", code, orderID))
		digest = sha256.Sum256(body)
		signature, _ = rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
		if f.mode.Load() == 1 {
			signature[0] ^= 1
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"alipay_trade_precreate_response":%s,"sign":%q}`, body, base64.StdEncoding.EncodeToString(signature))
	}))
	t.Cleanup(server.Close)
	b.alipayHTTPClient = server.Client()
	private, _ := x509.MarshalPKCS8PrivateKey(appKey)
	public, _ := x509.MarshalPKIXPublicKey(&key.PublicKey)
	for k, v := range map[string]any{"ALIPAY_F2F_ENABLED": true, "ALIPAY_APP_ID": "checkout-app", "ALIPAY_PRIVATE_KEY": base64.StdEncoding.EncodeToString(private), "ALIPAY_PUBLIC_KEY": string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: public})), "ALIPAY_SELLER_ID": "seller-test", "ALIPAY_GATEWAY": server.URL, "ALIPAY_NOTIFY_URL": "https://pay.example.test", "ALIPAY_F2F_TIMEOUT_MINUTES": 15, "CREDITS_EXPIRY_DAYS": 7, "CREDIT_TOP_UP_CONFIG": topUpTestConfig(7.125), "REFERRAL_REWARD_CONFIG": map[string]any{"enabled": false}} {
		setStorageTestSetting(t, b, k, v)
	}
	return f
}
func topUpTestInput() map[string]any {
	return map[string]any{"clientRequestId": topUpTestID(), "currency": "cny", "amountMinor": 1234, "provider": "alipay_f2f"}
}
func topUpHTTPView(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	if w.Code != 200 {
		t.Fatalf("checkout status %d: %s", w.Code, w.Body.String())
	}
	var result map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestTopUpCheckoutSignedProviderConcurrentReplayAndFrozenFulfillment(t *testing.T) {
	b := integrationBackend(t)
	ctx := context.Background()
	uid, email := seedAuthUser(t, b)
	cookie := signInTestUser(t, b, email)
	f := setupTopUpTestProvider(t, b)
	f.block.Store(true)
	input := topUpTestInput()
	path := "/api/credits/top-up/checkout"
	completed := make(chan *httptest.ResponseRecorder, 1)
	go func() { completed <- authRequest(t, b, "POST", path, mustJSON(input), cookie) }()
	select {
	case <-f.started:
	case <-time.After(10 * time.Second):
		t.Fatal("provider was not called")
	}
	released := false
	defer func() {
		if !released {
			close(f.release)
		}
	}()
	concurrent := topUpHTTPView(t, authRequest(t, b, "POST", path, mustJSON(input), cookie))
	if concurrent["status"] != "creating" || concurrent["qrCode"] != nil || f.calls.Load() != 1 {
		t.Fatalf("concurrent request duplicated provider call: %v", concurrent)
	}
	close(f.release)
	released = true
	first := topUpHTTPView(t, <-completed)
	id := first["orderId"].(string)
	if first["status"] != "pending" || first["amount"] != 12.34 || first["amountMinor"] != float64(1234) || first["creditsAmount"] != 87.92 || first["qrCode"] != "https://qr.alipay.com/test-signed-code" || first["expiresAt"] == nil {
		t.Fatalf("wrong checkout: %v", first)
	}
	var minor int64
	var amount, credits float64
	var snapshot []byte
	if err := b.db.QueryRow(ctx, `SELECT amount_minor,amount,credits_amount,pricing_snapshot FROM payment_order WHERE id=$1`, id).Scan(&minor, &amount, &credits, &snapshot); err != nil {
		t.Fatal(err)
	}
	if minor != 1234 || amount != 12.34 || credits != 87.92 || !strings.Contains(string(snapshot), "creditsExpiresAt") {
		t.Fatalf("bad durable quote %d %v %v %s", minor, amount, credits, snapshot)
	}
	setStorageTestSetting(t, b, "CREDIT_TOP_UP_CONFIG", topUpTestConfig(99))
	repeat := topUpHTTPView(t, authRequest(t, b, "POST", path, mustJSON(input), cookie))
	if repeat["orderId"] != id || repeat["creditsAmount"] != 87.92 || f.calls.Load() != 1 {
		t.Fatal("replay reread current price or duplicated precreate")
	}
	conflict := map[string]any{}
	for k, v := range input {
		conflict[k] = v
	}
	conflict["amountMinor"] = 1235
	if w := authRequest(t, b, "POST", path, mustJSON(conflict), cookie); w.Code != 409 {
		t.Fatalf("mismatched replay %d", w.Code)
	}
	_, otherEmail := seedAuthUser(t, b)
	otherCookie := signInTestUser(t, b, otherEmail)
	if w := authRequest(t, b, "POST", "/api/credits/top-up/order-status", mustJSON(map[string]any{"orderId": id}), otherCookie); w.Code != 404 {
		t.Fatalf("foreign order leaked: %d", w.Code)
	}
	if _, err := b.db.Exec(ctx, `UPDATE payment_order SET expires_at=now()-interval '1 second' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	display := topUpHTTPView(t, authRequest(t, b, "POST", "/api/credits/payment/status", mustJSON(map[string]any{"orderId": id}), cookie))
	if display["status"] != "expired" || display["qrCode"] != nil {
		t.Fatal("expired order remained payable")
	}
	// A delayed, signed payment remains fulfillable from the original snapshot.
	fields := map[string]string{"app_id": "checkout-app", "seller_id": "seller-test", "out_trade_no": id, "trade_no": "trade-" + newRequestID(), "trade_status": "TRADE_SUCCESS", "total_amount": "12.34"}
	// Valid provider signatures alone cannot authorize another merchant,
	// currency, purpose, or amount. No rejected notification may issue credits.
	setStorageTestSetting(t, b, "ALIPAY_PUBLIC_KEY", base64.StdEncoding.EncodeToString(x509.MarshalPKCS1PublicKey(&f.key.PublicKey)))
	for _, change := range []struct{ field, value string }{{"app_id", "another-app"}, {"seller_id", "another-seller"}, {"seller_id", ""}, {"total_amount", "12.35"}, {"total_amount", "12.xx"}} {
		original := fields[change.field]
		fields[change.field] = change.value
		w := signedAlipayWebhook(t, b, f.key, fields)
		fields[change.field] = original
		if w.Code != 400 {
			t.Fatalf("accepted signed wrong %s: %d %s", change.field, w.Code, w.Body.String())
		}
	}
	for _, change := range []struct{ column, value, original string }{{"currency", "USD", "CNY"}, {"purpose", "credit_package", "credit_top_up"}} {
		if _, err := b.db.Exec(ctx, `UPDATE payment_order SET `+change.column+`=$2 WHERE id=$1`, id, change.value); err != nil {
			t.Fatal(err)
		}
		w := signedAlipayWebhook(t, b, f.key, fields)
		if _, err := b.db.Exec(ctx, `UPDATE payment_order SET `+change.column+`=$2 WHERE id=$1`, id, change.original); err != nil {
			t.Fatal(err)
		}
		if w.Code != 400 {
			t.Fatalf("accepted signed wrong %s: %d", change.column, w.Code)
		}
	}
	b.config.cronSecret = "topup-cron-test"
	internal := httptest.NewRequest("POST", "/api/internal/payment-fulfillment/alipay", strings.NewReader(mustJSON(map[string]any{"outTradeNo": id, "tradeNo": fields["trade_no"], "tradeStatus": "TRADE_SUCCESS", "totalAmount": "12.34", "appId": "checkout-app", "sellerId": "another-seller"})))
	internal.Header.Set("Authorization", "Bearer topup-cron-test")
	internalResponse := httptest.NewRecorder()
	b.handler().ServeHTTP(internalResponse, internal)
	if internalResponse.Code != 400 {
		t.Fatalf("internal merchant validation %d %s", internalResponse.Code, internalResponse.Body.String())
	}
	var beforeBalance float64
	if err := b.db.QueryRow(ctx, `SELECT COALESCE((SELECT balance FROM credits_balance WHERE user_id=$1),0)`, uid).Scan(&beforeBalance); err != nil || beforeBalance != 0 {
		t.Fatalf("rejected callback issued credits %v %v", beforeBalance, err)
	}
	for range 2 {
		w := signedAlipayWebhook(t, b, f.key, fields)
		if w.Code != 200 || w.Body.String() != "success" {
			t.Fatalf("payment callback %d %s", w.Code, w.Body.String())
		}
	}
	var balance float64
	var batches int
	if err := b.db.QueryRow(ctx, `SELECT balance,(SELECT count(*) FROM credits_batch WHERE user_id=$1) FROM credits_balance WHERE user_id=$1`, uid).Scan(&balance, &batches); err != nil {
		t.Fatal(err)
	}
	if balance != 87.92 || batches != 1 {
		t.Fatalf("frozen/replayed credits %v batches %d", balance, batches)
	}
	var expiryRetained bool
	if err := b.db.QueryRow(ctx, `SELECT bool_and(expires_at>now()+interval '6 days' AND expires_at<now()+interval '8 days') FROM credits_batch WHERE user_id=$1`, uid).Scan(&expiryRetained); err != nil || !expiryRetained {
		t.Fatalf("frozen credits expiry was lost: %t %v", expiryRetained, err)
	}
	var events int
	if err := b.db.QueryRow(ctx, `SELECT count(*) FROM payment_lifecycle_event WHERE payment_order_id=$1 AND event_type IN ('order_created','checkout_ready')`, id).Scan(&events); err != nil || events != 2 {
		t.Fatalf("checkout events %d %v", events, err)
	}
	final := topUpHTTPView(t, authRequest(t, b, "POST", "/api/credits/payment/status", mustJSON(map[string]any{"orderId": id}), cookie))
	if final["status"] != "fulfilled" || final["fulfilledAt"] == nil {
		t.Fatal("fulfilled display did not override expiration")
	}
}

func TestTopUpCheckoutRejectsUnsignedFailedOrForeignProviderReplies(t *testing.T) {
	b := integrationBackend(t)
	_, email := seedAuthUser(t, b)
	cookie := signInTestUser(t, b, email)
	f := setupTopUpTestProvider(t, b)
	for _, mode := range []int32{1, 2, 3, 4} {
		f.mode.Store(mode)
		input := topUpTestInput()
		w := authRequest(t, b, "POST", "/api/credits/top-up/checkout", mustJSON(input), cookie)
		if w.Code != 502 || strings.Contains(w.Body.String(), "qr.alipay.com") {
			t.Fatalf("unsafe provider reply %d: %d %s", mode, w.Code, w.Body.String())
		}
		var status string
		var events int
		if err := b.db.QueryRow(context.Background(), `SELECT status,(SELECT count(*) FROM payment_lifecycle_event WHERE payment_order_id=p.id AND event_type='checkout_failed') FROM payment_order p WHERE client_request_id=$1`, input["clientRequestId"]).Scan(&status, &events); err != nil {
			t.Fatal(err)
		}
		if status != "failed" || events != 1 {
			t.Fatalf("failure not durable: %s %d", status, events)
		}
		before := f.calls.Load()
		w = authRequest(t, b, "POST", "/api/credits/top-up/checkout", mustJSON(input), cookie)
		if w.Code != 409 || f.calls.Load() != before {
			t.Fatal("failed request retried provider")
		}
	}
}

func TestTopUpCheckoutConfigurationGatesAndCreationLeaseRecovery(t *testing.T) {
	b := integrationBackend(t)
	ctx := context.Background()
	uid, email := seedAuthUser(t, b)
	cookie := signInTestUser(t, b, email)
	f := setupTopUpTestProvider(t, b)
	options := topUpHTTPView(t, authRequest(t, b, "GET", "/api/credits/top-up/options", "", cookie))
	if options["enabled"] != true {
		t.Fatal("configured channel hidden")
	}
	setStorageTestSetting(t, b, "ALIPAY_F2F_ENABLED", false)
	options = topUpHTTPView(t, authRequest(t, b, "GET", "/api/credits/top-up/options", "", cookie))
	if options["enabled"] != false || len(options["currencies"].([]any)) != 0 {
		t.Fatal("disabled channel displayed")
	}
	if w := authRequest(t, b, "POST", "/api/credits/top-up/checkout", mustJSON(topUpTestInput()), cookie); w.Code != 503 {
		t.Fatalf("disabled channel accepted %d", w.Code)
	}
	setStorageTestSetting(t, b, "ALIPAY_F2F_ENABLED", true)
	for _, change := range []struct {
		field string
		value any
	}{{"amountMinor", 99}, {"amountMinor", 10001}, {"currency", "USD"}, {"clientRequestId", "not-a-uuid"}} {
		in := topUpTestInput()
		in[change.field] = change.value
		if w := authRequest(t, b, "POST", "/api/credits/top-up/checkout", mustJSON(in), cookie); w.Code != 400 {
			t.Fatalf("invalid %s status %d", change.field, w.Code)
		}
	}
	setStorageTestSetting(t, b, "CREDIT_TOP_UP_CONFIG", map[string]any{"enabled": false})
	if w := authRequest(t, b, "POST", "/api/credits/top-up/checkout", mustJSON(topUpTestInput()), cookie); w.Code != 400 {
		t.Fatal("disabled topup accepted")
	}
	setStorageTestSetting(t, b, "CREDIT_TOP_UP_CONFIG", topUpTestConfig(7.125))
	for _, days := range []string{"NaN", "+Inf", "-Inf"} {
		setStorageTestSetting(t, b, "CREDITS_EXPIRY_DAYS", days)
		if w := authRequest(t, b, "POST", "/api/credits/top-up/checkout", mustJSON(topUpTestInput()), cookie); w.Code != 400 {
			t.Fatalf("invalid credits expiry %s accepted: %d", days, w.Code)
		}
	}
	setStorageTestSetting(t, b, "CREDITS_EXPIRY_DAYS", 7)
	if f.calls.Load() != 0 {
		t.Fatal("configuration rejection called provider")
	}
	input := topUpTestInput()
	id := "ATrecovery" + newRequestID()
	if _, err := b.db.Exec(ctx, `INSERT INTO payment_order(id,user_id,client_request_id,provider,purpose,status,currency,amount,amount_minor,credits_amount,pricing_snapshot,provider_payload,expires_at,updated_at) VALUES($1,$2,$3,'alipay_f2f','credit_top_up','creating','CNY',12.34,1234,87.92,$4,$5,NULL,now()-interval '31 seconds')`, id, uid, input["clientRequestId"], mustJSON(map[string]any{"currency": "CNY", "amountMinor": 1234, "creditsAmount": 87.92, "creditsPerMajorUnit": 7.125, "creditsExpiresAt": nil, "provider": "alipay_f2f"}), mustJSON(map[string]any{"checkoutLeaseToken": "crashed-worker", "merchantAppId": "checkout-app"})); err != nil {
		t.Fatal(err)
	}
	stale, err := readTopUpCheckoutOrder(ctx, b.db, "id=$1", id)
	if err != nil {
		t.Fatal(err)
	}
	recovered := topUpHTTPView(t, authRequest(t, b, "POST", "/api/credits/top-up/checkout", mustJSON(input), cookie))
	if recovered["orderId"] != id || recovered["status"] != "pending" || f.calls.Load() != 1 {
		t.Fatalf("lease not reclaimed: %v", recovered)
	}
	if _, err := b.finishTopUpCheckout(ctx, stale, "crashed-worker", "", false); err != nil {
		t.Fatal(err)
	}
	current, err := readTopUpCheckoutOrder(ctx, b.db, "id=$1", id)
	if err != nil || current.Status != "pending" {
		t.Fatal("stale worker overwrote ready checkout")
	}
	if current.ExpiresAt == nil || current.ExpiresAt.Before(time.Now().Add(14*time.Minute)) || current.ExpiresAt.After(time.Now().Add(16*time.Minute)) {
		t.Fatal("legacy creation recovery did not persist checkout expiry")
	}
	if got := <-f.requests; got["out_trade_no"] != id {
		t.Fatal("recovery changed merchant order identity")
	}
}
