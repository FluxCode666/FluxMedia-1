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
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strings"
	"testing"
)

func signedAlipayWebhook(t *testing.T, b *backend, key *rsa.PrivateKey, fields map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	keys := make([]string, 0, len(fields))
	form := url.Values{}
	for key, value := range fields {
		keys = append(keys, key)
		form.Set(key, value)
	}
	sort.Strings(keys)
	values := make([]string, 0, len(keys))
	for _, key := range keys {
		values = append(values, key+"="+fields[key])
	}
	digest := sha256.Sum256([]byte(strings.Join(values, "&")))
	signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	form.Set("sign", base64.StdEncoding.EncodeToString(signature))
	form.Set("sign_type", "RSA2")
	r := httptest.NewRequest(http.MethodPost, "http://localhost:3000/api/webhooks/alipay", strings.NewReader(form.Encode()))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w := httptest.NewRecorder()
	b.handler().ServeHTTP(w, r)
	return w
}

func TestAlipayWebhookFirstPaymentWithNullTradeNumberAndReplay(t *testing.T) {
	b := integrationBackend(t)
	uid, _ := seedAuthUser(t, b)
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	publicKey, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	setStorageTestSetting(t, b, "ALIPAY_PUBLIC_KEY", string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: publicKey})))
	setStorageTestSetting(t, b, "ALIPAY_APP_ID", "webhook-test-app")
	setStorageTestSetting(t, b, "REFERRAL_REWARD_CONFIG", map[string]any{"enabled": false})
	orderID := newRequestID()
	tradeNo := "alipay-trade-" + newRequestID()
	_, err = b.db.Exec(context.Background(), `INSERT INTO payment_order(id,user_id,client_request_id,provider,purpose,status,currency,amount,amount_minor,credits_amount,pricing_snapshot) VALUES($1,$2,$1,'alipay_f2f','credit_top_up','pending','CNY',12.34,1234,98.76,'{}')`, orderID, uid)
	if err != nil {
		t.Fatal(err)
	}
	fields := map[string]string{"app_id": "webhook-test-app", "out_trade_no": orderID, "trade_no": tradeNo, "trade_status": "TRADE_SUCCESS", "total_amount": "12.34"}
	for attempt := 0; attempt < 2; attempt++ {
		w := signedAlipayWebhook(t, b, key, fields)
		if w.Code != http.StatusOK || w.Body.String() != "success" {
			t.Fatalf("valid first payment/replay attempt %d: %d %s", attempt, w.Code, w.Body.String())
		}
	}
	var status, persistedTrade string
	var balance, remaining float64
	var batches, transactions int
	if err := b.db.QueryRow(context.Background(), `SELECT status,provider_trade_no FROM payment_order WHERE id=$1`, orderID).Scan(&status, &persistedTrade); err != nil {
		t.Fatal(err)
	}
	if status != "fulfilled" || persistedTrade != tradeNo {
		var state string
		_ = b.db.QueryRow(context.Background(), `SELECT concat(status,':',attempt_count,':',last_error_code,':',next_attempt_at,':',now()) FROM payment_fulfillment_work_item WHERE payment_order_id=$1`, orderID).Scan(&state)
		t.Fatalf("payment was not fulfilled: status=%s trade=%s work=%s", status, persistedTrade, state)
	}
	if err := b.db.QueryRow(context.Background(), `SELECT balance,(SELECT COALESCE(sum(remaining),0) FROM credits_batch WHERE user_id=$1),(SELECT count(*) FROM credits_batch WHERE user_id=$1),(SELECT count(*) FROM credits_transaction WHERE user_id=$1) FROM credits_balance WHERE user_id=$1`, uid).Scan(&balance, &remaining, &batches, &transactions); err != nil {
		t.Fatal(err)
	}
	if balance != 98.76 || remaining != 98.76 || batches != 1 || transactions != 1 {
		t.Fatalf("payment replay changed the wallet: balance=%v remaining=%v batches=%d transactions=%d", balance, remaining, batches, transactions)
	}
	for _, change := range []struct{ field, value string }{{"trade_no", "different-trade"}, {"total_amount", "12.35"}, {"app_id", "different-app"}} {
		original := fields[change.field]
		fields[change.field] = change.value
		w := signedAlipayWebhook(t, b, key, fields)
		fields[change.field] = original
		if w.Code != http.StatusBadRequest {
			t.Fatalf("accepted mismatching %s: %d %s", change.field, w.Code, w.Body.String())
		}
	}
}
