package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestReleaseIsNewer(t *testing.T) {
	cases := []struct {
		latest, current string
		want            bool
	}{
		{"v1.2.0", "v1.1.9", true},
		{"v1.10.0", "v1.9.0", true},
		{"v2.0.0", "v1.99.99", true},
		{"v1.2.0", "v1.2.0", false},
		{"v1.2.0", "v1.2.0-rc.1", true},
		{"v1.1.0", "v1.2.0", false},
		{"v1.3.0-rc.1", "v1.2.0", false},
		{"v1.3.0", "0.0.0-dev", false},
		{"1.3.0", "v1.2.0", false},
	}
	for _, tc := range cases {
		if got := releaseIsNewer(tc.latest, tc.current); got != tc.want {
			t.Errorf("releaseIsNewer(%q, %q) = %v, want %v", tc.latest, tc.current, got, tc.want)
		}
	}
}

func TestParseReleaseManifest(t *testing.T) {
	values, err := parseReleaseManifest([]byte("# comment\nRELEASE_TAG=v1.2.0\nAPP_IMAGE=ghcr.io/a/b:v1.2.0\n\n"))
	if err != nil || values["RELEASE_TAG"] != "v1.2.0" || values["APP_IMAGE"] != "ghcr.io/a/b:v1.2.0" {
		t.Fatalf("values = %v, err = %v", values, err)
	}
	for _, raw := range []string{"RELEASE_TAG=v1\nRELEASE_TAG=v2\n", "not a pair\n", "=value\n"} {
		if _, err := parseReleaseManifest([]byte(raw)); err == nil {
			t.Errorf("parseReleaseManifest(%q) succeeded", raw)
		}
	}
}

func TestPgDumpConnectionDropsSecretsAndPoolOptions(t *testing.T) {
	connection, password, err := pgDumpConnection("postgresql://flux:s3cr%40t@db:5432/flux?sslmode=disable&pool_max_conns=10")
	if err != nil {
		t.Fatal(err)
	}
	if password != "s3cr@t" {
		t.Fatalf("password = %q", password)
	}
	if connection != "postgresql://flux@db:5432/flux?sslmode=disable" {
		t.Fatalf("connection = %q", connection)
	}
}

type tarEntry struct {
	name, body, link string
	mode             int64
	kind             byte
}

