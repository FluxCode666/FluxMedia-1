// FluxMedia Go backend HTTP entrypoint.
//
// This process owns the backend dependency boundary. It connects directly to
// PostgreSQL and Redis; it never proxies requests to the Next.js web process.
package main

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

const (
	defaultBind         = ":8080"
	defaultMaxBodyBytes = int64(64 << 20)
	defaultReadHeader   = 10 * time.Second
	defaultReadTimeout  = 30 * time.Second
	defaultWriteTimeout = 30 * time.Minute
	defaultIdleTimeout  = 75 * time.Second
	defaultReadyTimeout = 2 * time.Second
	maxMaxBodyBytes     = int64(512 << 20)
	maxTimeout          = 2 * time.Hour
	requestIDHeader     = "X-Request-ID"
)

var requestIDPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

type config struct {
	bind           string
	databaseURL    string
	authSecret     string
	authURL        string
	trustedOrigins []string
	redisOptions   *redis.Options
	maxBodyBytes   int64
	readHeader     time.Duration
	readTimeout    time.Duration
	writeTimeout   time.Duration
	idleTimeout    time.Duration
	readyTimeout   time.Duration
}

type backend struct {
	mailDelivery    func(context.Context, outgoingMail) error
	oauthHTTPClient *http.Client
	config          config
	db              *pgxpool.Pool
	redis           *redis.Client
	logger          *slog.Logger
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--route-audit" {
		file := "../../docs/go-migration-inventory.json"
		if len(os.Args) > 2 {
			file = os.Args[2]
		}
		if err := auditRoutes(file); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	cfg, err := loadConfig(os.LookupEnv)
	if err != nil {
		fmt.Fprintf(os.Stderr, "backend configuration error: %v\n", err)
		os.Exit(1)
	}
	if len(os.Args) > 1 && os.Args[1] == "--healthcheck" {
		if err := runHealthcheck(cfg); err != nil {
			fmt.Fprintf(os.Stderr, "backend healthcheck failed: %v\n", err)
			os.Exit(1)
		}
		return
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	server, err := newBackend(ctx, cfg, slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	if err != nil {
		fmt.Fprintln(os.Stderr, "backend dependency initialization failed; check PostgreSQL and Redis configuration")
		os.Exit(1)
	}
	defer server.close()
	if os.Getenv("GO_BACKEND_SKIP_MIGRATION") != "true" {
		migrationCtx, migrationCancel := context.WithTimeout(ctx, 10*time.Minute)
		count, migrationErr := runMigrations(migrationCtx, server.db, migrationDirectory())
		migrationCancel()
		if migrationErr != nil {
			// SQL errors may contain credentials embedded in migration literals.
			server.logger.Error("database migration failed; backend will not start")
			server.close()
			os.Exit(1)
		}
		server.logger.Info("database migrations completed", "applied", count)
	}
	if os.Getenv("GO_BACKEND_MIGRATE_ONLY") == "true" || (len(os.Args) > 1 && os.Args[1] == "--migrate") {
		return
	}

	httpServer := &http.Server{
		Addr:              cfg.bind,
		Handler:           server.handler(),
		ReadHeaderTimeout: cfg.readHeader,
		ReadTimeout:       cfg.readTimeout,
		WriteTimeout:      cfg.writeTimeout,
		IdleTimeout:       cfg.idleTimeout,
		MaxHeaderBytes:    32 << 10,
	}
	serverErrors := make(chan error, 1)
	go func() { serverErrors <- httpServer.ListenAndServe() }()
	server.logger.Info("go backend listening", "bind", cfg.bind)

	select {
	case err := <-serverErrors:
		if !errors.Is(err, http.ErrServerClosed) {
			server.logger.Error("backend stopped unexpectedly", "error", err)
			os.Exit(1)
		}
	case <-ctx.Done():
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer shutdownCancel()
		if err := httpServer.Shutdown(shutdownCtx); err != nil {
			server.logger.Error("backend graceful shutdown failed", "error", err)
			os.Exit(1)
		}
	}
}

func newBackend(ctx context.Context, cfg config, logger *slog.Logger) (*backend, error) {
	poolConfig, err := pgxpool.ParseConfig(cfg.databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse DATABASE_URL: %w", err)
	}
	poolConfig.MaxConns = 10
	poolConfig.MinConns = 1
	poolConfig.ConnConfig.RuntimeParams["application_name"] = "fluxmedia-go-backend"
	poolConfig.ConnConfig.RuntimeParams["timezone"] = "UTC"
	db, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return nil, fmt.Errorf("create postgres pool: %w", err)
	}
	if err := db.Ping(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping postgres: %w", err)
	}
	client := redis.NewClient(cfg.redisOptions)
	if err := client.Ping(ctx).Err(); err != nil {
		_ = client.Close()
		db.Close()
		return nil, fmt.Errorf("ping redis: %w", err)
	}
	return &backend{config: cfg, db: db, redis: client, logger: logger}, nil
}

func (b *backend) close() {
	b.db.Close()
	_ = b.redis.Close()
}

func runHealthcheck(cfg config) error {
	ctx, cancel := context.WithTimeout(context.Background(), cfg.readyTimeout)
	defer cancel()
	host, port, err := net.SplitHostPort(cfg.bind)
	if err != nil {
		return errors.New("invalid backend bind address")
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+net.JoinHostPort(host, port)+"/readyz", nil)
	if err != nil {
		return err
	}
	response, err := (&http.Client{Timeout: cfg.readyTimeout}).Do(request)
	if err != nil {
		return errors.New("backend is not listening")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return errors.New("backend is not ready")
	}
	return nil
}

func loadConfig(getenv func(string) (string, bool)) (config, error) {
	databaseURL := requiredString(getenv, "DATABASE_URL")
	authSecret := requiredString(getenv, "BETTER_AUTH_SECRET")
	if authSecret == "" {
		return config{}, errors.New("BETTER_AUTH_SECRET must be configured")
	}
	authURL := getString(getenv, "BETTER_AUTH_URL", "http://localhost:3000")
	parsedAuthURL, authURLError := url.Parse(authURL)
	if authURLError != nil || parsedAuthURL.Host == "" || parsedAuthURL.User != nil || (parsedAuthURL.Scheme != "http" && parsedAuthURL.Scheme != "https") || parsedAuthURL.RawQuery != "" || parsedAuthURL.Fragment != "" || (parsedAuthURL.Path != "" && parsedAuthURL.Path != "/") {
		return config{}, errors.New("BETTER_AUTH_URL must be a valid HTTP(S) origin")
	}
	if databaseURL == "" {
		return config{}, errors.New("DATABASE_URL must be configured")
	}
	redisHost := requiredString(getenv, "REDIS_HOST")
	if redisHost == "" {
		return config{}, errors.New("REDIS_HOST must be configured")
	}
	redisPassword := requiredString(getenv, "REDIS_PASSWORD")
	if redisPassword == "" {
		return config{}, errors.New("REDIS_PASSWORD must be configured")
	}
	redisPort := getString(getenv, "REDIS_PORT", "6379")
	redisUsername := requiredString(getenv, "REDIS_USERNAME")
	if _, err := strconv.Atoi(redisPort); err != nil {
		return config{}, errors.New("REDIS_PORT must be a number")
	}
	redisDB, err := getBoundedInt64(getenv, "REDIS_DB", 4, 0, 15)
	if err != nil {
		return config{}, err
	}
	tlsEnabled, err := getBool(getenv, "REDIS_TLS", false)
	if err != nil {
		return config{}, err
	}

	maxBodyBytes, err := getBoundedInt64(getenv, "GO_BACKEND_MAX_BODY_BYTES", defaultMaxBodyBytes, 1, maxMaxBodyBytes)
	if err != nil {
		return config{}, err
	}
	readHeader, err := getBoundedDuration(getenv, "GO_BACKEND_READ_HEADER_TIMEOUT_MS", defaultReadHeader, time.Millisecond, maxTimeout)
	if err != nil {
		return config{}, err
	}
	readTimeout, err := getBoundedDuration(getenv, "GO_BACKEND_READ_TIMEOUT_MS", defaultReadTimeout, time.Millisecond, maxTimeout)
	if err != nil {
		return config{}, err
	}
	writeTimeout, err := getBoundedDuration(getenv, "GO_BACKEND_WRITE_TIMEOUT_MS", defaultWriteTimeout, time.Millisecond, maxTimeout)
	if err != nil {
		return config{}, err
	}
	idleTimeout, err := getBoundedDuration(getenv, "GO_BACKEND_IDLE_TIMEOUT_MS", defaultIdleTimeout, time.Millisecond, maxTimeout)
	if err != nil {
		return config{}, err
	}
	readyTimeout, err := getBoundedDuration(getenv, "GO_BACKEND_READY_TIMEOUT_MS", defaultReadyTimeout, time.Millisecond, maxTimeout)
	if err != nil {
		return config{}, err
	}

	return config{
		authSecret: authSecret, authURL: strings.TrimRight(authURL, "/"),
		trustedOrigins: strings.FieldsFunc(requiredString(getenv, "BETTER_AUTH_TRUSTED_ORIGINS"), func(r rune) bool { return r == ',' || r == ' ' }),
		bind:           getString(getenv, "GO_BACKEND_BIND", defaultBind), databaseURL: databaseURL,
		redisOptions: &redis.Options{
			Addr: netJoinHostPort(redisHost, redisPort), Password: redisPassword,
			Username: redisUsername,
			DB:       int(redisDB), TLSConfig: tlsConfig(tlsEnabled),
		},
		maxBodyBytes: maxBodyBytes, readHeader: readHeader, readTimeout: readTimeout,
		writeTimeout: writeTimeout, idleTimeout: idleTimeout, readyTimeout: readyTimeout,
	}, nil
}

func netJoinHostPort(host, port string) string {
	if strings.Contains(host, ":") && !strings.HasPrefix(host, "[") {
		return "[" + host + "]:" + port
	}
	return host + ":" + port
}

func tlsConfig(enabled bool) *tls.Config {
	if !enabled {
		return nil
	}
	return &tls.Config{MinVersion: tls.VersionTLS12} //nolint:gosec // minimum production Redis TLS version
}

func (b *backend) handler() http.Handler {
	return withRequestID(b.logger, withBodyLimit(b.config.maxBodyBytes, b.router()))
}

func (b *backend) router() *http.ServeMux {
	mux := http.NewServeMux()
	b.registerAuth(mux)
	b.registerExternalAPI(mux)
	mux.HandleFunc("GET /healthz", b.handleHealth)
	mux.HandleFunc("GET /readyz", b.handleReady)
	mux.HandleFunc("/", b.handleNotMigrated)
	return mux
}

func (b *backend) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "service": "go-backend"})
}

