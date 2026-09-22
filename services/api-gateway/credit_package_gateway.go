package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type creditPackageGateway struct{ Provider, BaseURL, APIKey, MerchantID, MerchantKey, SubmitURL, NotifyURL, PaymentType string }

func paymentCheckoutURL(raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.User != nil || strings.ContainsAny(raw, "\r\n") {
		return "", &apiError{503, "PROVIDER_NOT_CONFIGURED", "支付通道地址配置无效"}
	}
	return parsed.String(), nil
}
func (b *backend) readCreditPackageGateway(ctx context.Context, provider string) (creditPackageGateway, error) {
	cfg := creditPackageGateway{Provider: provider}
	base := b.config.publicAppURL
	if base == "" {
		base = b.config.authURL
	}
	var err error
	cfg.BaseURL, err = paymentCheckoutURL(strings.TrimRight(base, "/"))
	if err != nil {
		return cfg, err
	}
	values := map[string]string{}
	keys := []string{"CREEM_API_KEY", "CREEM_WEBHOOK_SECRET"}
	if provider == "epay" {
		keys = []string{"EPAY_PID", "EPAY_KEY", "EPAY_API_URL", "EPAY_NOTIFY_URL", "EPAY_DEFAULT_PAYMENT_TYPE"}
	}
	for _, key := range keys {
		v, e := b.settingString(ctx, key, "")
		if e != nil {
			return cfg, e
		}
		values[key] = strings.TrimSpace(v)
	}
	if provider == "creem" {
		if values["CREEM_API_KEY"] == "" || values["CREEM_WEBHOOK_SECRET"] == "" {
			return cfg, &apiError{503, "PROVIDER_NOT_CONFIGURED", "Creem 支付通道未完整配置，请填写 API Key 和 Webhook Secret"}
		}
		cfg.APIKey = values["CREEM_API_KEY"]
		return cfg, nil
	}
	if values["EPAY_PID"] == "" || values["EPAY_KEY"] == "" || values["EPAY_API_URL"] == "" {
		return cfg, &apiError{503, "PROVIDER_NOT_CONFIGURED", "易支付通道未完整配置，请填写商户 ID、密钥和网关地址"}
	}
	cfg.MerchantID, cfg.MerchantKey = values["EPAY_PID"], values["EPAY_KEY"]
	submit, e := paymentCheckoutURL(values["EPAY_API_URL"])
	if e != nil {
		return cfg, e
	}
	u, _ := url.Parse(submit)
	if u.RawQuery != "" || u.Fragment != "" {
		return cfg, &apiError{503, "PROVIDER_NOT_CONFIGURED", "易支付网关地址无效"}
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/submit.php"
	cfg.SubmitURL = u.String()
	notify := values["EPAY_NOTIFY_URL"]
	if notify == "" {
		notify = cfg.BaseURL + "/api/webhooks/epay"
	}
	cfg.NotifyURL, e = paymentCheckoutURL(notify)
	if e != nil {
		return cfg, e
	}
	cfg.PaymentType = values["EPAY_DEFAULT_PAYMENT_TYPE"]
	if cfg.PaymentType == "" {
		cfg.PaymentType = "alipay"
	}
	return cfg, nil
}
func buildCreditPackageEpayCheckout(cfg creditPackageGateway, order topUpCheckoutOrder) (map[string]any, error) {
	outTrade := stringValue(order.Payload["outTradeNo"])
	if outTrade == "" {
		outTrade = "CR" + order.ID
	}
	quantity := int(imageCreditValue(order.Snapshot["quantity"], 1))
	name := fmt.Sprintf("FluxMedia Credits %v", imageCreditValue(order.Snapshot["unitCredits"], order.CreditsAmount/float64(quantity)))
	if quantity > 1 {
		name += fmt.Sprintf(" x %d", quantity)
	}
	params := map[string]string{"pid": cfg.MerchantID, "type": cfg.PaymentType, "out_trade_no": outTrade, "notify_url": cfg.NotifyURL, "return_url": cfg.BaseURL + "/api/payments/epay/return", "name": name, "money": fmt.Sprintf("%d.%02d", order.AmountMinor/100, order.AmountMinor%100), "device": "pc", "sign_type": "MD5"}
	params["sign"] = epaySign(params, cfg.MerchantKey)
	return map[string]any{"outTradeNo": outTrade, "checkoutUrl": cfg.SubmitURL, "params": params}, nil
}
func (b *backend) createCreditPackageCreemCheckout(ctx context.Context, cfg creditPackageGateway, order topUpCheckoutOrder, resultURL string) (map[string]any, error) {
	failure := func() error {
		return &apiError{502, "PAYMENT_CHECKOUT_FAILED", "Creem 创建结账失败，请稍后重新购买"}
	}
	base := "https://api.creem.io/v1"
	if strings.HasPrefix(cfg.APIKey, "creem_test_") {
		base = "https://test-api.creem.io/v1"
	}
	metadata := map[string]string{"userId": order.UserID, "type": "credit_purchase", "paymentOrderId": order.ID, "credits": strconv.FormatFloat(order.CreditsAmount, 'f', -1, 64), "packageId": stringValue(order.Snapshot["packageId"]), "quantity": strconv.Itoa(int(imageCreditValue(order.Snapshot["quantity"], 1))), "unitPrice": strconv.FormatFloat(imageCreditValue(order.Snapshot["unitPrice"], order.Amount), 'f', -1, 64), "currency": order.Currency}
	product := stringValue(order.Snapshot["creemProductId"])
	if product == "" {
		product = "credits_" + metadata["packageId"]
	}
	body := mustJSON(map[string]any{"product_id": product, "success_url": resultURL, "request_id": "credit_purchase_" + order.ID, "metadata": metadata})
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/checkouts", strings.NewReader(body))
	if err != nil {
		return nil, failure()
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", cfg.APIKey)
	// Stable request_id is also sent as an HTTP idempotency key for gateway retries.
	digest := sha256.Sum256([]byte("credit_purchase_" + order.ID))
	req.Header.Set("Idempotency-Key", hex.EncodeToString(digest[:]))
	client := http.Client{Timeout: 15 * time.Second}
	if b.creemHTTPClient != nil {
		client = *b.creemHTTPClient
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	res, err := client.Do(req)
	if err != nil {
		return nil, failure()
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, (1<<20)+1))
	if err != nil || len(raw) > 1<<20 || res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, failure()
	}
	var checkout struct {
		ID  string `json:"id"`
		URL string `json:"checkout_url"`
	}
	if json.Unmarshal(raw, &checkout) != nil || strings.TrimSpace(checkout.ID) == "" || len(checkout.ID) > 512 || len(checkout.URL) > 8192 {
		return nil, failure()
	}
	checkoutURL, err := paymentCheckoutURL(checkout.URL)
	if err != nil {
		return nil, failure()
	}
	return map[string]any{"checkoutId": checkout.ID, "checkoutUrl": checkoutURL}, nil
}
