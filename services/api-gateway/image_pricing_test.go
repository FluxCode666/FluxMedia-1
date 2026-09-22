package main

import (
	"encoding/json"
	"testing"
)

func priceTestMap(raw string) map[string]any {
	var out map[string]any
	_ = json.Unmarshal([]byte(raw), &out)
	return out
}

func TestImagePricesRequireExplicitGlobalModelAndMergeLongestPrefix(t *testing.T) {
	global := priceTestMap(`{"version":1,"byModel":{"gpt-image":{"base1024Credits":1,"base1kCredits":2,"base2kCredits":3,"base4kCredits":4},"gpt-image-2":{"base1024Credits":5,"base1kCredits":6,"base2kCredits":7,"base4kCredits":8,"base8kCredits":9}}}`)
	group := priceTestMap(`{"version":1,"byModel":{"gpt-image":{"base4kCredits":20},"gpt-image-2":{"base2kCredits":11}}}`)
	got, err := resolveImagePrices(" FIREFLY-GPT-IMAGE-2-4K ", global, group)
	if err != nil || got["base1024Credits"] != 5 || got["base2kCredits"] != 11 || got["base4kCredits"] != 8 || got["base8kCredits"] != 9 {
		t.Fatalf("merged prices %+v err=%v", got, err)
	}
	for _, model := range []string{"unknown", "default", ""} {
		if _, err := resolveImagePrices(model, global, global); err == nil {
			t.Fatalf("unpriced model %s accepted", model)
		}
	}
	partial := priceTestMap(`{"version":1,"byModel":{"gpt-image-2":{"base4kCredits":12}}}`)
	if _, err := resolveImagePrices("gpt-image-2", partial, global); err == nil {
		t.Fatal("group prices substituted for missing global truth")
	}
}
func TestImagePriceTierUsesDimensionsAndRoundsChargesUp(t *testing.T) {
	prices := map[string]float64{"base8kCredits": 20}
	for _, test := range []struct{ resolution, size, key string }{
		{"", "", "base1024Credits"}, {"1k", "", "base1kCredits"}, {"2k", "", "base2kCredits"},
		{"4k", "", "base4kCredits"}, {"8k", "", "base8kCredits"}, {"", "1024x1024", "base1024Credits"},
		{"", "1248x1248", "base1kCredits"}, {"", "1152x2048", "base2kCredits"}, {"", "3840x2160", "base4kCredits"},
		{"7680x4320", "", "base8kCredits"}, {"invalid", "", "base4kCredits"},
	} {
		if got := imageBillingPriceKey(test.resolution, test.size, prices); got != test.key {
			t.Errorf("%s/%s got=%s want=%s", test.resolution, test.size, got, test.key)
		}
	}
	if got := imageBillingPriceKey("8k", "", nil); got != "base4kCredits" {
		t.Fatalf("8k fallback %s", got)
	}
	if got := roundUpImageCredits(1.27001 + 0.04); got != 1.32 {
		t.Fatalf("rounding %v", got)
	}
}