func buildTarGz(t *testing.T, entries []tarEntry) []byte {
	t.Helper()
	var buffer bytes.Buffer
	compressed := gzip.NewWriter(&buffer)
	archive := tar.NewWriter(compressed)
	for _, entry := range entries {
		kind := entry.kind
		if kind == 0 {
			kind = tar.TypeReg
		}
		mode := entry.mode
		if mode == 0 {
			mode = 0o644
		}
		header := &tar.Header{Name: entry.name, Mode: mode, Typeflag: kind, Linkname: entry.link, Size: int64(len(entry.body))}
		if kind != tar.TypeReg {
			header.Size = 0
		}
		if err := archive.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if kind == tar.TypeReg {
			if _, err := archive.Write([]byte(entry.body)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err := compressed.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func extractEntries(t *testing.T, entries []tarEntry) (string, error) {
	t.Helper()
	directory := t.TempDir()
	archivePath := filepath.Join(directory, "bundle.tar.gz")
	if err := os.WriteFile(archivePath, buildTarGz(t, entries), 0o600); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(directory, "out")
	if err := os.Mkdir(destination, 0o755); err != nil {
		t.Fatal(err)
	}
	return destination, extractReleaseBundle(archivePath, destination)
}

func TestExtractReleaseBundleRejectsUnsafeEntries(t *testing.T) {
	cases := map[string][]tarEntry{
		"parent traversal":      {{name: "../escape", body: "x"}},
		"nested traversal":      {{name: "a/../../escape", body: "x"}},
		"absolute path":         {{name: "/etc/passwd", body: "x"}},
		"absolute symlink":      {{name: "link", kind: tar.TypeSymlink, link: "/etc"}},
		"escaping symlink":      {{name: "a/link", kind: tar.TypeSymlink, link: "../../etc"}},
		"write through symlink": {{name: "link", kind: tar.TypeSymlink, link: "dir"}, {name: "link/file", body: "x"}},
		"escaping hardlink":     {{name: "link", kind: tar.TypeLink, link: "../outside"}},
		"device":                {{name: "dev", kind: tar.TypeChar}},
	}
	for name, entries := range cases {
		t.Run(name, func(t *testing.T) {
			destination, err := extractEntries(t, entries)
			if !errors.Is(err, errUnsafeBundle) {
				t.Fatalf("err = %v, want errUnsafeBundle", err)
			}
			if _, statErr := os.Stat(filepath.Join(filepath.Dir(destination), "escape")); !os.IsNotExist(statErr) {
				t.Fatalf("entry escaped the destination")
			}
		})
	}
}

func TestExtractReleaseBundleKeepsSafeLayout(t *testing.T) {
	destination, err := extractEntries(t, []tarEntry{
		{name: "./", kind: tar.TypeDir, mode: 0o755},
		{name: "backend", body: "#!/bin/sh\n", mode: 0o4755},
		{name: "services/unified-runtime/node_modules/pkg/index.js", body: "export {}"},
		{name: "apps/web/node_modules", kind: tar.TypeSymlink, link: "../../services/unified-runtime/node_modules"},
		{name: "apps/web/copy.js", kind: tar.TypeLink, link: "services/unified-runtime/node_modules/pkg/index.js"},
	})
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(destination, "backend"))
	if err != nil || info.Mode().Perm() != 0o755 || info.Mode()&os.ModeSetuid != 0 {
		t.Fatalf("backend mode = %v, err = %v", info.Mode(), err)
	}
	body, err := os.ReadFile(filepath.Join(destination, "apps/web/node_modules/pkg/index.js"))
	if err != nil || string(body) != "export {}" {
		t.Fatalf("symlinked module = %q, err = %v", body, err)
	}
	if body, err := os.ReadFile(filepath.Join(destination, "apps/web/copy.js")); err != nil || string(body) != "export {}" {
		t.Fatalf("hardlinked file = %q, err = %v", body, err)
	}
}

type updateFixture struct {
	updater     *systemUpdater
	releasesDir string
	signals     chan struct{}
	backups     int
}

type releaseServerOptions struct {
	manifestFingerprint string
	bundleFingerprint   string
	bundleSHA           string
}

func newUpdateFixture(t *testing.T, options releaseServerOptions) *updateFixture {
	t.Helper()
	if options.manifestFingerprint == "" {
		options.manifestFingerprint = "platform-a"
	}
	if options.bundleFingerprint == "" {
		options.bundleFingerprint = options.manifestFingerprint
	}
	bundleMetadata, _ := json.Marshal(releaseMetadata{Version: "v1.1.0", GitSHA: strings.Repeat("b", 40), PlatformFingerprint: options.bundleFingerprint})
	bundle := buildTarGz(t, []tarEntry{
		{name: "release.json", body: string(bundleMetadata)},
		{name: "backend", body: "#!/bin/sh\n", mode: 0o755},
		{name: "services/unified-runtime/supervisor.mjs", body: "// supervisor"},
		{name: "apps/web/node_modules", kind: tar.TypeSymlink, link: "../../services/unified-runtime/node_modules"},
	})
	digest := sha256.Sum256(bundle)
	if options.bundleSHA == "" {
		options.bundleSHA = hex.EncodeToString(digest[:])
	}

	var server *httptest.Server
	server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/acme/app/releases/latest":
			writeJSON(w, http.StatusOK, map[string]any{
				"tag_name":     "v1.1.0",
				"name":         "FluxMedia v1.1.0",
				"body":         "## Changes\n- faster",
				"html_url":     server.URL + "/releases/v1.1.0",
				"published_at": "2026-09-30T00:00:00Z",
				"assets": []map[string]any{
					{"name": systemUpdateManifestAsset, "browser_download_url": server.URL + "/download/manifest", "size": 200},
					{"name": systemUpdateBundleAsset, "browser_download_url": server.URL + "/download/bundle", "size": len(bundle)},
				},
			})
		case "/download/manifest":
			fmt.Fprintf(w, "RELEASE_TAG=v1.1.0\nGIT_SHA=%s\nAPP_BUNDLE_SHA256=%s\nPLATFORM_FINGERPRINT=%s\n", strings.Repeat("b", 40), options.bundleSHA, options.manifestFingerprint)
		case "/download/bundle":
			// Serve the bundle through a redirect like GitHub's asset CDN.
			if r.URL.Query().Get("cdn") != "1" {
				http.Redirect(w, r, "/download/bundle?cdn=1", http.StatusFound)
				return
			}
			_, _ = w.Write(bundle)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	root := t.TempDir()
	imageRoot := filepath.Join(root, "image")
	releasesDir := filepath.Join(root, "releases")
	for _, directory := range []string{imageRoot, releasesDir} {
		if err := os.MkdirAll(directory, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	imageMetadata, _ := json.Marshal(releaseMetadata{Version: "v1.0.0", GitSHA: strings.Repeat("a", 40), PlatformFingerprint: "platform-a"})
	if err := os.WriteFile(filepath.Join(imageRoot, "release.json"), imageMetadata, 0o644); err != nil {
		t.Fatal(err)
	}

	fixture := &updateFixture{releasesDir: releasesDir, signals: make(chan struct{}, 1)}
	values := map[string]string{
		"FLUXMEDIA_IMAGE_ROOT":         imageRoot,
		"FLUXMEDIA_RELEASES_DIR":       releasesDir,
		"FLUXMEDIA_RELEASE_REPOSITORY": "acme/app",
		"FLUXMEDIA_SUPERVISOR_PID":     "4242",
	}
	updater := newSystemUpdater(func(key string) string { return values[key] }, "postgresql://db/flux", slog.New(slog.NewTextHandler(io.Discard, nil)))
	updater.apiBaseURL = server.URL
	updater.allowHost = func(host string) bool { return host == "127.0.0.1" }
	updater.httpClient = server.Client()
	updater.httpClient.CheckRedirect = updater.checkRedirect
	updater.platform = "linux/amd64"
	updater.backupTool = "pg_dump"
	updater.parentPID = func() int { return 4242 }
	updater.restartDelay = 0
	updater.backup = func(_ context.Context, destination string) error {
		fixture.backups++
		return os.WriteFile(destination, []byte("dump"), 0o600)
	}
	updater.signalRestart = func() error {
		fixture.signals <- struct{}{}
		return nil
	}
	fixture.updater = updater
	return fixture
}

func (f *updateFixture) waitForJob(t *testing.T, states ...string) systemUpdateJob {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		job := f.updater.snapshotJob()
		for _, state := range states {
			if job.State == state {
				return job
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("job did not reach %v: %+v", states, f.updater.snapshotJob())
	return systemUpdateJob{}
}

func (f *updateFixture) state(t *testing.T) map[string]any {
	t.Helper()
	return f.updater.readState()
}

func TestSystemUpdaterStagesReleaseAndRequestsRestart(t *testing.T) {
	fixture := newUpdateFixture(t, releaseServerOptions{})
	if err := os.WriteFile(filepath.Join(fixture.releasesDir, "state.json"), []byte(`{"schemaVersion":1,"history":[{"status":"succeeded"}]}`), 0o644); err != nil {
		t.Fatal(err)
	}

	status := fixture.updater.status(context.Background(), false)
	if status.CurrentVersion != "v1.0.0" || !status.Updater.Available || !status.UpdateAvailable {
		t.Fatalf("status = %+v", status)
	}
	if status.LatestRelease == nil || !status.LatestRelease.Installable || status.LatestRelease.Notes != "## Changes\n- faster" {
		t.Fatalf("latest release = %+v", status.LatestRelease)
	}

	job, err := fixture.updater.start(context.Background(), "v1.1.0", "admin-1")
	if err != nil || job.State != "running" {
		t.Fatalf("start = %+v, %v", job, err)
	}
	if _, err := fixture.updater.start(context.Background(), "v1.1.0", "admin-1"); err == nil || !strings.Contains(err.Error(), "已有更新任务") {
		t.Fatalf("second start err = %v", err)
	}
	select {
	case <-fixture.signals:
	case <-time.After(10 * time.Second):
		t.Fatalf("restart was not requested: %+v", fixture.updater.snapshotJob())
	}
	if job := fixture.updater.snapshotJob(); job.State != "restarting" || job.DownloadedBytes == 0 {
		t.Fatalf("job = %+v", job)
	}

	state := fixture.state(t)
	pending, _ := state["pending"].(map[string]any)
	if pending["version"] != "v1.1.0" || pending["dir"] != "v1.1.0" || pending["requestedBy"] != "admin-1" {
		t.Fatalf("pending = %v", pending)
	}
	if baseImage, _ := pending["baseImage"].(map[string]any); baseImage["version"] != "v1.0.0" || baseImage["gitSha"] != strings.Repeat("a", 40) {
		t.Fatalf("baseImage = %v", pending["baseImage"])
	}
	if previous, _ := pending["previous"].(map[string]any); previous["version"] != "v1.0.0" || previous["dir"] != nil {
		t.Fatalf("previous = %v", pending["previous"])
	}
	backup, _ := pending["backup"].(string)
	if !strings.HasPrefix(backup, "backups/") || !strings.HasSuffix(backup, "-before-v1.1.0.dump") {
		t.Fatalf("backup = %q", backup)
	}
	if _, err := os.Stat(filepath.Join(fixture.releasesDir, backup)); err != nil {
		t.Fatalf("backup file: %v", err)
	}
	if history, _ := state["history"].([]any); len(history) != 1 {
		t.Fatalf("history was not preserved: %v", state["history"])
	}
	target := filepath.Join(fixture.releasesDir, "v1.1.0")
	if info, err := os.Stat(filepath.Join(target, "backend")); err != nil || info.Mode().Perm()&0o100 == 0 {
		t.Fatalf("staged backend: %v", err)
	}
	for _, leftover := range []string{".downloads", ".staging"} {
		entries, _ := os.ReadDir(filepath.Join(fixture.releasesDir, leftover))
		if len(entries) != 0 {
			t.Fatalf("%s still has %d entries", leftover, len(entries))
		}
	}
}

func TestSystemUpdaterRejectsReleasesForAnotherPlatform(t *testing.T) {
	fixture := newUpdateFixture(t, releaseServerOptions{manifestFingerprint: "platform-b"})
	status := fixture.updater.status(context.Background(), false)
	if status.LatestRelease == nil || status.LatestRelease.Installable || status.LatestRelease.BlockedReason != "platform_changed" {
		t.Fatalf("latest release = %+v", status.LatestRelease)
	}
	_, err := fixture.updater.start(context.Background(), "v1.1.0", "admin-1")
	var conflict *systemUpdateConflict
	if !errors.As(err, &conflict) || conflict.code != "platform_changed" {
		t.Fatalf("start err = %v", err)
	}
}

func TestSystemUpdaterFailsClosedOnChecksumMismatch(t *testing.T) {
	fixture := newUpdateFixture(t, releaseServerOptions{bundleSHA: strings.Repeat("0", 64)})
	if _, err := fixture.updater.start(context.Background(), "v1.1.0", "admin-1"); err != nil {
		t.Fatal(err)
	}
	job := fixture.waitForJob(t, "failed", "restarting")
	if job.State != "failed" || job.Error != "checksum_mismatch" || job.FinishedAt == nil {
		t.Fatalf("job = %+v", job)
	}
	if fixture.backups != 0 {
		t.Fatalf("backup ran %d times", fixture.backups)
	}
	if _, err := os.Stat(filepath.Join(fixture.releasesDir, "v1.1.0")); !os.IsNotExist(err) {
		t.Fatalf("target release was left behind: %v", err)
	}
	if _, ok := fixture.state(t)["pending"]; ok {
		t.Fatalf("pending was recorded")
	}
}

func TestSystemUpdaterRejectsBundleThatDoesNotMatchThePlatform(t *testing.T) {
	fixture := newUpdateFixture(t, releaseServerOptions{bundleFingerprint: "platform-b"})
	if _, err := fixture.updater.start(context.Background(), "v1.1.0", "admin-1"); err != nil {
		t.Fatal(err)
	}
	if job := fixture.waitForJob(t, "failed", "restarting"); job.Error != "platform_changed" {
		t.Fatalf("job = %+v", job)
	}
}

func TestSystemUpdaterDiscardsPendingWhenRestartFails(t *testing.T) {
	fixture := newUpdateFixture(t, releaseServerOptions{})
	fixture.updater.signalRestart = func() error { return errors.New("no such process") }
	if _, err := fixture.updater.start(context.Background(), "v1.1.0", "admin-1"); err != nil {
		t.Fatal(err)
	}
	job := fixture.waitForJob(t, "failed")
	if job.Error != "restart_failed" {
		t.Fatalf("job = %+v", job)
	}
	if pending := fixture.state(t)["pending"]; pending != nil {
		t.Fatalf("pending = %v", pending)
	}
	if _, err := os.Stat(filepath.Join(fixture.releasesDir, "v1.1.0")); !os.IsNotExist(err) {
		t.Fatalf("target release was left behind: %v", err)
	}
}

func TestSystemUpdaterReportsWhyItIsUnavailable(t *testing.T) {
	fixture := newUpdateFixture(t, releaseServerOptions{})
	fixture.updater.parentPID = func() int { return 1 }
	status := fixture.updater.status(context.Background(), false)
	if status.Updater.Available || status.Updater.Reason != "unsupported_runtime" {
		t.Fatalf("updater = %+v", status.Updater)
	}
	if status.LatestRelease == nil || status.LatestRelease.BlockedReason != "unsupported_runtime" {
		t.Fatalf("latest release = %+v", status.LatestRelease)
	}

	fixture.updater.parentPID = func() int { return 4242 }
	if err := os.Chmod(fixture.releasesDir, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(fixture.releasesDir, 0o755) })
	if os.Geteuid() != 0 {
		if available, reason := fixture.updater.availability(fixture.updater.imageMetadata()); available || reason != "releases_dir_unavailable" {
			t.Fatalf("availability = %v, %q", available, reason)
		}
	}
}

func TestSystemUpdaterRefusesUntrustedHosts(t *testing.T) {
	updater := newSystemUpdater(func(string) string { return "" }, "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	for _, raw := range []string{"http://github.com/x", "https://evil.example/x", "https://user@github.com/x"} {
		if _, err := updater.get(context.Background(), raw, "*/*", 10); err == nil {
			t.Errorf("get(%q) succeeded", raw)
		}
	}
	if !isGitHubDownloadHost("objects.githubusercontent.com") || isGitHubDownloadHost("githubusercontent.com.evil.example") {
		t.Fatal("host allowlist is wrong")
	}
}
