package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http/httptest"
	"os"
	"regexp"
	"sort"
)

// Validate the actual registered Go router; a 501 fallback never counts as coverage.
// This is a deployment guard, not a substitute for behavioral contract tests.
func auditRoutes(file string) error {
	data, err := os.ReadFile(file)
	if err != nil {
		return fmt.Errorf("read migration inventory: %w", err)
	}
	var inventory struct {
		SchemaVersion int `json:"schemaVersion"`
		Routes        []struct {
			Path    string   `json:"path"`
			Methods []string `json:"methods"`
		} `json:"routes"`
		DirectDatabaseImports        []string          `json:"directDatabaseImports"`
		RuntimeInfrastructureImports []json.RawMessage `json:"runtimeInfrastructureImports"`
		ServerGoRequests             []struct {
			Path   string `json:"path"`
			Method string `json:"method"`
		} `json:"serverGoRequests"`
	}
	if err := json.Unmarshal(data, &inventory); err != nil {
		return fmt.Errorf("parse migration inventory: %w", err)
	}
	if len(inventory.Routes) == 0 {
		return fmt.Errorf("migration inventory contains no routes")
	}
	if inventory.SchemaVersion != 2 {
		return fmt.Errorf("migration inventory is outdated; run node scripts/audit-go-migration.mjs --write")
	}
	b := &backend{config: config{maxBodyBytes: defaultMaxBodyBytes}, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	mux := b.router()
	missing := []string{}
	covered := 0
	parameter := regexp.MustCompile(`\[\[?[^\]]+\]\]?`)
	for _, route := range inventory.Routes {
		if route.Path == "/api/auth/[...all]" {
			continue
		} // Expanded explicitly below; a wildcard is not an auth contract.
		path := parameter.ReplaceAllString(route.Path, "audit-value")
		for _, method := range route.Methods {
			_, pattern := mux.Handler(httptest.NewRequest(method, "http://backend.local"+path, nil))
			if pattern == "" || pattern == "/" {
				missing = append(missing, method+" "+route.Path)
			} else {
				covered++
			}
		}
	}
	for _, route := range []struct{ method, path string }{
		{"POST", "sign-in/email"}, {"POST", "sign-up/email"}, {"POST", "sign-in/social"}, {"GET", "callback/google"}, {"GET", "callback/github"},
		{"GET", "get-session"}, {"POST", "sign-out"}, {"POST", "update-user"}, {"POST", "change-password"}, {"GET", "list-sessions"},
		{"POST", "revoke-session"}, {"POST", "revoke-sessions"}, {"POST", "revoke-other-sessions"}, {"POST", "request-password-reset"},
		{"GET", "reset-password/audit-value"}, {"POST", "reset-password"}, {"POST", "send-verification-email"}, {"GET", "verify-email"},
	} {
		path := "/api/auth/" + route.path
		_, pattern := mux.Handler(httptest.NewRequest(route.method, "http://backend.local"+path, nil))
		if pattern == "" || pattern == "/" {
			missing = append(missing, route.method+" "+path)
		} else {
			covered++
		}
	}
	serverMethods := map[string]bool{}
	for _, route := range inventory.ServerGoRequests {
		key := route.Method + " " + route.Path
		if serverMethods[key] {
			continue
		}
		serverMethods[key] = true
		_, pattern := mux.Handler(httptest.NewRequest(route.Method, "http://backend.local"+route.Path, nil))
		if pattern == "" || pattern == "/" {
			missing = append(missing, key)
		}
	}
	sort.Strings(missing)
	result := struct {
		Complete                 bool     `json:"complete"`
		CoveredMethods           int      `json:"coveredMethods"`
		MissingMethods           []string `json:"missingMethods"`
		WebDatabaseImports       int      `json:"webDatabaseImports"`
		WebInfrastructureImports int      `json:"webInfrastructureImports"`
		ServerRequestMethods     int      `json:"serverRequestMethods"`
	}{len(missing) == 0 && len(inventory.DirectDatabaseImports) == 0 && len(inventory.RuntimeInfrastructureImports) == 0, covered, missing, len(inventory.DirectDatabaseImports), len(inventory.RuntimeInfrastructureImports), len(serverMethods)}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(result); err != nil {
		return err
	}
	if !result.Complete {
		return fmt.Errorf("Go migration boundary incomplete: %d missing HTTP methods, %d web database imports, %d web infrastructure imports", len(missing), len(inventory.DirectDatabaseImports), len(inventory.RuntimeInfrastructureImports))
	}
	return nil
}
