package main

import "testing"

func TestTopUpQuoteUsesCurrencyLimitsAndDecimalTruncation(t *testing.T) {
	for _, tc := range []struct {
		minor      int64
		rate, want float64
	}{{100, 10, 10}, {1234, 7.125, 87.92}, {100, 0.29, 0.29}, {101, 0.1, 0.10}, {999, 1.001, 9.99}} {
		cfg := defaultTopUpConfig()
		cfg.Currencies[0].CreditsPerMajorUnit = tc.rate
		got, _, err := quoteTopUp(cfg, "CNY", tc.minor)
		if err != nil || got != tc.want {
			t.Fatalf("minor=%d rate=%v got=%v err=%v want=%v", tc.minor, tc.rate, got, err, tc.want)
		}
	}
	cfg := defaultTopUpConfig()
	for _, minor := range []int64{0, 99, 1000001} {
		if _, _, err := quoteTopUp(cfg, "CNY", minor); err == nil {
			t.Fatalf("accepted out-of-range amount %d", minor)
		}
	}
	if _, _, err := quoteTopUp(cfg, "USD", 100); err == nil {
		t.Fatal("Alipay accepted unsupported currency")
	}
	cfg.Currencies[0].MinAmountMinor = 1
	cfg.Currencies[0].CreditsPerMajorUnit = 0.001
	if _, _, err := quoteTopUp(cfg, "CNY", 1); err == nil {
		t.Fatal("issued a zero-credit checkout")
	}
	cfg.Currencies[0].CreditsPerMajorUnit = 1e8
	cfg.Currencies[0].MaxAmountMinor = 1e12
	if _, _, err := quoteTopUp(cfg, "CNY", 1e12); err == nil {
		t.Fatal("checkout exceeded exact credit accounting range")
	}
}
func TestTopUpNormalizationMatchesSharedConfig(t *testing.T) {
	cfg := normalizeTopUpConfig(map[string]any{"enabled": false, "defaultCurrency": "usd", "currencies": []any{map[string]any{"currency": "cny", "creditsPerMajorUnit": "7.125", "minAmountMinor": float64(100), "maxAmountMinor": float64(10), "providers": []any{"alipay_f2f", "alipay_f2f", "other"}}, map[string]any{"currency": "USD", "providers": []any{"alipay_f2f"}}}})
	if cfg.Enabled || cfg.DefaultCurrency != "USD" || len(cfg.Currencies) != 2 || cfg.Currencies[0].CreditsPerMajorUnit != 7.125 || cfg.Currencies[0].MaxAmountMinor != 100 || len(cfg.Currencies[0].Providers) != 1 || len(cfg.Currencies[1].Providers) != 0 {
		t.Fatalf("unexpected normalization %+v", cfg)
	}
	empty := normalizeTopUpConfig(map[string]any{"enabled": false, "currencies": []any{}})
	if empty.Enabled || len(empty.Currencies) != 1 || empty.Currencies[0].CreditsPerMajorUnit != 10 {
		t.Fatalf("default normalization %+v", empty)
	}
}

func TestAlipayMinorAmountParsingIsStrictAndBounded(t *testing.T) {
	for _, value := range []string{"12.xx", "12.", ".12", "+12", "-12", "1e2", "12.345", "9223372036854775807", "90071992547409.92", "12.3x", "12. 3"} {
		if got := parseMinor(value); got >= 0 {
			t.Fatalf("accepted malformed payment amount %q as %d", value, got)
		}
	}
	for raw, want := range map[string]int64{"12": 1200, "12.3": 1230, "12.34": 1234, " 12.34 ": 1234, "0.01": 1, "90071992547409.91": 9007199254740991} {
		if got := parseMinor(raw); got != want {
			t.Fatalf("amount %q got %d want %d", raw, got, want)
		}
	}
}
