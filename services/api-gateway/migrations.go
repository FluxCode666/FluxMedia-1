package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type migration struct {
	tag        string
	when       int64
	hash       string
	statements []string
}

// Read the existing Drizzle journal and SQL verbatim. Keeping the original
// hashes and timestamps lets Go resume the same migration ledger as Node.
func readMigrations(directory string) ([]migration, error) {
	data, err := os.ReadFile(filepath.Join(directory, "meta", "_journal.json"))
	if err != nil {
		return nil, fmt.Errorf("read migration journal: %w", err)
	}
	var journal struct {
		Entries []struct {
			Index int    `json:"idx"`
			When  int64  `json:"when"`
			Tag   string `json:"tag"`
		} `json:"entries"`
	}
	if err := json.Unmarshal(data, &journal); err != nil {
		return nil, fmt.Errorf("decode migration journal: %w", err)
	}
	if len(journal.Entries) == 0 {
		return nil, fmt.Errorf("migration journal is empty")
	}
	validTag := regexp.MustCompile(`^[0-9]{4}_[A-Za-z0-9_]+$`)
	seen := map[string]bool{}
	migrations := make([]migration, 0, len(journal.Entries))
	for i, entry := range journal.Entries {
		if entry.Index != i || entry.When <= 0 || !validTag.MatchString(entry.Tag) || seen[entry.Tag] {
			return nil, fmt.Errorf("invalid migration journal entry %d", i)
		}
		seen[entry.Tag] = true
		sql, err := os.ReadFile(filepath.Join(directory, entry.Tag+".sql"))
		if err != nil {
			return nil, fmt.Errorf("read migration %s: %w", entry.Tag, err)
		}
		hash := sha256.Sum256(sql)
		migrations = append(migrations, migration{tag: entry.Tag, when: entry.When, hash: hex.EncodeToString(hash[:]), statements: strings.Split(string(sql), "--> statement-breakpoint")})
	}
	return migrations, nil
}

func migrationDirectory() string {
	if directory := os.Getenv("GO_BACKEND_MIGRATIONS_DIR"); directory != "" {
		return directory
	}
	for _, directory := range []string{"migrations", "packages/database/drizzle", "../../packages/database/drizzle", "/app/migrations"} {
		if _, err := os.Stat(filepath.Join(directory, "meta", "_journal.json")); err == nil {
			return directory
		}
	}
	return "migrations"
}

func runMigrations(ctx context.Context, pool *pgxpool.Pool, directory string) (int, error) {
	migrations, err := readMigrations(directory)
	if err != nil {
		return 0, err
	}
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return 0, fmt.Errorf("acquire migration connection: %w", err)
	}
	defer conn.Release()
	// Serialize concurrent backend starts on the connection held until commit.
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock(708193775120)`); err != nil {
		return 0, fmt.Errorf("acquire migration lock: %w", err)
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := conn.Exec(cleanup, `SELECT pg_advisory_unlock(708193775120)`); err != nil {
			// A connection with an unknown lock state must never return to the pool.
			_ = conn.Conn().Close(cleanup)
		}
	}()
	tx, err := conn.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("begin migrations: %w", err)
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup)
	}()
	if _, err := tx.Exec(ctx, `SET LOCAL timezone = 'UTC'; CREATE SCHEMA IF NOT EXISTS drizzle; CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`, pgx.QueryExecModeSimpleProtocol); err != nil {
		return 0, fmt.Errorf("initialize migration ledger: %w", err)
	}
	var last int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE(max(created_at), 0) FROM drizzle.__drizzle_migrations`).Scan(&last); err != nil {
		return 0, fmt.Errorf("read migration ledger: %w", err)
	}
	count := 0
	for _, migration := range migrations {
		if migration.when <= last {
			continue
		}
		for _, statement := range migration.statements {
			if strings.TrimSpace(statement) == "" {
				continue
			}
			if _, err := tx.Exec(ctx, statement, pgx.QueryExecModeSimpleProtocol); err != nil {
				return 0, fmt.Errorf("apply migration %s: %w", migration.tag, err)
			}
		}
		if _, err := tx.Exec(ctx, `INSERT INTO drizzle.__drizzle_migrations (hash,created_at) VALUES ($1,$2)`, migration.hash, migration.when); err != nil {
			return 0, fmt.Errorf("record migration %s: %w", migration.tag, err)
		}
		count++
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit migrations: %w", err)
	}
	return count, nil
}
