//go:build integration

package main

import (
	"context"
	"testing"
	"time"
)

func TestImageRetentionPerUserKeepsLedgerAndSharedFiles(t *testing.T) {
	b := integrationBackend(t)
	b.config.storagePath = t.TempDir()
	ctx := context.Background()
	setStorageTestSetting(t, b, "STORAGE_ENDPOINT", "")
	u1, _ := seedAuthUser(t, b)
	u2, _ := seedAuthUser(t, b)
	old := time.Now().UTC().Add(-4 * time.Hour)
	recent := old.Add(time.Hour)
	seed := func(uid string, at time.Time, key string) string {
		t.Helper()
		id := newRequestID()
		_, err := b.db.Exec(ctx, `INSERT INTO generation(id,user_id,prompt,model,status,storage_key,storage_bucket,credits_consumed,created_at,completed_at) VALUES($1,$2,'keep record','test','completed',$3,'generations',4,$4,$4)`, id, uid, key, at)
		if err != nil {
			t.Fatal(err)
		}
		if err := b.putStorageObject(ctx, "generations", key, []byte("test output"), "image/png"); err != nil {
			t.Fatal(err)
		}
		return id
	}
	first := seed(u1, old, u1+"/first.png")
	second := seed(u1, recent, u1+"/second.png")
	shared := seed(u2, recent, u1+"/first.png")
	_, err := b.db.Exec(ctx, `INSERT INTO credits_transaction(id,user_id,type,amount,debit_account,credit_account,description,source_ref) VALUES($1,$2,'consumption',4,$3,'SYSTEM:image','test',$4)`, newRequestID(), u1, "WALLET:"+u1, first)
	if err != nil {
		t.Fatal(err)
	}
	setStorageTestSetting(t, b, "GENERATION_IMAGE_RETENTION_MODE", "off")
	if out, err := b.runImageRetention(ctx, imageRetentionOptions{}); err != nil || out.Enabled || out.Destroyed != 0 {
		t.Fatalf("disabled retention %+v %v", out, err)
	}
	count := 1
	out, err := b.runImageRetention(ctx, imageRetentionOptions{Mode: "count", MaxCount: &count})
	if err != nil || out.Destroyed != 1 || len(out.Details) != 1 || out.Details[0].GenerationID != first {
		t.Fatalf("per-user retention %+v %v", out, err)
	}
	if _, err := b.readStorageObject(ctx, "generations", u1+"/first.png"); err != nil {
		t.Fatal("shared media removed")
	}
	var rows, transactions int
	var charged float64
	if err := b.db.QueryRow(ctx, `SELECT count(*),sum(credits_consumed) FROM generation WHERE id=ANY($1)`, []string{first, second, shared}).Scan(&rows, &charged); err != nil {
		t.Fatal(err)
	}
	if err := b.db.QueryRow(ctx, `SELECT count(*) FROM credits_transaction WHERE user_id=$1`, u1).Scan(&transactions); err != nil {
		t.Fatal(err)
	}
	if rows != 3 || charged != 12 || transactions != 1 {
		t.Fatalf("billing history changed: %d %v %d", rows, charged, transactions)
	}
	if out, err := b.runImageRetention(ctx, imageRetentionOptions{Mode: "count", MaxCount: &count}); err != nil || out.Destroyed != 0 {
		t.Fatalf("repeat retention %+v %v", out, err)
	}
	hours := 1.0
	out, err = b.runImageRetention(ctx, imageRetentionOptions{Mode: "time", RetentionHours: &hours})
	if err != nil || out.Destroyed != 2 {
		t.Fatalf("time retention %+v %v", out, err)
	}
	if _, err := b.readStorageObject(ctx, "generations", u1+"/first.png"); err == nil {
		t.Fatal("last reference was not deleted")
	}
}

func TestImageRetentionDeleteFailureKeepsVisibleProjection(t *testing.T) {
	b := integrationBackend(t)
	b.config.storagePath = t.TempDir()
	ctx := context.Background()
	setStorageTestSetting(t, b, "STORAGE_ENDPOINT", "")
	uid, _ := seedAuthUser(t, b)
	id := newRequestID()
	if _, err := b.db.Exec(ctx, `INSERT INTO generation(id,user_id,prompt,model,status,storage_key,storage_bucket,created_at,completed_at) VALUES($1,$2,'test','test','completed','../invalid','generations',now()-interval '2 hours',now()-interval '2 hours')`, id, uid); err != nil {
		t.Fatal(err)
	}
	hours := 1.0
	out, err := b.runImageRetention(ctx, imageRetentionOptions{Mode: "time", RetentionHours: &hours})
	if err != nil || out.Destroyed != 0 || out.Failed != 1 {
		t.Fatalf("failure %+v %v", out, err)
	}
	var key *string
	if err := b.db.QueryRow(ctx, `SELECT storage_key FROM generation WHERE id=$1`, id).Scan(&key); err != nil || key == nil {
		t.Fatal("failed deletion hidden from retry")
	}
}

func TestImageRetentionPreservesPendingInputReference(t *testing.T) {
	b := integrationBackend(t)
	b.config.storagePath = t.TempDir()
	ctx := context.Background()
	setStorageTestSetting(t, b, "STORAGE_ENDPOINT", "")
	uid, _ := seedAuthUser(t, b)
	key := uid + "/retained-input.png"
	output, pending := newRequestID(), newRequestID()
	if err := b.putStorageObject(ctx, "generations", key, []byte("input"), "image/png"); err != nil {
		t.Fatal(err)
	}
	if _, err := b.db.Exec(ctx, `INSERT INTO generation(id,user_id,prompt,model,status,storage_key,storage_bucket) VALUES($1,$2,'test','test','completed',$3,'generations')`, output, uid, key); err != nil {
		t.Fatal(err)
	}
	meta := map[string]any{"inputImages": map[string]any{"images": []any{map[string]any{"storageKey": key, "storageBucket": "generations"}}}}
	if _, err := b.db.Exec(ctx, `INSERT INTO generation(id,user_id,prompt,model,status,metadata) VALUES($1,$2,'test','test','pending',$3)`, pending, uid, mustJSON(meta)); err != nil {
		t.Fatal(err)
	}
	deleted, changed, err := b.purgeGenerationPhotos(ctx, uid, output, "user_deleted", 0, 0, time.Now())
	if err != nil || deleted != 0 || !changed {
		t.Fatalf("pending shared input: %d %v %v", deleted, changed, err)
	}
	if _, err := b.readStorageObject(ctx, "generations", key); err != nil {
		t.Fatal("pending input deleted", err)
	}
}
