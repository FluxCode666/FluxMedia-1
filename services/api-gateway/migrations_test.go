package main

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

func TestReadExistingDrizzleMigrations(t *testing.T) {
	migrations, err := readMigrations("../../packages/database/drizzle")
	if err != nil {
		t.Fatal(err)
	}
	if len(migrations) != 104 {
		t.Fatalf("migration count = %d; update test with journal changes", len(migrations))
	}
	first, err := os.ReadFile("../../packages/database/drizzle/0000_init.sql")
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(first)
	if migrations[0].hash != hex.EncodeToString(hash[:]) || len(migrations[0].statements) < 2 {
		t.Fatal("Drizzle hash or statement boundary changed")
	}
}
func TestMigrationJournalRejectsPathTraversalAndMissingSQL(t *testing.T) {
	for _, journal := range []string{`{"entries":[]}`, `{"entries":[{"idx":0,"when":1,"tag":"../../private"}]}`, `{"entries":[{"idx":0,"when":1,"tag":"0000_missing"}]}`} {
		dir := t.TempDir()
		if err := os.Mkdir(filepath.Join(dir, "meta"), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "meta", "_journal.json"), []byte(journal), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := readMigrations(dir); err == nil {
			t.Fatal("invalid migration set accepted")
		}
	}
}
