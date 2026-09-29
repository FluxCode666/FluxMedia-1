package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMigrationRouteAuditRejectsMissingServerMethodsAndInfrastructure(t *testing.T) {
	for _, tc := range []struct {
		name    string
		version int
		method  string
		infra   []map[string]string
		want    string
	}{
		{name: "registered action", version: 2, method: "GET"},
		{name: "wrong action method", version: 2, method: "DELETE", want: "missing HTTP methods"},
		{name: "runtime Redis leak", version: 2, method: "GET", infra: []map[string]string{{"source": "runtime.ts", "module": "ioredis"}}, want: "1 web infrastructure imports"},
		{name: "stale inventory", version: 1, method: "GET", want: "outdated"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			inventory := map[string]any{
				"schemaVersion":                tc.version,
				"routes":                       []map[string]any{{"path": "/api/session/current", "methods": []string{"GET"}}},
				"serverGoRequests":             []map[string]any{{"path": "/api/session/current", "method": tc.method}},
				"runtimeInfrastructureImports": tc.infra,
			}
			data, err := json.Marshal(inventory)
			if err != nil {
				t.Fatal(err)
			}
			file := filepath.Join(t.TempDir(), "inventory.json")
			if err = os.WriteFile(file, data, 0600); err != nil {
				t.Fatal(err)
			}
			err = auditRoutes(file)
			if tc.want == "" {
				if err != nil {
					t.Fatal(err)
				}
			} else if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %v, want error containing %q", err, tc.want)
			}
		})
	}
}
