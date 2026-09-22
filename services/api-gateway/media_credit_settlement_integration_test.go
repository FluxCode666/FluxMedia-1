//go:build integration

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestImagePendingExpiryPreservesModerationAndScopesUserAndTime(t *testing.T) {
	b := integrationBackend(t)
	b.config.cronSecret = "expiry-test"
	now := time.Now().UTC().Truncate(time.Millisecond)
	uid, _ := seedAuthUser(t, b)
	other, _ := seedAuthUser(t, b)
	creditTestWallet(t, b, uid, 20)
	creditTestBatch(t, b, uid, "purchase", 20, nil)
	creditTestWallet(t, b, other, 20)
	creditTestBatch(t, b, other, "purchase", 20, nil)
	var targetTask, targetID string
	for _, owner := range []string{uid, other} {
		task, id := seedModerationImageTask(t, b, owner, "test", nil)
		meta := map[string]any{"billingSnapshot": map[string]any{"version": 2, "moderationOnlyCredits": 0.25}, "moderation": map[string]any{"completed": true}}
		if _, err := b.db.Exec(context.Background(), `UPDATE generation SET created_at=$2,credits_consumed=6.25,metadata=$3 WHERE id=$1`, id, now.Add(-time.Hour), mustJSON(meta)); err != nil {
			t.Fatal(err)
		}
		tx, err := b.db.Begin(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if err = b.chargeImageGenerationTx(context.Background(), tx, owner, id, "", imageBillingQuote{Amount: 6.25}, nil); err != nil {
			rollback(tx)
			t.Fatal(err)
		}
		if err = tx.Commit(context.Background()); err != nil {
			t.Fatal(err)
		}
		if owner == uid {
			targetTask, targetID = task, id
		}
	}
	// A wallet freeze blocks spending; it must not prevent a system refund.
	if _, err := b.db.Exec(context.Background(), `UPDATE credits_balance SET status='frozen' WHERE user_id=$1`, uid); err != nil {
		t.Fatal(err)
	}
	details, err := b.expirePendingImages(context.Background(), imageExpiryOptions{UserID: uid, Now: &now, Limit: 1, TimeoutMS: 30 * 60 * 1000})
	if err != nil {
		t.Fatal(err)
	}
	if len(details) != 1 || details[0].GenerationID != targetID || details[0].CreditsRefunded != 6 || !details[0].RefundGranted {
		t.Fatalf("expiry result=%v", details)
	}
	balance, batches, count := creditState(t, b, uid)
	if balance != 19.75 || batches != 19.75 || count != 2 {
		t.Fatalf("settlement drift: %v %v %d", balance, batches, count)
	}
	var status string
	var retained, net float64
	if err = b.db.QueryRow(context.Background(), `SELECT t.status,g.credits_consumed,o.net_consumed FROM image_async_task t JOIN generation g ON g.id=t.generation_id JOIN credit_usage_operation o ON o.operation_id=g.id AND o.user_id=g.user_id WHERE t.id=$1`, targetTask).Scan(&status, &retained, &net); err != nil {
		t.Fatal(err)
	}
	if status != "failed" || retained != 0.25 || net != 0.25 {
		t.Fatalf("task/history/projection=%s %v %v", status, retained, net)
	}
	if details, err = b.expirePendingImages(context.Background(), imageExpiryOptions{UserID: uid, Now: &now}); err != nil || len(details) != 0 {
		t.Fatalf("expiry replay=%v %v", details, err)
	}
	otherBalance, _, _ := creditState(t, b, other)
	if otherBalance != 13.75 {
		t.Fatal("expiry crossed user scope")
	}
	body := fmt.Sprintf(`{"userId":%q,"now":%q,"timeoutMs":7200000}`, other, now.Format(time.RFC3339Nano))
	r := httptest.NewRequest(http.MethodPost, "http://localhost:3000/api/jobs/images/expire-pending", strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+b.config.cronSecret)
	w := httptest.NewRecorder()
	b.handler().ServeHTTP(w, r)
	out := requireCreditResponse(t, w, 200)
	if len(out["details"].([]any)) != 0 {
		t.Fatal("custom timeout fence ignored")
	}
}

func TestVideoBillingAndRefundShareRealLedgerAndQuota(t *testing.T) {
	b := integrationBackend(t)
	uid, _ := seedAuthUser(t, b)
	creditTestWallet(t, b, uid, 20.5)
	expired := time.Now().UTC().Add(-time.Hour)
	creditTestBatch(t, b, uid, "bonus", 2, &expired)
	creditTestBatch(t, b, uid, "purchase", 18.5, nil)
	key := newRequestID()
	hash := sha256.Sum256([]byte(key))
	if _, err := b.db.Exec(context.Background(), `INSERT INTO external_api_key(id,user_id,key_prefix,key_hash,last_four,credit_limit) VALUES($1,$2,'test',$3,'test',10)`, key, uid, hex.EncodeToString(hash[:])); err != nil {
		t.Fatal(err)
	}
	id := newRequestID()
	if _, err := b.db.Exec(context.Background(), `INSERT INTO video_generation(id,user_id,api_key_id,model,prompt,duration_seconds,aspect_ratio,resolution,status,stage,principal_scope,output_width,output_height,metadata) VALUES($1,$2,$3,'test','test',5,'16:9','720p','pending','created','user:'||$2,1280,720,$4)`, id, uid, key, mustJSON(map[string]any{"videoBillingSnapshot": map[string]any{"quotedCredits": 6.25}, "videoLedgerNamespace": "video"})); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	results := make(chan error, 6)
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); results <- b.chargeVideoTask(context.Background(), id) }()
	}
	wg.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatal(err)
		}
	}
	balance, batches, count := creditState(t, b, uid)
	if balance != 12.25 || batches != 12.25 || count != 2 {
		t.Fatalf("video charge/expiry=%v %v %d", balance, batches, count)
	}
	var used float64
	if err := b.db.QueryRow(context.Background(), `SELECT credits_used FROM external_api_key WHERE id=$1`, key).Scan(&used); err != nil || used != 6.25 {
		t.Fatalf("quota=%v %v", used, err)
	}
	// Reconcile a historical Go charge that omitted context but retained a
	// unique real transaction with the exact user, source reference and amount.
	if _, err := b.db.Exec(context.Background(), `UPDATE credits_transaction SET operation_type=NULL,operation_id=NULL,operation_created_at=NULL WHERE user_id=$1 AND type='consumption'`, uid); err != nil {
		t.Fatal(err)
	}
	worker := mediaWorker{backend: b}
	for i := 0; i < 2; i++ {
		if err := worker.refundVideoTask(context.Background(), id, "provider failed"); err != nil {
			t.Fatal(err)
		}
	}
	balance, batches, count = creditState(t, b, uid)
	if balance != 18.5 || batches != 18.5 || count != 3 {
		t.Fatalf("video refund=%v %v %d", balance, batches, count)
	}
	var net, reserved float64
	var stage string
	if err := b.db.QueryRow(context.Background(), `SELECT v.stage,v.api_key_credits_reserved,o.net_consumed,k.credits_used FROM video_generation v JOIN credit_usage_operation o ON o.user_id=v.user_id AND o.operation_id=v.id JOIN external_api_key k ON k.id=v.api_key_id WHERE v.id=$1`, id).Scan(&stage, &reserved, &net, &used); err != nil {
		t.Fatal(err)
	}
	if stage != "failed" || reserved != 0 || net != 0 || used != 0 {
		t.Fatalf("video quota/ledger drift=%s %v %v %v", stage, reserved, net, used)
	}
	orphan := newRequestID()
	if _, err := b.db.Exec(context.Background(), `INSERT INTO video_generation(id,user_id,model,prompt,duration_seconds,aspect_ratio,resolution,status,stage,principal_scope,output_width,output_height,credits_consumed) VALUES($1,$2,'test','test',5,'16:9','720p','failed','refunding','user:'||$2,1280,720,3)`, orphan, uid); err != nil {
		t.Fatal(err)
	}
	if err := worker.refundVideoTask(context.Background(), orphan, "missing ledger"); err == nil {
		t.Fatal("fabricated refundable ledger from video counter")
	}
	after, _, _ := creditState(t, b, uid)
	if after != balance {
		t.Fatal("invalid historical refund changed wallet")
	}
}
