package main

import "net/http"

// Retired endpoints remain explicit so stale clients cannot invoke tools.
func (b *backend) handleRetiredMCP(w http.ResponseWriter, r *http.Request) error {
	return &apiError{http.StatusGone, "MCP_RETIRED", "MCP functionality has been retired"}
}