func (b *backend) handleReady(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), b.config.readyTimeout)
	defer cancel()
	if err := b.db.Ping(ctx); err != nil {
		writeJSONError(w, http.StatusServiceUnavailable, "postgres_unavailable", "The backend is not ready.")
		return
	}
	if err := b.redis.Ping(ctx).Err(); err != nil {
		writeJSONError(w, http.StatusServiceUnavailable, "redis_unavailable", "The backend is not ready.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready", "service": "go-backend"})
}

func (b *backend) handleNotMigrated(w http.ResponseWriter, r *http.Request) {
	// Returning an explicit response prevents an accidental fallback to Next.js.
	// Each route is implemented in Go before it is registered here.
	writeJSONError(w, http.StatusNotImplemented, "route_not_migrated", "This backend route has not been implemented in Go yet.")
	b.logger.WarnContext(r.Context(), "unimplemented backend route", "method", r.Method, "path", safeLogPath(r.URL.Path), "request_id", requestID(r))
}

func requiredString(getenv func(string) (string, bool), key string) string {
	value, _ := getenv(key)
	return strings.TrimSpace(value)
}

func getString(getenv func(string) (string, bool), key, fallback string) string {
	if value := requiredString(getenv, key); value != "" {
		return value
	}
	return fallback
}

