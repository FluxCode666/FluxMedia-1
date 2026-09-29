package main

// In-site system updates for the unified image.
//
// A super admin installs the latest stable GitHub release from the dashboard.
// The backend downloads that release's application bundle into the releases
// volume, verifies it against the release manifest, extracts it into a version
// directory, backs up PostgreSQL, records the switch as pending in state.json
// and asks the unified supervisor to stop. The container restart policy then
// starts services/unified-runtime/boot.mjs, which migrates and activates the
// pending release (or stays on the current one when the migration fails).
//
// Only application code travels through this path. A release whose platform
// fingerprint (base image, entrypoint, Compose/Nginx topology, models) differs
// from the running image must be deployed as a new image instead.

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	systemUpdateManifestAsset     = "fluxmedia-release.env"
	systemUpdateBundleAsset       = "fluxmedia-app-linux-amd64.tar.gz"
	systemUpdateDefaultRepository = "FluxCode666/FluxMedia-1"
	systemUpdateReleaseCacheTTL   = 5 * time.Minute
	systemUpdateMaxManifestBytes  = 64 << 10
	systemUpdateMaxBundleBytes    = 1536 << 20
	systemUpdateMaxExtractedBytes = 4 << 30
	systemUpdateMaxEntries        = 500_000
	systemUpdateMaxNotesRunes     = 20_000
	systemUpdateKeepBackups       = 3
	systemUpdateBackupTimeout     = 30 * time.Minute
	systemUpdateJobTimeout        = 90 * time.Minute
	systemUpdateDevVersion        = "0.0.0-dev"
)

var (
	stableReleaseTagPattern = regexp.MustCompile(`^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$`)
	releaseTagPattern       = regexp.MustCompile(`^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$`)
	sha256HexPattern        = regexp.MustCompile(`^[0-9a-f]{64}$`)
	errUnsafeBundle         = errors.New("release bundle contains an unsafe entry")
)

// systemUpdateJob is the in-memory progress of the current update. It resets
// when the backend restarts; the durable outcome lives in state.json.
type systemUpdateJob struct {
	State           string     `json:"state"`
	Phase           string     `json:"phase,omitempty"`
	TargetVersion   string     `json:"targetVersion,omitempty"`
	DownloadedBytes int64      `json:"downloadedBytes,omitempty"`
	TotalBytes      int64      `json:"totalBytes,omitempty"`
	Error           string     `json:"error,omitempty"`
	Message         string     `json:"message,omitempty"`
	StartedAt       *time.Time `json:"startedAt,omitempty"`
	FinishedAt      *time.Time `json:"finishedAt,omitempty"`
}

type releaseMetadata struct {
	Version             string `json:"version"`
	GitSHA              string `json:"gitSha"`
	PlatformFingerprint string `json:"platformFingerprint"`
}

type systemUpdateRelease struct {
	Version     string
	Name        string
	Notes       string
	URL         string
	PublishedAt string
	BundleURL   string
	BundleSize  int64
	Manifest    map[string]string
	// Problem explains why the release cannot be installed regardless of the
	// running system, for example a missing bundle.
	Problem string
}

type systemUpdater struct {
	imageRoot     string
	appRoot       string
	releasesDir   string
	repository    string
	apiBaseURL    string
	httpClient    *http.Client
	allowHost     func(string) bool
	platform      string
	backupTool    string
	backup        func(ctx context.Context, destination string) error
	supervisorPID int
	parentPID     func() int
	signalRestart func() error
	restartDelay  time.Duration
	now           func() time.Time
	logger        *slog.Logger

	mu           sync.Mutex
	job          systemUpdateJob
	release      *systemUpdateRelease
	releaseErr   string
	releaseCheck time.Time
}

func isGitHubDownloadHost(host string) bool {
	host = strings.ToLower(host)
	return host == "api.github.com" || host == "github.com" || strings.HasSuffix(host, ".githubusercontent.com")
}

