package main

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"os"
	"sort"
	"strings"
)

type creditPackage struct {
	ID             string  `json:"id"`
	Name           string  `json:"name"`
	Description    string  `json:"description"`
	Currency       string  `json:"currency"`
	Credits        float64 `json:"credits"`
	Price          float64 `json:"price"`
	Popular        bool    `json:"popular"`
	Visible        bool    `json:"visible"`
	AllowQuantity  bool    `json:"allowQuantity"`
	MaxQuantity    int     `json:"maxQuantity"`
	CreemProductID string  `json:"creemProductId,omitempty"`
}

func defaultCreditPackages() []creditPackage {
	return []creditPackage{
		{ID: "payg_starter", Name: "Pay as you go", Description: "One-time pay-as-you-go credits", Currency: "CNY", Credits: 5000, Price: 20, Popular: true, Visible: true, MaxQuantity: 1},
		{ID: "enterprise_resource", Name: "Resource Pack", Description: "One-time 5,000-credit resource pack", Currency: "CNY", Credits: 5000, Price: 15, AllowQuantity: true, MaxQuantity: 999},
		{ID: "lite", Name: "Lite", Description: "Quick top-up for a few images", Currency: "CNY", Credits: 100, Price: 5, MaxQuantity: 1},
		{ID: "standard", Name: "Standard", Description: "Best value for regular use", Currency: "CNY", Credits: 500, Price: 20, MaxQuantity: 1},
		{ID: "pro", Name: "Pro", Description: "Maximum credits, maximum savings", Currency: "CNY", Credits: 1000, Price: 35, MaxQuantity: 1},
	}
}
func (b *backend) creditPackages(ctx context.Context) ([]creditPackage, error) {
	raw, err := b.setting(ctx, "CREDIT_PACKAGE_MATRIX", nil)
	if err != nil {
		return nil, err
	}
	if s, ok := raw.(string); ok {
		if json.Unmarshal([]byte(s), &raw) != nil {
			raw = nil
		}
	}
	defaults := defaultCreditPackages()
	if obj, ok := raw.(map[string]any); ok {
		raw = obj["packages"]
	}
	items, ok := raw.([]any)
	if !ok {
		return defaults, nil
	}
	byID := map[string]creditPackage{}
	for _, p := range defaults {
		byID[p.ID] = p
	}
	out := []creditPackage{}
	for _, value := range items {
		row, ok := value.(map[string]any)
		if !ok {
			continue
		}
		id := strings.TrimSpace(stringValue(row["id"]))
		if id == "" {
			continue
		}
		p, found := byID[id]
		if !found {
			p = creditPackage{ID: id, Name: id, Currency: "CNY", Visible: true, Credits: 1, Price: 1, MaxQuantity: 1}
		}
		for key, dst := range map[string]*string{"name": &p.Name, "creemProductId": &p.CreemProductID} {
			if value := strings.TrimSpace(stringValue(row[key])); value != "" {
				*dst = value
			}
		}
		if value, ok := row["description"].(string); ok {
			p.Description = value
		}
		if value := strings.ToUpper(strings.TrimSpace(stringValue(row["currency"]))); topUpCurrencyPattern.MatchString(value) {
			p.Currency = value
		}
		p.Credits = math.Floor(topUpPositive(row["credits"], p.Credits, 1e8))
		p.Price = topUpPositive(row["price"], p.Price, 1e6)
		p.MaxQuantity = int(math.Floor(topUpPositive(row["maxQuantity"], float64(p.MaxQuantity), 999)))
		if value, ok := row["visible"].(bool); ok {
			p.Visible = value
		}
		if value, ok := row["popular"].(bool); ok {
			p.Popular = value
		}
		if value, ok := row["allowQuantity"].(bool); ok {
			p.AllowQuantity = value
		}
		out = append(out, p)
	}
	if len(out) == 0 {
		return defaults, nil
	}
	rank := func(id string) int {
		if id == "payg_starter" {
			return 0
		}
		if id == "enterprise_resource" {
			return 1
		}
		return 2
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, c := rank(out[i].ID), rank(out[j].ID)
		if a != c {
			return a < c
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}
func (b *backend) handleCreditPackages(w http.ResponseWriter, r *http.Request) error {
	if _, err := b.requireSession(r); err != nil {
		return err
	}
	packages, err := b.creditPackages(r.Context())
	if err != nil {
		return err
	}
	out := []creditPackage{}
	for _, p := range packages {
		if p.Visible {
			out = append(out, p)
		}
	}
	noStore(w)
	writeJSON(w, http.StatusOK, out)
	return nil
}
func (b *backend) creditPackageProvider(ctx context.Context) (string, error) {
	values := []string{strings.ToLower(strings.TrimSpace(os.Getenv("PAYMENT_PROVIDER"))), strings.ToLower(strings.TrimSpace(os.Getenv("NEXT_PUBLIC_PAYMENT_PROVIDER")))}
	fallback := "none"
	for _, candidate := range []string{"none", "alipay_f2f", "epay", "creem"} {
		if containsString(values, candidate) {
			fallback = candidate
			break
		}
	}
	if values[0] == "" && values[1] == "" {
		fallback = "creem"
	}
	provider, err := b.settingString(ctx, "PAYMENT_PROVIDER", fallback)
	if err != nil {
		return "", err
	}
	provider = strings.ToLower(strings.TrimSpace(provider))
	if !containsString([]string{"creem", "epay", "alipay_f2f", "none"}, provider) {
		provider = "none"
	}
	return provider, nil
}
func creditPackageCurrencyExponent(currency string) int {
	switch currency {
	case "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF":
		return 0
	case "BHD", "KWD", "OMR":
		return 3
	default:
		return 2
	}
}
