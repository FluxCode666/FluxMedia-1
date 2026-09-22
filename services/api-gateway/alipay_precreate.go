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
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

type alipayCheckoutConfig struct {
	AppID, SellerID, Gateway, NotifyURL string
	PrivateKey                          *rsa.PrivateKey
	PublicKey                           *rsa.PublicKey
	TimeoutMinutes                      int
}

func (b *backend) validateAlipayMerchant(ctx context.Context, appID, sellerID string) error {
	app, err := b.settingString(ctx, "ALIPAY_APP_ID", "")
	if err != nil {
		return err
	}
	seller, err := b.settingString(ctx, "ALIPAY_SELLER_ID", "")
	if err != nil {
		return err
	}
	if strings.TrimSpace(app) == "" || appID != strings.TrimSpace(app) {
		return invalid("支付宝回调 App ID 不匹配")
	}
	if strings.TrimSpace(seller) != "" && sellerID != strings.TrimSpace(seller) {
		return invalid("支付宝回调卖家 PID 不匹配")
	}
	return nil
}

func alipayCheckoutKeyBytes(value string) ([]byte, error) {
	value = strings.TrimSpace(strings.ReplaceAll(value, `\n`, "\n"))
	if strings.Contains(value, "-----BEGIN") {
		block, rest := pem.Decode([]byte(value))
		if block != nil && strings.TrimSpace(string(rest)) == "" {
			return block.Bytes, nil
		}
		return nil, invalid("支付宝密钥格式无效")
	}
	data, err := base64.StdEncoding.DecodeString(strings.Join(strings.Fields(value), ""))
	if err != nil {
		return nil, invalid("支付宝密钥格式无效")
	}
	return data, nil
}
func parseAlipayCheckoutPrivateKey(value string) (*rsa.PrivateKey, error) {
	data, err := alipayCheckoutKeyBytes(value)
	if err != nil {
		return nil, err
	}
	key, err := x509.ParsePKCS1PrivateKey(data)
	if err != nil {
		raw, e := x509.ParsePKCS8PrivateKey(data)
		if e == nil {
			key, _ = raw.(*rsa.PrivateKey)
		}
	}
	if key == nil || key.Validate() != nil {
		return nil, invalid("支付宝应用私钥无效")
	}
	return key, nil
}
func parseAlipayCheckoutPublicKey(value string) (*rsa.PublicKey, error) {
	data, err := alipayCheckoutKeyBytes(value)
	if err != nil {
		return nil, err
	}
	raw, err := x509.ParsePKIXPublicKey(data)
	if err == nil {
		if key, ok := raw.(*rsa.PublicKey); ok {
			return key, nil
		}
	}
	if key, err := x509.ParsePKCS1PublicKey(data); err == nil {
		return key, nil
	}
	if cert, err := x509.ParseCertificate(data); err == nil {
		if key, ok := cert.PublicKey.(*rsa.PublicKey); ok {
			return key, nil
		}
	}
	return nil, invalid("支付宝公钥无效")
}
func (b *backend) readAlipayCheckoutConfig(ctx context.Context) (alipayCheckoutConfig, error) {
	cfg := alipayCheckoutConfig{}
	unavailable := func() (alipayCheckoutConfig, error) {
		return cfg, &apiError{503, "PAYMENT_PROVIDER_UNAVAILABLE", "支付宝当面付暂未配置或未开启"}
	}
	enabled, err := b.settingBool(ctx, "ALIPAY_F2F_ENABLED", false)
	if err != nil {
		return cfg, err
	}
	if !enabled {
		return unavailable()
	}
	values := map[string]string{}
	for _, key := range []string{"ALIPAY_APP_ID", "ALIPAY_PRIVATE_KEY", "ALIPAY_PUBLIC_KEY", "ALIPAY_SELLER_ID", "ALIPAY_GATEWAY", "ALIPAY_NOTIFY_URL"} {
		value, err := b.settingString(ctx, key, "")
		if err != nil {
			return cfg, err
		}
		values[key] = strings.TrimSpace(value)
	}
	cfg.AppID, cfg.SellerID = values["ALIPAY_APP_ID"], values["ALIPAY_SELLER_ID"]
	if cfg.AppID == "" {
		return unavailable()
	}
	cfg.PrivateKey, err = parseAlipayCheckoutPrivateKey(values["ALIPAY_PRIVATE_KEY"])
	if err != nil {
		return unavailable()
	}
	cfg.PublicKey, err = parseAlipayCheckoutPublicKey(values["ALIPAY_PUBLIC_KEY"])
	if err != nil {
		return unavailable()
	}
	gateway := values["ALIPAY_GATEWAY"]
	if gateway == "" {
		gateway = "https://openapi.alipay.com/gateway.do"
	}
	parsed, err := url.Parse(gateway)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" {
		return unavailable()
	}
	cfg.Gateway = parsed.String()
	notify := values["ALIPAY_NOTIFY_URL"]
	if notify == "" {
		notify = b.config.publicAppURL
		if notify == "" {
			notify = b.config.authURL
		}
	}
	parsed, err = url.Parse(notify)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.User != nil || parsed.Fragment != "" {
		return unavailable()
	}
	if values["ALIPAY_NOTIFY_URL"] == "" || parsed.Path == "" || parsed.Path == "/" {
		parsed.Path = "/api/webhooks/alipay"
	}
	cfg.NotifyURL = parsed.String()
	timeout, err := b.setting(ctx, "ALIPAY_F2F_TIMEOUT_MINUTES", 30)
	if err != nil {
		return cfg, err
	}
	cfg.TimeoutMinutes = int(topUpPositive(timeout, 30, 1440))
	if cfg.TimeoutMinutes < 1 {
		cfg.TimeoutMinutes = 1
	}
	return cfg, nil
}
func alipayCheckoutSignContent(params url.Values) string {
	keys := []string{}
	for key := range params {
		if key != "sign" && params.Get(key) != "" {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, key+"="+params.Get(key))
	}
	return strings.Join(parts, "&")
}
func (b *backend) precreateAlipayOrder(ctx context.Context, cfg alipayCheckoutConfig, order topUpCheckoutOrder) (string, error) {
	failure := func() (string, error) {
		return "", &apiError{502, "PAYMENT_CHECKOUT_FAILED", "支付宝预下单失败，请重新发起充值"}
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	biz := map[string]any{"out_trade_no": order.ID, "total_amount": fmt.Sprintf("%d.%02d", order.AmountMinor/100, order.AmountMinor%100), "subject": fmt.Sprintf("FluxMedia 充值 %.2f Credits", order.CreditsAmount), "timeout_express": fmt.Sprintf("%dm", cfg.TimeoutMinutes)}
	if cfg.SellerID != "" {
		biz["seller_id"] = cfg.SellerID
	}
	params := url.Values{"app_id": {cfg.AppID}, "method": {"alipay.trade.precreate"}, "format": {"JSON"}, "charset": {"utf-8"}, "sign_type": {"RSA2"}, "timestamp": {time.Now().In(time.FixedZone("CST", 8*3600)).Format("2006-01-02 15:04:05")}, "version": {"1.0"}, "notify_url": {cfg.NotifyURL}, "biz_content": {mustJSON(biz)}}
	digest := sha256.Sum256([]byte(alipayCheckoutSignContent(params)))
	signature, err := rsa.SignPKCS1v15(rand.Reader, cfg.PrivateKey, crypto.SHA256, digest[:])
	if err != nil {
		return failure()
	}
	params.Set("sign", base64.StdEncoding.EncodeToString(signature))
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, cfg.Gateway, strings.NewReader(params.Encode()))
	if err != nil {
		return failure()
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded;charset=utf-8")
	client := http.Client{Timeout: 10 * time.Second}
	if b.alipayHTTPClient != nil {
		client = *b.alipayHTTPClient
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := client.Do(request)
	if err != nil {
		return failure()
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil || len(raw) > 1<<20 || response.StatusCode < 200 || response.StatusCode >= 300 {
		return failure()
	}
	var envelope struct {
		Response json.RawMessage `json:"alipay_trade_precreate_response"`
		Sign     string          `json:"sign"`
		SignType string          `json:"sign_type"`
	}
	if json.Unmarshal(raw, &envelope) != nil || len(envelope.Response) == 0 || envelope.Sign == "" || (envelope.SignType != "" && envelope.SignType != "RSA2") {
		return failure()
	}
	signature, err = base64.StdEncoding.DecodeString(envelope.Sign)
	if err != nil {
		return failure()
	}
	digest = sha256.Sum256(envelope.Response)
	if rsa.VerifyPKCS1v15(cfg.PublicKey, crypto.SHA256, digest[:], signature) != nil {
		return failure()
	}
	var result struct {
		Code    string `json:"code"`
		OrderID string `json:"out_trade_no"`
		QRCode  string `json:"qr_code"`
	}
	if json.Unmarshal(envelope.Response, &result) != nil || result.Code != "10000" || result.OrderID != order.ID || len(result.QRCode) > 8192 {
		return failure()
	}
	qr, err := url.Parse(result.QRCode)
	if err != nil || qr.Host == "" || (qr.Scheme != "https" && qr.Scheme != "http") || qr.User != nil {
		return failure()
	}
	return qr.String(), nil
}