func newSystemUpdater(getenv func(string) string, databaseURL string, logger *slog.Logger) *systemUpdater {
	imageRoot := strings.TrimSpace(getenv("FLUXMEDIA_IMAGE_ROOT"))
	if imageRoot == "" {
		imageRoot = "/app"
	}
	appRoot := strings.TrimSpace(getenv("FLUXMEDIA_APP_ROOT"))
	if appRoot == "" {
		appRoot = imageRoot
	}
	releasesDir := strings.TrimSpace(getenv("FLUXMEDIA_RELEASES_DIR"))
	if releasesDir == "" {
		releasesDir = "/app/releases"
	}
	repository := strings.TrimSpace(getenv("FLUXMEDIA_RELEASE_REPOSITORY"))
	if repository == "" {
		repository = systemUpdateDefaultRepository
	}
	supervisorPID, _ := strconv.Atoi(strings.TrimSpace(getenv("FLUXMEDIA_SUPERVISOR_PID")))
	backupTool, _ := exec.LookPath("pg_dump")
	u := &systemUpdater{
		imageRoot:     imageRoot,
		appRoot:       appRoot,
		releasesDir:   releasesDir,
		repository:    repository,
		apiBaseURL:    "https://api.github.com",
		allowHost:     isGitHubDownloadHost,
		platform:      runtime.GOOS + "/" + runtime.GOARCH,
		backupTool:    backupTool,
		supervisorPID: supervisorPID,
		parentPID:     os.Getppid,
		restartDelay:  2 * time.Second,
		now:           time.Now,
		logger:        logger,
	}
	u.httpClient = &http.Client{
		Transport: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			TLSHandshakeTimeout:   15 * time.Second,
			ResponseHeaderTimeout: 30 * time.Second,
			IdleConnTimeout:       30 * time.Second,
		},
		CheckRedirect: u.checkRedirect,
	}
	u.backup = func(ctx context.Context, destination string) error {
		return pgDumpBackup(ctx, u.backupTool, databaseURL, destination)
	}
	u.signalRestart = func() error { return syscall.Kill(u.supervisorPID, syscall.SIGTERM) }
	return u
}

func (u *systemUpdater) checkRedirect(req *http.Request, via []*http.Request) error {
	if len(via) >= 5 {
		return errors.New("too many redirects")
	}
	if !u.trustedURL(req.URL) {
		return errors.New("redirect to an untrusted host")
	}
	return nil
}

func (u *systemUpdater) trustedURL(target *url.URL) bool {
	return target != nil && target.Scheme == "https" && target.User == nil && u.allowHost(target.Hostname())
}

// parseReleaseVersion splits vMAJOR.MINOR.PATCH[-pre.N]; the prerelease part
// only matters when the numeric parts are equal.
func parseReleaseVersion(version string) (numbers [3]int, prerelease bool, ok bool) {
	match := releaseTagPattern.FindStringSubmatch(version)
	if match == nil {
		return numbers, false, false
	}
	for index := range numbers {
		numbers[index], _ = strconv.Atoi(match[index+1])
	}
	return numbers, match[4] != "", true
}

// releaseIsNewer reports whether latest (a stable tag) supersedes current.
func releaseIsNewer(latest, current string) bool {
	next, nextPre, ok := parseReleaseVersion(latest)
	if !ok || nextPre {
		return false
	}
	now, nowPre, ok := parseReleaseVersion(current)
	if !ok {
		return false
	}
	for index := range next {
		if next[index] != now[index] {
			return next[index] > now[index]
		}
	}
	return nowPre
}

func parseReleaseManifest(raw []byte) (map[string]string, error) {
	values := map[string]string{}
	scanner := bufio.NewScanner(strings.NewReader(string(raw)))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, found := strings.Cut(line, "=")
		if !found || key == "" {
			return nil, errors.New("invalid manifest line")
		}
		if _, exists := values[key]; exists {
			return nil, errors.New("duplicate manifest key")
		}
		values[key] = value
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return values, nil
}

func readReleaseMetadata(root string) (releaseMetadata, error) {
	var metadata releaseMetadata
	raw, err := os.ReadFile(filepath.Join(root, "release.json"))
	if err != nil {
		return metadata, err
	}
	if err := json.Unmarshal(raw, &metadata); err != nil {
		return metadata, err
	}
	return metadata, nil
}

func (u *systemUpdater) imageMetadata() releaseMetadata {
	metadata, err := readReleaseMetadata(u.imageRoot)
	if err != nil || metadata.Version == "" {
		return releaseMetadata{Version: systemUpdateDevVersion}
	}
	return metadata
}

func (u *systemUpdater) currentMetadata() releaseMetadata {
	if filepath.Clean(u.appRoot) == filepath.Clean(u.imageRoot) {
		return u.imageMetadata()
	}
	metadata, err := readReleaseMetadata(u.appRoot)
	if err != nil || metadata.Version == "" {
		return u.imageMetadata()
	}
	return metadata
}

