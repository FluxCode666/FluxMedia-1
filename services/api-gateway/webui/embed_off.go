//go:build !embed

// Package webui provides the built Web SPA.
//
// Without the embed tag no frontend is compiled in: local development serves
// pages from Vite, or points FLUXMEDIA_WEB_DIST at a built dist directory.
package webui

import "io/fs"

// Dist always reports false when the frontend is not embedded.
func Dist() (fs.FS, bool) { return nil, false }
