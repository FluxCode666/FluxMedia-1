package main

import (
	"reflect"
	"testing"
)

func TestExternalModelsMatchLegacyFiltering(t *testing.T) {
	disabled := false
	config := marketplaceModels{Image: map[string]modelAvailability{"hidden": {Enabled: &disabled}}, Video: map[string]modelAvailability{"veo31": {Enabled: &disabled}}}
	got := visibleModelIDs([][]string{{"firefly-gpt-image-2", "GPT-IMAGE-2", "sora2", "firefly-sora2", "sora2-10s", "hidden", "veo31", "default", "vendor-image"}}, config)
	want := []string{"gpt-image-2", "sora2", "vendor-image"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("models=%v want %v", got, want)
	}
}
func TestInvalidModelConfigFailsClosed(t *testing.T) {
	for _, value := range []any{"invalid-json", map[string]any{"version": 99}, 42} {
		if _, err := parseMarketplaceModels(value); err == nil {
			t.Fatal("invalid config accepted")
		}
	}
	if _, err := parseMarketplaceModels(map[string]any{"version": 2, "imageByModel": map[string]any{}}); err != nil {
		t.Fatal(err)
	}
}