// availability explains whether this process can install updates at all.
func (u *systemUpdater) availability(image releaseMetadata) (bool, string) {
	switch {
	case !releaseTagPattern.MatchString(image.Version) || image.PlatformFingerprint == "":
		return false, "dev_build"
	case u.platform != "linux/amd64":
		return false, "unsupported_platform"
	case u.supervisorPID <= 1 || u.parentPID() != u.supervisorPID:
		return false, "unsupported_runtime"
	case u.backupTool == "":
		return false, "backup_unavailable"
	}
	info, err := os.Stat(u.releasesDir)
	if err != nil || !info.IsDir() {
		return false, "releases_dir_unavailable"
	}
	probe, err := os.CreateTemp(u.releasesDir, ".write-probe-*")
	if err != nil {
		return false, "releases_dir_unavailable"
	}
	_ = probe.Close()
	_ = os.Remove(probe.Name())
	return true, ""
}

type githubRelease struct {
	TagName     string `json:"tag_name"`
	Name        string `json:"name"`
	Body        string `json:"body"`
	HTMLURL     string `json:"html_url"`
	PublishedAt string `json:"published_at"`
	Draft       bool   `json:"draft"`
	Prerelease  bool   `json:"prerelease"`
	Assets      []struct {
		Name               string `json:"name"`
		BrowserDownloadURL string `json:"browser_download_url"`
		Size               int64  `json:"size"`
	} `json:"assets"`
}

type releaseLookupError struct{ code string }

func (e *releaseLookupError) Error() string { return e.code }

