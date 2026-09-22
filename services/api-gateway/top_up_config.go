package main

import (
	"context"
	"encoding/json"
	"math"
	"math/big"
	"regexp"
	"strconv"
	"strings"
)

type topUpCurrency struct {
	Currency            string   `json:"currency"`
	CreditsPerMajorUnit float64  `json:"creditsPerMajorUnit"`
	MinAmountMinor      int64    `json:"minAmountMinor"`
	MaxAmountMinor      int64    `json:"maxAmountMinor"`
	Enabled             bool     `json:"enabled"`
	Providers           []string `json:"providers"`
}
type topUpConfig struct {
	Enabled         bool            `json:"enabled"`
	DefaultCurrency string          `json:"defaultCurrency"`
	Currencies      []topUpCurrency `json:"currencies"`
}

var topUpCurrencyPattern = regexp.MustCompile(`^[A-Z]{3}$`)

func defaultTopUpConfig() topUpConfig {
	return topUpConfig{true, "CNY", []topUpCurrency{{"CNY", 10, 100, 1_000_000, true, []string{"alipay_f2f"}}}}
}
func topUpPositive(value any, fallback, max float64) float64 {
	var number float64
	switch v := value.(type) {
	case float64:
		number = v
	case string:
		number, _ = strconv.ParseFloat(strings.TrimSpace(v), 64)
	}
	if math.IsNaN(number) || math.IsInf(number, 0) || number <= 0 {
		return fallback
	}
	return math.Min(number, max)
}
func normalizeTopUpConfig(raw any) topUpConfig {
	if value, ok := raw.(string); ok {
		if json.Unmarshal([]byte(value), &raw) != nil {
			return defaultTopUpConfig()
		}
	}
	obj, ok := raw.(map[string]any)
	if !ok {
		return defaultTopUpConfig()
	}
	result := defaultTopUpConfig()
	result.Enabled = boolOrDefault(obj["enabled"], true)
	if currency := strings.ToUpper(strings.TrimSpace(stringValue(obj["defaultCurrency"]))); topUpCurrencyPattern.MatchString(currency) {
		result.DefaultCurrency = currency
	}
	items, _ := obj["currencies"].([]any)
	currencies := []topUpCurrency{}
	index := map[string]int{}
	for _, raw := range items {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		currency := strings.ToUpper(strings.TrimSpace(stringValue(item["currency"])))
		if !topUpCurrencyPattern.MatchString(currency) {
			continue
		}
		min, max, rate := 1.0, 1e12, 1.0
		if currency == "CNY" {
			min, max, rate = 100, 1e6, 10
		}
		min = math.Floor(topUpPositive(item["minAmountMinor"], min, 1e12))
		max = math.Max(min, math.Floor(topUpPositive(item["maxAmountMinor"], max, 1e12)))
		entry := topUpCurrency{currency, topUpPositive(item["creditsPerMajorUnit"], rate, 1e8), int64(min), int64(max), boolOrDefault(item["enabled"], true), []string{}}
		if currency == "CNY" && containsString(stringSlice(item["providers"]), "alipay_f2f") {
			entry.Providers = []string{"alipay_f2f"}
		}
		if at, exists := index[currency]; exists {
			currencies[at] = entry
		} else {
			index[currency] = len(currencies)
			currencies = append(currencies, entry)
		}
	}
	if len(currencies) > 0 {
		result.Currencies = currencies
	}
	found := false
	for _, item := range result.Currencies {
		found = found || item.Currency == result.DefaultCurrency
	}
	if !found {
		result.DefaultCurrency = result.Currencies[0].Currency
	}
	return result
}
func (b *backend) readTopUpConfig(ctx context.Context) (topUpConfig, error) {
	raw, err := b.setting(ctx, "CREDIT_TOP_UP_CONFIG", nil)
	if err != nil {
		return topUpConfig{}, err
	}
	return normalizeTopUpConfig(raw), nil
}
func (b *backend) topUpOptions(ctx context.Context) (topUpConfig, error) {
	config, err := b.readTopUpConfig(ctx)
	if err != nil {
		return config, err
	}
	_, availableErr := b.readAlipayCheckoutConfig(ctx)
	available := availableErr == nil
	// Database failures must remain distinguishable from a disabled/incomplete channel.
	if availableErr != nil {
		if _, ok := availableErr.(*apiError); !ok {
			return config, availableErr
		}
	}
	currencies := []topUpCurrency{}
	for _, item := range config.Currencies {
		if item.Enabled && available && containsString(item.Providers, "alipay_f2f") {
			currencies = append(currencies, item)
			if len(currencies) == 16 {
				break
			}
		}
	}
	config.Currencies = currencies
	config.Enabled = config.Enabled && len(currencies) > 0
	found := false
	for _, item := range currencies {
		found = found || item.Currency == config.DefaultCurrency
	}
	if !found && len(currencies) > 0 {
		config.DefaultCurrency = currencies[0].Currency
	}
	return config, nil
}
func quoteTopUp(config topUpConfig, currency string, minor int64) (float64, float64, error) {
	if !config.Enabled {
		return 0, 0, invalid("积分充值暂未开放")
	}
	if currency != "CNY" {
		return 0, 0, invalid("支付宝当面付仅支持人民币")
	}
	for _, item := range config.Currencies {
		if item.Currency != currency || !item.Enabled {
			continue
		}
		if !containsString(item.Providers, "alipay_f2f") {
			return 0, 0, invalid("该币种不支持所选支付方式")
		}
		if minor < item.MinAmountMinor || minor > item.MaxAmountMinor {
			return 0, 0, invalid("充值金额超出允许范围")
		}
		// For CNY, cents * credits/yuan equals credit hundredths. Decimal rational
		// arithmetic truncates exactly instead of rounding an IEEE-754 product up.
		rate, ok := new(big.Rat).SetString(strconv.FormatFloat(item.CreditsPerMajorUnit, 'f', -1, 64))
		if !ok {
			return 0, 0, invalid("积分兑换比例无效")
		}
		value := new(big.Rat).Mul(rate, new(big.Rat).SetInt64(minor))
		cents := new(big.Int).Quo(value.Num(), value.Denom())
		if !cents.IsInt64() || cents.Int64() <= 0 || cents.Int64() > 9007199254740991 {
			return 0, 0, invalid("充值金额不足以兑换积分或超出积分上限")
		}
		return float64(cents.Int64()) / 100, item.CreditsPerMajorUnit, nil
	}
	return 0, 0, invalid("该币种暂未开放充值")
}
