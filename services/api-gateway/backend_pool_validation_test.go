package main

import (
	"context"
	"testing"
)

func TestPoolCredentialScopeRejectsQueriesAndNormalizesDefaultPorts(t *testing.T) {
	for _, raw := range []string{"https://provider.test/v1?token=x", "https://provider.test/v1?", "https://provider.test/v1#fragment", "https://user:password@provider.test/v1"} {
		t.Run(raw, func(t *testing.T) {
			if _, err := poolCredentialScope(map[string]any{"baseUrl": raw, "authentication": map[string]any{"mode": "bearer"}}); err == nil {
				t.Fatal("unusable provider origin accepted")
			}
		})
	}
	for _, tc := range []struct{ url, scope string }{
		{"https://Provider.Test:443/v1", "https://provider.test|bearer"},
		{"https://Provider.Test/v2", "https://provider.test|bearer"},
		{"http://Provider.Test:80/v1", "http://provider.test|bearer"},
		{"https://Provider.Test:8443/v1", "https://provider.test:8443|bearer"},
		{"https://[2001:db8::1]:443/v1", "https://[2001:db8::1]|bearer"},
	} {
		t.Run(tc.url, func(t *testing.T) {
			got, err := poolCredentialScope(map[string]any{"baseUrl": tc.url, "authentication": map[string]any{"mode": "bearer"}})
			if err != nil || got != tc.scope {
				t.Fatalf("scope %q, error %v; want %q", got, err, tc.scope)
			}
		})
	}
}

func TestPoolAdapterRejectsEncodedTraversalAndControlPaths(t *testing.T) {
	b := &backend{}
	for _, tc := range []struct {
		path  string
		valid bool
	}{
		{"", true},
		{"/images/generations", true},
		{"/custom/images-v2", true},
		{"/%252e%252e/generate", false},
		{"/safe/%252E/generate", false},
		{"/%252fprovider.test/generate", false},
		{"/images%2509/generate", false},
		{"/images\t/generate", false},
		{"/images%7F/generate", false},
		{"/images%00/generate", false},
		{"/images/%broken", false},
		{"/images?token=x", false},
	} {
		t.Run(tc.path, func(t *testing.T) {
			cfg := map[string]any{"operations": map[string]any{"images.generate": map[string]any{"path": tc.path}}}
			poolAdapterDefaults(cfg)
			err := b.validatePoolAdapter(context.Background(), cfg)
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%t, error=%v", tc.valid, err)
			}
		})
	}
}