func (u *systemUpdater) get(ctx context.Context, rawURL, accept string, limit int64) ([]byte, error) {
	target, err := url.Parse(rawURL)
	if err != nil || !u.trustedURL(target) {
		return nil, &releaseLookupError{"untrusted_url"}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", accept)
	req.Header.Set("User-Agent", "FluxMedia-SystemUpdater")
	res, err := u.httpClient.Do(req)
	if err != nil {
		return nil, &releaseLookupError{"github_unavailable"}
	}
	defer res.Body.Close()
	switch {
	case res.StatusCode == http.StatusNotFound:
		return nil, &releaseLookupError{"release_not_found"}
	case res.StatusCode == http.StatusForbidden || res.StatusCode == http.StatusTooManyRequests:
		return nil, &releaseLookupError{"github_rate_limited"}
	case res.StatusCode != http.StatusOK:
		return nil, &releaseLookupError{"github_unavailable"}
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err != nil {
		return nil, &releaseLookupError{"github_unavailable"}
	}
	if int64(len(body)) > limit {
		return nil, &releaseLookupError{"github_response_too_large"}
	}
	return body, nil
}

func (u *systemUpdater) fetchLatestRelease(ctx context.Context) (*systemUpdateRelease, error) {
	body, err := u.get(ctx, strings.TrimRight(u.apiBaseURL, "/")+"/repos/"+u.repository+"/releases/latest", "application/vnd.github+json", 4<<20)
	if err != nil {
		return nil, err
	}
	var payload githubRelease
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, &releaseLookupError{"github_unavailable"}
	}
	release := &systemUpdateRelease{
		Version:     payload.TagName,
		Name:        payload.Name,
		Notes:       truncateRunes(payload.Body, systemUpdateMaxNotesRunes),
		URL:         payload.HTMLURL,
		PublishedAt: payload.PublishedAt,
	}
	if payload.Draft || payload.Prerelease || !stableReleaseTagPattern.MatchString(payload.TagName) {
		release.Problem = "unsupported_release"
		return release, nil
	}
	manifestURL := ""
	for _, asset := range payload.Assets {
		switch asset.Name {
		case systemUpdateManifestAsset:
			manifestURL = asset.BrowserDownloadURL
		case systemUpdateBundleAsset:
			release.BundleURL = asset.BrowserDownloadURL
			release.BundleSize = asset.Size
		}
	}
	if manifestURL == "" || release.BundleURL == "" {
		release.Problem = "bundle_missing"
		return release, nil
	}
	if release.BundleSize > systemUpdateMaxBundleBytes {
		release.Problem = "bundle_too_large"
		return release, nil
	}
	raw, err := u.get(ctx, manifestURL, "application/octet-stream", systemUpdateMaxManifestBytes)
	if err != nil {
		return nil, err
	}
	manifest, err := parseReleaseManifest(raw)
	if err != nil || manifest["RELEASE_TAG"] != release.Version || !sha256HexPattern.MatchString(manifest["APP_BUNDLE_SHA256"]) || manifest["PLATFORM_FINGERPRINT"] == "" {
		release.Problem = "bundle_missing"
		return release, nil
	}
	release.Manifest = manifest
	return release, nil
}

// latestRelease returns the cached release lookup, refreshing it at most once
// per cache window (the anonymous GitHub API allows 60 requests per hour).
func (u *systemUpdater) latestRelease(ctx context.Context, force bool) (*systemUpdateRelease, string) {
	u.mu.Lock()
	fresh := !u.releaseCheck.IsZero() && u.now().Sub(u.releaseCheck) < systemUpdateReleaseCacheTTL
	if fresh && !force {
		release, releaseErr := u.release, u.releaseErr
		u.mu.Unlock()
		return release, releaseErr
	}
	u.mu.Unlock()

	lookupCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	release, err := u.fetchLatestRelease(lookupCtx)
	releaseErr := ""
	if err != nil {
		var lookup *releaseLookupError
		releaseErr = "github_unavailable"
		if errors.As(err, &lookup) {
			releaseErr = lookup.code
		}
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	u.releaseCheck = u.now()
	u.release, u.releaseErr = release, releaseErr
	return release, releaseErr
}

// blockedReason explains why a release newer than the current version cannot
// be installed in place; an empty string means it can.
func (u *systemUpdater) blockedReason(release *systemUpdateRelease, image releaseMetadata, available bool, unavailableReason string) string {
	switch {
	case release.Problem != "":
		return release.Problem
	case !available:
		return unavailableReason
	case release.Manifest["PLATFORM_FINGERPRINT"] != image.PlatformFingerprint:
		return "platform_changed"
	}
	return ""
}

func (u *systemUpdater) snapshotJob() systemUpdateJob {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.job
}

func (u *systemUpdater) updateJob(mutate func(*systemUpdateJob)) {
	u.mu.Lock()
	defer u.mu.Unlock()
	mutate(&u.job)
}

func (u *systemUpdater) readState() map[string]any {
	raw, err := os.ReadFile(filepath.Join(u.releasesDir, "state.json"))
	if err != nil {
		return map[string]any{}
	}
	var state map[string]any
	if json.Unmarshal(raw, &state) != nil || state == nil {
		return map[string]any{}
	}
	return state
}

func writeFileAtomically(target string, data []byte, mode os.FileMode) error {
	file, err := os.CreateTemp(filepath.Dir(target), "."+filepath.Base(target)+".*.tmp")
	if err != nil {
		return err
	}
	temporary := file.Name()
	defer os.Remove(temporary)
	if _, err = file.Write(data); err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Chmod(temporary, mode)
	}
	if err != nil {
		return err
	}
	return os.Rename(temporary, target)
}

type systemUpdateStatus struct {
	CurrentVersion  string                   `json:"currentVersion"`
	ImageVersion    string                   `json:"imageVersion"`
	Updater         systemUpdateAvailability `json:"updater"`
	LatestRelease   *systemUpdateReleaseView `json:"latestRelease"`
	ReleaseError    string                   `json:"releaseError,omitempty"`
	UpdateAvailable bool                     `json:"updateAvailable"`
	Job             systemUpdateJob          `json:"job"`
	LastResult      any                      `json:"lastResult"`
}

type systemUpdateAvailability struct {
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`
}

type systemUpdateReleaseView struct {
	Version       string `json:"version"`
	Name          string `json:"name"`
	Notes         string `json:"notes"`
	URL           string `json:"url"`
	PublishedAt   string `json:"publishedAt"`
	Installable   bool   `json:"installable"`
	BlockedReason string `json:"blockedReason,omitempty"`
}

func (u *systemUpdater) status(ctx context.Context, refresh bool) systemUpdateStatus {
	image := u.imageMetadata()
	current := u.currentMetadata()
	available, reason := u.availability(image)
	status := systemUpdateStatus{
		CurrentVersion: current.Version,
		ImageVersion:   image.Version,
		Updater:        systemUpdateAvailability{Available: available, Reason: reason},
		Job:            u.snapshotJob(),
		LastResult:     u.readState()["lastResult"],
	}
	if status.Job.State == "" {
		status.Job.State = "idle"
	}
	release, releaseErr := u.latestRelease(ctx, refresh)
	status.ReleaseError = releaseErr
	if release != nil {
		view := &systemUpdateReleaseView{
			Version:     release.Version,
			Name:        release.Name,
			Notes:       release.Notes,
			URL:         release.URL,
			PublishedAt: release.PublishedAt,
		}
		status.UpdateAvailable = releaseIsNewer(release.Version, current.Version)
		if status.UpdateAvailable {
			view.BlockedReason = u.blockedReason(release, image, available, reason)
			view.Installable = view.BlockedReason == ""
		}
		status.LatestRelease = view
	}
	return status
}

type systemUpdateConflict struct{ code, message string }

func (e *systemUpdateConflict) Error() string { return e.message }

// start validates the requested version against the cached release and runs
// the update in the background. The caller sees progress through status().
func (u *systemUpdater) start(ctx context.Context, version, requestedBy string) (systemUpdateJob, error) {
	image := u.imageMetadata()
	current := u.currentMetadata()
	available, reason := u.availability(image)
	release, releaseErr := u.latestRelease(ctx, false)
	switch {
	case release == nil:
		return systemUpdateJob{}, &systemUpdateConflict{firstNonEmpty(releaseErr, "github_unavailable"), "无法获取最新版本信息"}
	case release.Version != version:
		return systemUpdateJob{}, &systemUpdateConflict{"release_changed", "最新版本已变化，请刷新后重试"}
	case !releaseIsNewer(release.Version, current.Version):
		return systemUpdateJob{}, &systemUpdateConflict{"already_current", "当前已是最新版本"}
	}
	if blocked := u.blockedReason(release, image, available, reason); blocked != "" {
		return systemUpdateJob{}, &systemUpdateConflict{blocked, "该版本无法在线更新"}
	}

	u.mu.Lock()
	if u.job.State == "running" || u.job.State == "restarting" {
		u.mu.Unlock()
		return systemUpdateJob{}, &systemUpdateConflict{"update_in_progress", "已有更新任务正在进行"}
	}
	startedAt := u.now().UTC()
	u.job = systemUpdateJob{State: "running", Phase: "downloading", TargetVersion: release.Version, TotalBytes: release.BundleSize, StartedAt: &startedAt}
	job := u.job
	u.mu.Unlock()

	go u.run(release, image, current, requestedBy)
	return job, nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

type systemUpdateFailure struct {
	code string
	err  error
}

func (e *systemUpdateFailure) Error() string {
	if e.err == nil {
		return e.code
	}
	return e.code + ": " + e.err.Error()
}

func (e *systemUpdateFailure) Unwrap() error { return e.err }

func failUpdate(code string, err error) error { return &systemUpdateFailure{code: code, err: err} }

func (u *systemUpdater) run(release *systemUpdateRelease, image, current releaseMetadata, requestedBy string) {
	ctx, cancel := context.WithTimeout(context.Background(), systemUpdateJobTimeout)
	defer cancel()
	err := u.install(ctx, release, image, current, requestedBy)
	if err == nil {
		u.updateJob(func(job *systemUpdateJob) {
			job.State, job.Phase = "restarting", "restarting"
		})
		u.logger.Info("system update staged; restarting", "from", current.Version, "to", release.Version)
		time.Sleep(u.restartDelay)
		signalErr := u.signalRestart()
		if signalErr == nil {
			return
		}
		// Without a restart the pending switch would surprise the next start.
		u.discardPending(release.Version)
		err = failUpdate("restart_failed", signalErr)
	}
	code := "update_failed"
	var failure *systemUpdateFailure
	if errors.As(err, &failure) {
		code = failure.code
	}
	u.logger.Error("system update failed", "to", release.Version, "error", err)
	finishedAt := u.now().UTC()
	u.updateJob(func(job *systemUpdateJob) {
		job.State, job.Error, job.Message, job.FinishedAt = "failed", code, err.Error(), &finishedAt
	})
}

func (u *systemUpdater) discardPending(version string) {
	state := u.readState()
	if pending, ok := state["pending"].(map[string]any); ok && pending["version"] == version {
		state["pending"] = nil
		if encoded, err := json.MarshalIndent(state, "", "  "); err == nil {
			_ = writeFileAtomically(filepath.Join(u.releasesDir, "state.json"), append(encoded, '\n'), 0o644)
		}
	}
	_ = os.RemoveAll(filepath.Join(u.releasesDir, version))
}

func (u *systemUpdater) setPhase(phase string) {
	u.updateJob(func(job *systemUpdateJob) { job.Phase = phase })
}

func (u *systemUpdater) install(ctx context.Context, release *systemUpdateRelease, image, current releaseMetadata, requestedBy string) (err error) {
	downloads := filepath.Join(u.releasesDir, ".downloads")
	staging := filepath.Join(u.releasesDir, ".staging")
	for _, directory := range []string{downloads, staging} {
		if err := os.MkdirAll(directory, 0o755); err != nil {
			return failUpdate("releases_dir_unavailable", err)
		}
	}
	archive := filepath.Join(downloads, release.Version+".tar.gz")
	defer os.Remove(archive)
	if err := u.download(ctx, release, archive); err != nil {
		return err
	}

	u.setPhase("extracting")
	suffix := make([]byte, 6)
	_, _ = rand.Read(suffix)
	extracted := filepath.Join(staging, release.Version+"-"+hex.EncodeToString(suffix))
	defer os.RemoveAll(extracted)
	if err := os.Mkdir(extracted, 0o755); err != nil {
		return failUpdate("extract_failed", err)
	}
	if err := extractReleaseBundle(archive, extracted); err != nil {
		return failUpdate("extract_failed", err)
	}
	if err := verifyExtractedRelease(extracted, release, image); err != nil {
		return err
	}
	target := filepath.Join(u.releasesDir, release.Version)
	if filepath.Clean(target) == filepath.Clean(u.appRoot) {
		return failUpdate("extract_failed", errors.New("target release is running"))
	}
	if err := os.RemoveAll(target); err != nil {
		return failUpdate("extract_failed", err)
	}
	if err := os.Rename(extracted, target); err != nil {
		return failUpdate("extract_failed", err)
	}
	defer func() {
		if err != nil {
			_ = os.RemoveAll(target)
		}
	}()

	u.setPhase("backing_up")
	backup, err := u.createBackup(ctx, release.Version)
	if err != nil {
		return err
	}

	state := u.readState()
	previous := map[string]any{"version": current.Version, "gitSha": current.GitSHA, "dir": nil}
	if filepath.Clean(u.appRoot) != filepath.Clean(u.imageRoot) {
		previous["dir"] = filepath.Base(u.appRoot)
	}
	state["schemaVersion"] = 1
	state["pending"] = map[string]any{
		"version":     release.Version,
		"gitSha":      release.Manifest["GIT_SHA"],
		"dir":         release.Version,
		"baseImage":   map[string]any{"version": image.Version, "gitSha": image.GitSHA},
		"previous":    previous,
		"backup":      backup,
		"requestedBy": requestedBy,
		"requestedAt": u.now().UTC().Format(time.RFC3339),
	}
	encoded, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return failUpdate("state_write_failed", err)
	}
	if err := writeFileAtomically(filepath.Join(u.releasesDir, "state.json"), append(encoded, '\n'), 0o644); err != nil {
		return failUpdate("state_write_failed", err)
	}
	return nil
}

type progressWriter struct {
	updater *systemUpdater
	written int64
	limit   int64
}

func (p *progressWriter) Write(data []byte) (int, error) {
	p.written += int64(len(data))
	if p.written > p.limit {
		return 0, errors.New("bundle exceeds the size limit")
	}
	written := p.written
	p.updater.updateJob(func(job *systemUpdateJob) { job.DownloadedBytes = written })
	return len(data), nil
}

func (u *systemUpdater) download(ctx context.Context, release *systemUpdateRelease, destination string) error {
	target, err := url.Parse(release.BundleURL)
	if err != nil || !u.trustedURL(target) {
		return failUpdate("download_failed", errors.New("untrusted bundle URL"))
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return failUpdate("download_failed", err)
	}
	req.Header.Set("Accept", "application/octet-stream")
	req.Header.Set("User-Agent", "FluxMedia-SystemUpdater")
	res, err := u.httpClient.Do(req)
	if err != nil {
		return failUpdate("download_failed", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return failUpdate("download_failed", fmt.Errorf("unexpected status %d", res.StatusCode))
	}
	if res.ContentLength > systemUpdateMaxBundleBytes {
		return failUpdate("download_failed", errors.New("bundle exceeds the size limit"))
	}
	if res.ContentLength > 0 {
		u.updateJob(func(job *systemUpdateJob) { job.TotalBytes = res.ContentLength })
	}
	file, err := os.OpenFile(destination, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return failUpdate("download_failed", err)
	}
	hash := sha256.New()
	_, copyErr := io.Copy(io.MultiWriter(file, hash, &progressWriter{updater: u, limit: systemUpdateMaxBundleBytes}), res.Body)
	closeErr := file.Close()
	if copyErr != nil {
		return failUpdate("download_failed", copyErr)
	}
	if closeErr != nil {
		return failUpdate("download_failed", closeErr)
	}
	u.setPhase("verifying")
	if hex.EncodeToString(hash.Sum(nil)) != release.Manifest["APP_BUNDLE_SHA256"] {
		return failUpdate("checksum_mismatch", nil)
	}
	return nil
}

// verifyExtractedRelease checks that the bundle is the release the manifest
// describes and that it was built for the running image's platform.
func verifyExtractedRelease(root string, release *systemUpdateRelease, image releaseMetadata) error {
	metadata, err := readReleaseMetadata(root)
	if err != nil {
		return failUpdate("bundle_invalid", err)
	}
	if metadata.Version != release.Version || metadata.GitSHA != release.Manifest["GIT_SHA"] {
		return failUpdate("bundle_invalid", errors.New("bundle metadata does not match the release"))
	}
	if metadata.PlatformFingerprint != image.PlatformFingerprint {
		return failUpdate("platform_changed", nil)
	}
	backend, err := os.Lstat(filepath.Join(root, "backend"))
	if err != nil || !backend.Mode().IsRegular() || backend.Mode().Perm()&0o100 == 0 {
		return failUpdate("bundle_invalid", errors.New("backend executable is missing"))
	}
	if info, err := os.Lstat(filepath.Join(root, "services", "unified-runtime", "supervisor.mjs")); err != nil || !info.Mode().IsRegular() {
		return failUpdate("bundle_invalid", errors.New("supervisor is missing"))
	}
	return nil
}

// extractReleaseBundle unpacks a gzip tarball into an empty directory. Entries
// may not leave the directory or be written through a symlink, hardlinks must
// point at files already inside it, and symlink targets must be relative and
// lexically inside it. The bundle's content is trusted only after its SHA-256
// matched the release manifest; these rules keep extraction itself contained.
func extractReleaseBundle(archivePath, destination string) error {
	file, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer file.Close()
	decompressed, err := gzip.NewReader(file)
	if err != nil {
		return err
	}
	defer decompressed.Close()
	reader := tar.NewReader(decompressed)
	symlinks := map[string]bool{}
	underSymlink := func(name string) bool {
		for current := name; current != "."; current = path.Dir(current) {
			if symlinks[current] {
				return true
			}
		}
		return false
	}
	var total int64
	for entries := 0; ; entries++ {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		if entries >= systemUpdateMaxEntries {
			return errors.New("release bundle has too many entries")
		}
		if strings.HasPrefix(header.Name, "/") || strings.Contains(header.Name, "\\") {
			return errUnsafeBundle
		}
		name := path.Clean(header.Name)
		if name == "." {
			continue
		}
		if name == ".." || strings.HasPrefix(name, "../") || underSymlink(name) {
			return errUnsafeBundle
		}
		target := filepath.Join(destination, filepath.FromSlash(name))
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			total += header.Size
			if header.Size < 0 || total > systemUpdateMaxExtractedBytes {
				return errors.New("release bundle is too large")
			}
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			output, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, header.FileInfo().Mode().Perm()&0o755)
			if err != nil {
				return err
			}
			_, copyErr := io.CopyN(output, reader, header.Size)
			closeErr := output.Close()
			if copyErr != nil {
				return copyErr
			}
			if closeErr != nil {
				return closeErr
			}
		case tar.TypeSymlink:
			if header.Linkname == "" || path.IsAbs(header.Linkname) {
				return errUnsafeBundle
			}
			resolved := path.Join(path.Dir(name), header.Linkname)
			if resolved == ".." || strings.HasPrefix(resolved, "../") {
				return errUnsafeBundle
			}
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			if err := os.Symlink(header.Linkname, target); err != nil {
				return err
			}
			symlinks[name] = true
		case tar.TypeLink:
			linked := path.Clean(header.Linkname)
			if path.IsAbs(header.Linkname) || linked == ".." || strings.HasPrefix(linked, "../") || underSymlink(linked) {
				return errUnsafeBundle
			}
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			if err := os.Link(filepath.Join(destination, filepath.FromSlash(linked)), target); err != nil {
				return err
			}
		default:
			return errUnsafeBundle
		}
	}
}

// createBackup writes a custom-format pg_dump into the releases volume and
// keeps only the newest few backups.
func (u *systemUpdater) createBackup(ctx context.Context, version string) (string, error) {
	directory := filepath.Join(u.releasesDir, "backups")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return "", failUpdate("backup_failed", err)
	}
	name := u.now().UTC().Format("20060102T150405Z") + "-before-" + version + ".dump"
	partial := filepath.Join(directory, name+".partial")
	defer os.Remove(partial)
	backupCtx, cancel := context.WithTimeout(ctx, systemUpdateBackupTimeout)
	defer cancel()
	if err := u.backup(backupCtx, partial); err != nil {
		return "", failUpdate("backup_failed", err)
	}
	if err := os.Rename(partial, filepath.Join(directory, name)); err != nil {
		return "", failUpdate("backup_failed", err)
	}
	pruneBackups(directory, systemUpdateKeepBackups)
	return "backups/" + name, nil
}

func pruneBackups(directory string, keep int) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return
	}
	var names []string
	for _, entry := range entries {
		if entry.Type().IsRegular() && strings.HasSuffix(entry.Name(), ".dump") {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	for len(names) > keep {
		_ = os.Remove(filepath.Join(directory, names[0]))
		names = names[1:]
	}
}

// pgDumpConnection turns DATABASE_URL into a libpq connection string without
// the password (passed through PGPASSWORD) or pgx-only pool parameters.
func pgDumpConnection(databaseURL string) (connection, password string, err error) {
	if !strings.HasPrefix(databaseURL, "postgres://") && !strings.HasPrefix(databaseURL, "postgresql://") {
		return databaseURL, "", nil
	}
	parsed, err := url.Parse(databaseURL)
	if err != nil {
		return "", "", errors.New("DATABASE_URL is not a valid URL")
	}
	if parsed.User != nil {
		password, _ = parsed.User.Password()
		parsed.User = url.User(parsed.User.Username())
	}
	query := parsed.Query()
	for key := range query {
		if strings.HasPrefix(key, "pool_") || key == "statement_cache_capacity" || key == "description_cache_capacity" || key == "default_query_exec_mode" {
			query.Del(key)
		}
	}
	parsed.RawQuery = query.Encode()
	return parsed.String(), password, nil
}

func pgDumpBackup(ctx context.Context, tool, databaseURL, destination string) error {
	if tool == "" {
		return errors.New("pg_dump is not installed")
	}
	connection, password, err := pgDumpConnection(databaseURL)
	if err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, tool, "--format=custom", "--no-owner", "--no-privileges", "--file", destination, "--dbname", connection)
	cmd.Env = os.Environ()
	if password != "" {
		cmd.Env = append(cmd.Env, "PGPASSWORD="+password)
	}
	output, err := cmd.CombinedOutput()
	if err != nil {
		// pg_dump output can echo connection details; keep only the last line.
		lines := strings.Split(strings.TrimSpace(string(output)), "\n")
		return fmt.Errorf("pg_dump failed: %s", truncateRunes(lines[len(lines)-1], 300))
	}
	return nil
}

func (b *backend) registerSystemUpdateRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/admin/system-update", b.endpoint(b.handleSystemUpdateStatus))
	mux.HandleFunc("POST /api/admin/system-update", b.endpoint(b.handleStartSystemUpdate))
}

func (b *backend) handleSystemUpdateStatus(w http.ResponseWriter, r *http.Request) error {
	noStore(w)
	if _, err := b.requireAdmin(r, true); err != nil {
		return err
	}
	if b.updates == nil {
		return &apiError{http.StatusServiceUnavailable, "NOT_READY", "系统更新不可用"}
	}
	writeJSON(w, http.StatusOK, b.updates.status(r.Context(), r.URL.Query().Get("refresh") == "1"))
	return nil
}

func (b *backend) handleStartSystemUpdate(w http.ResponseWriter, r *http.Request) error {
	noStore(w)
	if err := b.checkOrigin(r); err != nil {
		return err
	}
	session, err := b.requireAdmin(r, true)
	if err != nil {
		return err
	}
	if b.updates == nil {
		return &apiError{http.StatusServiceUnavailable, "NOT_READY", "系统更新不可用"}
	}
	var input struct {
		Version string `json:"version"`
	}
	if err := decodeBody(r, &input); err != nil {
		return err
	}
	if !stableReleaseTagPattern.MatchString(input.Version) {
		return invalid("版本号无效")
	}
	from := b.updates.currentMetadata().Version
	job, err := b.updates.start(r.Context(), input.Version, session.User.ID)
	if err != nil {
		var conflict *systemUpdateConflict
		if errors.As(err, &conflict) {
			return &apiError{http.StatusConflict, strings.ToUpper(conflict.code), conflict.message}
		}
		return err
	}
	b.auditAdminWithMetadata(r.Context(), session.User.ID, "system.update.start", "站内系统更新", map[string]any{"version": from}, map[string]any{"version": input.Version}, map[string]any{"requestId": requestID(r)})
	writeJSON(w, http.StatusAccepted, map[string]any{"job": job})
	return nil
}
