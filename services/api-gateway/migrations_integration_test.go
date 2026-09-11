//go:build integration

package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func migrationFixture(t *testing.T, sql string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "meta"), 0700); err != nil {
		t.Fatal(err)
	}
	journal, _ := json.Marshal(map[string]any{"entries": []map[string]any{{"idx": 0, "when": int64(9999999999999), "tag": "0000_test"}}})
	if err := os.WriteFile(filepath.Join(dir, "meta", "_journal.json"), journal, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "0000_test.sql"), []byte(sql), 0600); err != nil {
		t.Fatal(err)
	}
	return dir
}
func TestMigrationFailureRollsBackDDLAndLedger(t *testing.T) {
	b := integrationBackend(t)
	dir := migrationFixture(t, `CREATE TABLE go_migration_rollback_probe(id integer); --> statement-breakpoint SELECT nonexistent_migration_function();`)
	var before int
	if err := b.db.QueryRow(context.Background(), `SELECT count(*) FROM drizzle.__drizzle_migrations`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if _, err := runMigrations(context.Background(), b.db, dir); err == nil {
		t.Fatal("bad migration succeeded")
	}
	var exists bool
	var after int
	if err := b.db.QueryRow(context.Background(), `SELECT to_regclass('go_migration_rollback_probe') IS NOT NULL`).Scan(&exists); err != nil {
		t.Fatal(err)
	}
	if err := b.db.QueryRow(context.Background(), `SELECT count(*) FROM drizzle.__drizzle_migrations`).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if exists || before != after {
		t.Fatal("migration failure left partial schema or ledger")
	}
	if count, err := runMigrations(context.Background(), b.db, "../../packages/database/drizzle"); err != nil || count != 0 {
		t.Fatal("failed migration leaked connection lock")
	}
}
func TestMigrationLockCancellationDoesNotLeak(t *testing.T) {
	b := integrationBackend(t)
	ctx := context.Background()
	conn, err := b.db.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock(708193775120)`); err != nil {
		t.Fatal(err)
	}
	timeout, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
	defer cancel()
	if _, err := runMigrations(timeout, b.db, "../../packages/database/drizzle"); err == nil {
		t.Fatal("migration ignored held lock")
	}
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_unlock(708193775120)`); err != nil {
		t.Fatal(err)
	}
	if count, err := runMigrations(ctx, b.db, "../../packages/database/drizzle"); err != nil || count != 0 {
		t.Fatal("migration lock leaked after cancellation")
	}
}