func getBool(getenv func(string) (string, bool), key string, fallback bool) (bool, error) {
	value := requiredString(getenv, key)
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return false, fmt.Errorf("%s must be true or false", key)
	}
	return parsed, nil
}

func getBoundedInt64(getenv func(string) (string, bool), key string, fallback, minimum, maximum int64) (int64, error) {
	raw := requiredString(getenv, key)
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < minimum || value > maximum {
		return 0, fmt.Errorf("%s must be an integer between %d and %d", key, minimum, maximum)
	}
	return value, nil
}

func getBoundedDuration(getenv func(string) (string, bool), key string, fallback, minimum, maximum time.Duration) (time.Duration, error) {
	value, err := getBoundedInt64(getenv, key, int64(fallback/time.Millisecond), int64(minimum/time.Millisecond), int64(maximum/time.Millisecond))
	if err != nil {
		return 0, err
	}
	return time.Duration(value) * time.Millisecond, nil
}

func withRequestID(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimSpace(r.Header.Get(requestIDHeader))
		if !requestIDPattern.MatchString(id) {
			id = newRequestID()
			r.Header.Set(requestIDHeader, id)
		}
		w.Header().Set(requestIDHeader, id)
		logger.InfoContext(r.Context(), "http request", "method", r.Method, "path", safeLogPath(r.URL.Path), "request_id", id)
		next.ServeHTTP(w, r)
	})
}

func withBodyLimit(maxBytes int64, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.ContentLength > maxBytes {
			writeJSONError(w, http.StatusRequestEntityTooLarge, "request_body_too_large", "The request body is too large.")
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
		next.ServeHTTP(w, r)
	})
}

func safeLogPath(path string) string {
	if strings.HasPrefix(path, "/api/auth/reset-password/") {
		return "/api/auth/reset-password/[token]"
	}
	return path
}

func newRequestID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 10)
	}
	return hex.EncodeToString(bytes[:])
}

func requestID(r *http.Request) string { return r.Header.Get(requestIDHeader) }

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeJSONError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"message": message, "type": "backend_error", "code": code}})
}
