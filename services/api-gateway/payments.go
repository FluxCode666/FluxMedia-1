package main

import (
	"context"
	"crypto"
	"crypto/hmac"
	"crypto/md5"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
)

func (b *backend) paymentSetting(ctx context.Context, key string) string {
	v, _ := b.settingString(ctx, key, "")
	return strings.TrimSpace(v)
}
func parsePaymentParams(r *http.Request) (map[string]string, error) {
	out := map[string]string{}
	if r.Method == http.MethodGet {
		for k, v := range r.URL.Query() {
			if len(v) > 0 {
				out[k] = v[0]
			}
		}
		return out, nil
	}
	if err := r.ParseForm(); err != nil {
		return nil, invalid("invalid payment form")
	}
	for k, v := range r.PostForm {
		if len(v) > 0 {
			out[k] = v[0]
		}
	}
	return out, nil
}
func epaySign(params map[string]string, key string) string {
	keys := make([]string, 0, len(params))
	for k, v := range params {
		if k != "sign" && k != "sign_type" && v != "" {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	var s strings.Builder
	for i, k := range keys {
		if i > 0 {
			s.WriteByte('&')
		}
		fmt.Fprintf(&s, "%s=%s", k, params[k])
	}
	sum := md5.Sum([]byte(s.String() + key))
	return hex.EncodeToString(sum[:])
}
func timingEq(a, b string) bool {
	return hmac.Equal([]byte(strings.ToLower(a)), []byte(strings.ToLower(b)))
}
func (b *backend) verifyEpay(ctx context.Context, p map[string]string) bool {
	key := b.paymentSetting(ctx, "EPAY_KEY")
	if key == "" {
		return false
	}
	return timingEq(p["sign"], epaySign(p, key))
}
func (b *backend) handleEpayReturn(w http.ResponseWriter, r *http.Request) error {
	p, err := parsePaymentParams(r)
	if err != nil {
		return err
	}
	base := strings.TrimRight(b.config.authURL, "/")
	if !b.verifyEpay(r.Context(), p) {
		http.Redirect(w, r, base+"/dashboard/wallet?payment=fail", http.StatusFound)
		return nil
	}
	out := p["out_trade_no"]
	status := "pending"
	var st string
	_ = b.db.QueryRow(r.Context(), `SELECT status FROM epay_order WHERE out_trade_no=$1`, out).Scan(&st)
	switch st {
	case "success":
		status = "success"
	case "failed":
		status = "fail"
	case "fulfilling":
		status = "processing"
	default:
		if p["trade_status"] == "TRADE_SUCCESS" {
			status = "processing"
		}
	}
	var meta []byte
	_ = b.db.QueryRow(r.Context(), `SELECT metadata FROM epay_order WHERE out_trade_no=$1`, out).Scan(&meta)
	var m map[string]any
	_ = json.Unmarshal(meta, &m)
	if id, ok := m["paymentOrderId"].(string); ok && id != "" {
		loc := "en"
		if m["locale"] == "zh" {
			loc = "zh"
		}
		http.Redirect(w, r, fmt.Sprintf("%s/%s/dashboard/credits/payment/%s?pay=%s", base, loc, url.PathEscape(id), status), http.StatusFound)
		return nil
	}
	http.Redirect(w, r, base+"/dashboard/wallet?payment="+status, http.StatusFound)
	return nil
}

func (b *backend) fulfillCredit(ctx context.Context, orderID, provider, tradeNo, sourceRef string, amount float64, metadata map[string]any) error {
	if tradeNo == "" {
		return invalid("渠道交易号不能为空")
	}
	var userID string
	if err := b.db.QueryRow(ctx, `SELECT user_id FROM payment_order WHERE id=$1 AND provider=$2`, orderID, provider).Scan(&userID); err != nil {
		return err
	}
	if _, err := b.confirmPaymentWorkItem(ctx, orderID, provider, userID, tradeNo, provider+":"+tradeNo, sourceRef, metadata); err != nil {
		return err
	}
	status, err := b.processPaymentOrder(ctx, orderID)
	if err != nil {
		return err
	}
	if status == "failed_terminal" {
		return &apiError{409, "PAYMENT_FULFILLMENT_FAILED", "支付履约失败"}
	}
	return nil
}

func (b *backend) handleEpayWebhook(w http.ResponseWriter, r *http.Request) error {
	p, err := parsePaymentParams(r)
	if err != nil {
		return err
	}
	if !b.verifyEpay(r.Context(), p) || p["out_trade_no"] == "" {
		w.WriteHeader(200)
		_, _ = w.Write([]byte("fail"))
		return nil
	}
	if p["trade_status"] != "TRADE_SUCCESS" {
		_, _ = w.Write([]byte("success"))
		return nil
	}
	var metaRaw []byte
	var orderID string
	_ = b.db.QueryRow(r.Context(), `SELECT metadata FROM epay_order WHERE out_trade_no=$1`, p["out_trade_no"]).Scan(&metaRaw)
	var m map[string]any
	_ = json.Unmarshal(metaRaw, &m)
	if v, ok := m["paymentOrderId"].(string); ok {
		orderID = v
	}
	if orderID == "" {
		orderID = p["out_trade_no"]
	}
	if err := b.validateEpayWebhook(r.Context(), orderID, p["out_trade_no"], p["trade_no"], p["money"], m); err != nil {
		_, _ = w.Write([]byte("fail"))
		return nil
	}
	if err := b.fulfillCredit(r.Context(), orderID, "epay", p["trade_no"], "epay:"+p["out_trade_no"], 0, m); err != nil {
		_, _ = w.Write([]byte("fail"))
		return nil
	}
	_, _ = w.Write([]byte("success"))
	return nil
}

func (b *backend) handleCreemWebhook(w http.ResponseWriter, r *http.Request) error {
	body, err := io.ReadAll(io.LimitReader(r.Body, b.config.maxBodyBytes))
	if err != nil {
		return err
	}
	sig := r.Header.Get("creem-signature")
	secret := b.paymentSetting(r.Context(), "CREEM_WEBHOOK_SECRET")
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	if secret == "" || !timingEq(hex.EncodeToString(mac.Sum(nil)), sig) {
		return &apiError{400, "INVALID_SIGNATURE", "Webhook signature invalid"}
	}
	var ev struct {
		ID        string `json:"id"`
		EventType string `json:"eventType"`
		CreatedAt int64  `json:"created_at"`
		Object    struct {
			ID        string `json:"id"`
			RequestID string `json:"request_id"`
			Customer  struct {
				ID string `json:"id"`
			} `json:"customer"`
			Metadata map[string]string `json:"metadata"`
			Order    struct {
				ID       string  `json:"id"`
				Amount   float64 `json:"amount"`
				Currency string  `json:"currency"`
			} `json:"order"`
		} `json:"object"`
	}
	if json.Unmarshal(body, &ev) != nil {
		return &apiError{400, "INVALID_REQUEST", "Invalid webhook payload"}
	}
	if ev.EventType == "checkout.completed" && ev.Object.Metadata["type"] == "credit_purchase" {
		m := map[string]any{"checkoutId": ev.Object.ID, "customerId": ev.Object.Customer.ID}
		for k, v := range ev.Object.Metadata {
			m[k] = v
		}
		id := ev.Object.Metadata["paymentOrderId"]
		if id != "" {
			if err := b.validateCreemWebhookAmount(r.Context(), id, ev.Object.Order.Amount, ev.Object.Order.Currency); err != nil {
				return err
			}
			if err := b.fulfillCredit(r.Context(), id, "creem", ev.Object.Order.ID, "creem:"+id, ev.Object.Order.Amount, m); err != nil {
				return err
			}
		}
	}
	writeJSON(w, 200, map[string]any{"received": true})
	return nil
}

func (b *backend) handleAlipayWebhook(w http.ResponseWriter, r *http.Request) error {
	p, err := parsePaymentParams(r)
	if err != nil {
		return err
	}
	if p["trade_status"] != "TRADE_SUCCESS" && p["trade_status"] != "TRADE_FINISHED" {
		return &apiError{400, "INVALID_REQUEST", "交易未完成"}
	}
	if !b.verifyAlipaySignature(r.Context(), p) {
		return &apiError{400, "INVALID_SIGNATURE", "支付宝签名无效"}
	}
	app := b.paymentSetting(r.Context(), "ALIPAY_APP_ID")
	if app != "" && p["app_id"] != app {
		return &apiError{400, "INVALID_REQUEST", "App ID 不匹配"}
	}
	order := p["out_trade_no"]
	if order == "" {
		return invalid("out_trade_no required")
	}
	var expected int64
	var trade string
	var provider string
	if err := b.db.QueryRow(r.Context(), `SELECT amount_minor,provider_trade_no,provider FROM payment_order WHERE id=$1`, order).Scan(&expected, &trade, &provider); err != nil || provider != "alipay_f2f" {
		return &apiError{400, "INVALID_REQUEST", "订单不存在"}
	}
	if trade != "" && trade != p["trade_no"] {
		return &apiError{400, "INVALID_REQUEST", "交易号不匹配"}
	}
	paid := parseMinor(p["total_amount"])
	if paid < 0 || paid != expected {
		return &apiError{400, "INVALID_REQUEST", "金额不匹配"}
	}
	// The local order ID is the stable source reference used by the original
	// Alipay top-up service; gateway trade numbers are provider evidence only.
	if err := b.fulfillCredit(r.Context(), order, "alipay_f2f", p["trade_no"], "alipay:"+order, 0, map[string]any{"provider": "alipay_f2f", "tradeNo": p["trade_no"]}); err != nil {
		return err
	}
	_, _ = w.Write([]byte("success"))
	return nil
}

func (b *backend) verifyAlipaySignature(ctx context.Context, p map[string]string) bool {
	key := strings.TrimSpace(b.paymentSetting(ctx, "ALIPAY_PUBLIC_KEY"))
	sig := strings.TrimSpace(p["sign"])
	if key == "" || sig == "" {
		return false
	}
	key = strings.ReplaceAll(key, `\n`, "\n")
	if !strings.Contains(key, "BEGIN") {
		key = "-----BEGIN PUBLIC KEY-----\n" + key + "\n-----END PUBLIC KEY-----"
	}
	block, _ := pem.Decode([]byte(key))
	if block == nil {
		return false
	}
	pub, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		if pk, e := x509.ParsePKCS1PublicKey(block.Bytes); e == nil {
			pub = pk
		} else {
			return false
		}
	}
	rsaPub, ok := pub.(*rsa.PublicKey)
	if !ok {
		return false
	}
	keys := make([]string, 0, len(p))
	for k, v := range p {
		if k != "sign" && k != "sign_type" && v != "" {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	var s strings.Builder
	for i, k := range keys {
		if i > 0 {
			s.WriteByte('&')
		}
		fmt.Fprintf(&s, "%s=%s", k, p[k])
	}
	raw, err := base64.StdEncoding.DecodeString(sig)
	if err != nil {
		return false
	}
	digest := sha256.Sum256([]byte(s.String()))
	return rsa.VerifyPKCS1v15(rsaPub, crypto.SHA256, digest[:], raw) == nil
}
func parseMinor(s string) int64 {
	f := strings.Split(strings.TrimSpace(s), ".")
	if len(f) > 2 {
		return -1
	}
	frac := ""
	if len(f) == 2 {
		frac = f[1]
		if len(frac) > 2 {
			return -1
		}
	}
	for len(frac) < 2 {
		frac += "0"
	}
	n, err := strconv.ParseInt(f[0], 10, 64)
	if err != nil || n < 0 {
		return -1
	}
	q, _ := strconv.ParseInt(frac, 10, 64)
	return n*100 + q
}
