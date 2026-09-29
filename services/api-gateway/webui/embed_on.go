//go:build embed

// Package webui provides the built Web SPA.
//
// The release image copies apps/web/dist into this directory and compiles with
// -tags embed so the frontend ships inside the Go binary. Source builds without
// a generated dist directory use embed_off.go instead.
package webui

import (
	"embed"
	"io/fs"
)

// all: keeps files that start with "_" such as Vite's
// __vite-browser-external chunk, which a plain pattern would silently drop.
//
//go:embed all:dist
var distFS embed.FS

// Dist returns the embedded build root, or false when index.html is missing.
func Dist() (fs.FS, bool) {
	dist, err := fs.Sub(distFS, "dist")
	if err != nil {
		return nil, false
	}
	if _, err := fs.Stat(dist, "index.html"); err != nil {
		return nil, false
	}
	return dist, true
}
