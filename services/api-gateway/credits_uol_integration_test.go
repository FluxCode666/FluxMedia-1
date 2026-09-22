//go:build integration

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func creditsRequest(b *backend, in any, cookie *http.Cookie, internal bool) *httptest.ResponseRecorder {
	raw, _ := json.Marshal(in)
	r := httptest.NewRequest(http.MethodPost, "http://localhost:3000/api/internal/credits/operation", strings.NewReader(string(raw)))
	r.Header.Set("Content-Type", "application/json")
	if cookie != nil {
		r.AddCookie(cookie)
	}
	if internal {
		r.Header.Set("Authorization", "Bearer "+b.config.cronSecret)
	}
	w := httptest.NewRecorder()
	b.handler().ServeHTTP(w, r)
	return w
}
func creditTestWallet(t *testing.T, b *backend, uid string, balance float64) {
	t.Helper()
	_, e := b.db.Exec(context.Background(), `INSERT INTO credits_balance(id,user_id,balance,total_earned) VALUES($1,$2,$3,$3)`, newRequestID(), uid, balance)
	if e != nil {
		t.Fatal(e)
	}
}
func creditTestBatch(t *testing.T, b *backend, uid, source string, amount float64, expires *time.Time) string {
	t.Helper()
	id := newRequestID()
	_, e := b.db.Exec(context.Background(), `INSERT INTO credits_batch(id,user_id,amount,remaining,source_type,expires_at) VALUES($1,$2,$3,$3,$4,$5)`, id, uid, amount, source, expires)
	if e != nil {
		t.Fatal(e)
	}
	return id
}
func requireCreditResponse(t *testing.T, w *httptest.ResponseRecorder, want int) map[string]any {
	t.Helper()
	if w.Code != want {
		t.Fatalf("HTTP %d, want %d: %s", w.Code, want, w.Body.String())
	}
	var out map[string]any
	if e := json.Unmarshal(w.Body.Bytes(), &out); e != nil {
		t.Fatal(e)
	}
	return out
}
func creditState(t *testing.T, b *backend, uid string) (balance, remaining float64, transactions int) {
	t.Helper()
	if e := b.db.QueryRow(context.Background(), `SELECT balance,(SELECT COALESCE(sum(remaining),0) FROM credits_batch WHERE user_id=$1 AND status='active'),(SELECT count(*) FROM credits_transaction WHERE user_id=$1) FROM credits_balance WHERE user_id=$1`, uid).Scan(&balance, &remaining, &transactions); e != nil {
		t.Fatal(e)
	}
	return
}

func TestCreditsUOLLedgerAndPermissions(t *testing.T) {
	b := integrationBackend(t)
	b.config.cronSecret = "credits-test-cron"
	b.config.internalPrincipalSecret = "credits-test-principal"
	t.Run("grant retry is idempotent and scoped", func(t *testing.T) {
		uid, _ := seedAuthUser(t, b)
		other, _ := seedAuthUser(t, b)
		ref := "grant-" + newRequestID()
		in := creditMutation{Operation: "grant", UserID: uid, Amount: 12.34, SourceType: "purchase", SourceRef: ref}
		var wg sync.WaitGroup
		codes := make(chan int, 8)
		for i := 0; i < 8; i++ {
			wg.Add(1)
			go func() { defer wg.Done(); codes <- creditsRequest(b, in, nil, true).Code }()
		}
		wg.Wait()
		close(codes)
		for code := range codes {
			if code != 200 {
				t.Errorf("grant retry status=%d", code)
			}
		}
		balance, batches, count := creditState(t, b, uid)
		if balance != 12.34 || batches != 12.34 || count != 1 {
			t.Fatalf("grant drift: balance=%v batches=%v count=%d", balance, batches, count)
		}
		in.UserID = other
		requireCreditResponse(t, creditsRequest(b, in, nil, true), 409)
		in.UserID = uid
		in.Amount = 99
		requireCreditResponse(t, creditsRequest(b, in, nil, true), 409)
	})
	t.Run("expiry FIFO spend and refund share ledger projections", func(t *testing.T) {
		uid, _ := seedAuthUser(t, b)
		creditTestWallet(t, b, uid, 30)
		expired := time.Now().UTC().Add(-time.Hour)
		first := time.Now().UTC().Add(time.Hour)
		second := time.Now().UTC().Add(2 * time.Hour)
		creditTestBatch(t, b, uid, "bonus", 5, &expired)
		firstID := creditTestBatch(t, b, uid, "purchase", 4, &first)
		secondID := creditTestBatch(t, b, uid, "bonus", 8, &second)
		lastID := creditTestBatch(t, b, uid, "purchase", 13, nil)
		in := creditMutation{Operation: "consume", UserID: uid, Amount: 10, Type: "manual", SourceRef: "spend-" + newRequestID()}
		out := requireCreditResponse(t, creditsRequest(b, in, nil, true), 200)
		if out["balance"] != float64(15) {
			t.Fatalf("balance=%v", out["balance"])
		}
		for id, want := range map[string]float64{firstID: 0, secondID: 2, lastID: 13} {
			var got float64
			if e := b.db.QueryRow(context.Background(), `SELECT remaining FROM credits_batch WHERE id=$1`, id).Scan(&got); e != nil || got != want {
				t.Fatalf("batch remaining=%v want=%v err=%v", got, want, e)
			}
		}
		var wg sync.WaitGroup
		codes := make(chan int, 6)
		for i := 0; i < 6; i++ {
			wg.Add(1)
			go func() { defer wg.Done(); codes <- creditsRequest(b, in, nil, true).Code }()
		}
		wg.Wait()
		close(codes)
		for code := range codes {
			if code != 200 {
				t.Errorf("consume retry status=%d", code)
			}
		}
		balance, batches, count := creditState(t, b, uid)
		if balance != 15 || batches != 15 || count != 2 {
			t.Fatalf("spend drift: %v %v %d", balance, batches, count)
		}
		var opType, opID string
		var opAt time.Time
		if e := b.db.QueryRow(context.Background(), `SELECT operation_type,operation_id,operation_created_at FROM credits_transaction WHERE id=$1`, out["transactionId"]).Scan(&opType, &opID, &opAt); e != nil {
			t.Fatal(e)
		}
		refund := creditMutation{Operation: "refund", UserID: uid, Amount: 3.21, SourceRef: "refund-" + newRequestID(), OperationType: opType, OperationID: opID, OperationCreatedAt: &opAt}
		for i := 0; i < 2; i++ {
			requireCreditResponse(t, creditsRequest(b, refund, nil, true), 200)
		}
		balance, batches, count = creditState(t, b, uid)
		if balance != 18.21 || batches != 18.21 || count != 3 {
			t.Fatalf("refund drift: %v %v %d", balance, batches, count)
		}
		var gross, refunded, net float64
		var entries int
		if e := b.db.QueryRow(context.Background(), `SELECT gross_consumed,refunded,net_consumed,(SELECT count(*) FROM credit_usage_projection_entry WHERE user_id=$1) FROM credit_usage_operation WHERE user_id=$1 AND operation_id=$2`, uid, opID).Scan(&gross, &refunded, &net, &entries); e != nil {
			t.Fatal(e)
		}
		if gross != 10 || refunded != 3.21 || net != 6.79 || entries != 2 {
			t.Fatalf("projection drift: %v %v %v entries=%d", gross, refunded, net, entries)
		}
		refund.SourceRef = "overrefund-" + newRequestID()
		refund.Amount = 7
		requireCreditResponse(t, creditsRequest(b, refund, nil, true), 409)
		refund.Amount = 1
		refund.OperationID = "different"
		requireCreditResponse(t, creditsRequest(b, refund, nil, true), 409)
		in.Amount = 11
		requireCreditResponse(t, creditsRequest(b, in, nil, true), 409)
	})
	t.Run("ordinary users cannot grant or debit another account", func(t *testing.T) {
		uid, email := seedAuthUser(t, b)
		other, _ := seedAuthUser(t, b)
		cookie := signInTestUser(t, b, email)
		creditTestWallet(t, b, uid, 10)
		creditTestBatch(t, b, uid, "purchase", 10, nil)
		for _, in := range []creditMutation{{Operation: "grant", UserID: uid, Amount: 10, SourceType: "bonus"}, {Operation: "consume", UserID: other, Amount: 1, Type: "manual"}, {Operation: "refund", UserID: uid, Amount: 1}, {Operation: "processExpired", UserID: uid}} {
			requireCreditResponse(t, creditsRequest(b, in, cookie, false), 403)
		}
		requireCreditResponse(t, creditsRequest(b, creditMutation{Operation: "consume", UserID: uid, Amount: 1.25, Type: "manual"}, cookie, false), 200)
		balance, batches, _ := creditState(t, b, uid)
		if balance != 8.75 || batches != 8.75 {
			t.Fatal("own spend did not update batches")
		}
		if _, e := b.db.Exec(context.Background(), `UPDATE credits_balance SET status='frozen' WHERE user_id=$1`, uid); e != nil {
			t.Fatal(e)
		}
		requireCreditResponse(t, creditsRequest(b, creditMutation{Operation: "consume", UserID: uid, Amount: 1, Type: "manual"}, cookie, false), 403)
		requireCreditResponse(t, creditsRequest(b, creditMutation{Operation: "grant", UserID: uid, Amount: 1, SourceType: "bonus"}, nil, true), 403)
		requireCreditResponse(t, authRequest(t, b, "POST", "/api/credits/check", `{"amount":1}`, cookie), 200)
		var check map[string]any
		w := authRequest(t, b, "POST", "/api/credits/check", `{"amount":1}`, cookie)
		_ = json.Unmarshal(w.Body.Bytes(), &check)
		if check["available"] != false {
			t.Fatal("frozen wallet reported available")
		}
	})
	t.Run("admin reads paginate complete fractional ledger and set is atomic", func(t *testing.T) {
		adminID, email := seedAuthUser(t, b)
		uid, _ := seedAuthUser(t, b)
		if _, e := b.db.Exec(context.Background(), `UPDATE "user" SET role='super_admin' WHERE id=$1`, adminID); e != nil {
			t.Fatal(e)
		}
		cookie := signInTestUser(t, b, email)
		for i := 0; i < 25; i++ {
			in := creditMutation{Operation: "grant", UserID: uid, Amount: 1.25, SourceType: "purchase", SourceRef: fmt.Sprintf("%s-%d", uid, i)}
			requireCreditResponse(t, creditsRequest(b, in, nil, true), 200)
		}
		path := "/api/admin/users/" + uid + "/credits/transactions?limit=5&offset=20"
		out := requireCreditResponse(t, authRequest(t, b, "GET", path, "", cookie), 200)
		if out["totalCount"] != float64(25) || len(out["transactions"].([]any)) != 5 {
			t.Fatal("admin ledger truncated before pagination")
		}
		row := out["transactions"].([]any)[0].(map[string]any)
		if row["amount"] != 1.25 || row["sourceRef"] == nil {
			t.Fatal("fractional amount or source reference lost")
		}
		out = requireCreditResponse(t, authRequest(t, b, "POST", "/api/admin/users/"+uid+"/credits/adjust", `{"mode":"set","amount":10.5,"reason":"test"}`, cookie), 200)
		if out["previousBalance"] != 31.25 || out["newBalance"] != 10.5 {
			t.Fatalf("admin set response=%v", out)
		}
		balance, batches, _ := creditState(t, b, uid)
		if balance != 10.5 || batches != 10.5 {
			t.Fatal("admin set bypassed batch ledger")
		}
		requireCreditResponse(t, authRequest(t, b, "POST", "/api/admin/users/"+uid+"/credits/adjust", `{"mode":"deduct","amount":100}`, cookie), 402)
		out = requireCreditResponse(t, authRequest(t, b, "POST", "/api/admin/users/"+uid+"/credits/grant", `{"amount":2.75,"reason":"test"}`, cookie), 200)
		if out["batchId"] == "" || out["balance"] != 13.25 {
			t.Fatal("admin grant did not return real batch")
		}
		requireCreditResponse(t, authRequest(t, b, "POST", "/api/admin/users/"+adminID+"/credits/grant", `{"amount":1}`, cookie), 403)
		out = requireCreditResponse(t, authRequest(t, b, "POST", "/api/admin/users/"+uid+"/credits/status", `{"status":"frozen","reason":"test freeze"}`, cookie), 200)
		if out["previousStatus"] != "active" || out["status"] != "frozen" {
			t.Fatalf("status transition=%v", out)
		}
		requireCreditResponse(t, authRequest(t, b, "POST", "/api/admin/users/"+uid+"/credits/grant", `{"amount":1}`, cookie), 403)
		requireCreditResponse(t, authRequest(t, b, "POST", "/api/admin/users/"+uid+"/credits/status", `{"status":"active"}`, cookie), 200)
		requireCreditResponse(t, authRequest(t, b, "POST", "/api/admin/users/"+adminID+"/credits/status", `{"status":"frozen"}`, cookie), 403)
		var auditCount int
		if e := b.db.QueryRow(context.Background(), `SELECT count(*) FROM admin_audit_log WHERE target_user_id=$1 AND action='credits.status'`, uid).Scan(&auditCount); e != nil || auditCount != 2 {
			t.Fatalf("missing transactional status audit=%d err=%v", auditCount, e)
		}
	})
	t.Run("signed external principal still requires an active owned key", func(t *testing.T) {
		uid, _ := seedAuthUser(t, b)
		other, _ := seedAuthUser(t, b)
		creditTestWallet(t, b, uid, 7.5)
		key := newRequestID()
		hash := sha256.Sum256([]byte(key))
		if _, e := b.db.Exec(context.Background(), `INSERT INTO external_api_key(id,user_id,key_prefix,key_hash,last_four) VALUES($1,$2,'test',$3,'last')`, key, uid, hex.EncodeToString(hash[:])); e != nil {
			t.Fatal(e)
		}
		call := func(p internalPrincipal, paths ...string) *httptest.ResponseRecorder {
			encoded, sig, _ := internalPrincipalHeaders(p, b.config.internalPrincipalSecret)
			path := "/v1/credits"
			if len(paths) > 0 {
				path = paths[0]
			}
			r := httptest.NewRequest("GET", "http://localhost:3000"+path, nil)
			r.Header.Set("X-Flux-Principal", encoded)
			r.Header.Set("X-Flux-Principal-Signature", sig)
			w := httptest.NewRecorder()
			b.handler().ServeHTTP(w, r)
			return w
		}
		p := internalPrincipal{Type: "apiKey", CredentialKind: "external", UserID: uid, APIKeyID: key}
		requireCreditResponse(t, call(p), 200)
		p.UserID = other
		requireCreditResponse(t, call(p), 401)
		p.UserID = uid
		p.CredentialKind = "mcp"
		requireCreditResponse(t, call(p), 401)
		p.CredentialKind = "external"
		if _, e := b.db.Exec(context.Background(), `UPDATE external_api_key SET is_active=false WHERE id=$1`, key); e != nil {
			t.Fatal(e)
		}
		requireCreditResponse(t, call(p), 401)
		requireCreditResponse(t, call(p, "/v1/models"), 401)
		requireCreditResponse(t, call(p, "/v1/images/anything"), 401)
	})
}

func TestImageCreditsAtomicCharge(t *testing.T) {
	b := integrationBackend(t)
	uid, _ := seedAuthUser(t, b)
	creditTestWallet(t, b, uid, 30)
	expired := time.Now().UTC().Add(-time.Hour)
	soon := time.Now().UTC().Add(time.Hour)
	creditTestBatch(t, b, uid, "bonus", 5, &expired)
	firstID := creditTestBatch(t, b, uid, "bonus", 4, &soon)
	creditTestBatch(t, b, uid, "purchase", 21, nil)
	key := newRequestID()
	hash := sha256.Sum256([]byte(key))
	if _, e := b.db.Exec(context.Background(), `INSERT INTO external_api_key(id,user_id,key_prefix,key_hash,last_four,credit_limit) VALUES($1,$2,'test',$3,'last',20)`, key, uid, hex.EncodeToString(hash[:])); e != nil {
		t.Fatal(e)
	}
	generation := newRequestID()
	if _, e := b.db.Exec(context.Background(), `INSERT INTO generation(id,user_id,prompt,model,status,credits_consumed) VALUES($1,$2,'test','test','pending',6.25)`, generation, uid); e != nil {
		t.Fatal(e)
	}
	charge := func(gen string, amount float64) error {
		ctx := context.Background()
		tx, e := b.db.Begin(ctx)
		if e != nil {
			return e
		}
		defer rollback(tx)
		e = b.chargeImageGenerationTx(ctx, tx, uid, gen, key, imageBillingQuote{Amount: amount, Snapshot: map[string]any{"amount": amount}}, nil)
		if e != nil {
			return e
		}
		return tx.Commit(ctx)
	}
	if e := charge(generation, 6.25); e != nil {
		t.Fatal(e)
	}
	var wg sync.WaitGroup
	errs := make(chan error, 6)
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); errs <- charge(generation, 6.25) }()
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		if e != nil {
			t.Error(e)
		}
	}
	balance, batches, count := creditState(t, b, uid)
	if balance != 18.75 || batches != 18.75 || count != 2 {
		t.Fatalf("image charge drift %v %v count=%d", balance, batches, count)
	}
	var firstRemaining, used float64
	if e := b.db.QueryRow(context.Background(), `SELECT remaining FROM credits_batch WHERE id=$1`, firstID).Scan(&firstRemaining); e != nil || firstRemaining != 0 {
		t.Fatalf("FIFO failed: %v %v", firstRemaining, e)
	}
	if e := b.db.QueryRow(context.Background(), `SELECT credits_used FROM external_api_key WHERE id=$1`, key).Scan(&used); e != nil || used != 6.25 {
		t.Fatalf("API quota charged again: %v %v", used, e)
	}
	if _, e := b.db.Exec(context.Background(), `UPDATE external_api_key SET credit_limit=7 WHERE id=$1`, key); e != nil {
		t.Fatal(e)
	}
	rejected := newRequestID()
	if _, e := b.db.Exec(context.Background(), `INSERT INTO generation(id,user_id,prompt,model,status) VALUES($1,$2,'test','test','pending')`, rejected, uid); e != nil {
		t.Fatal(e)
	}
	if e := charge(rejected, 3); e == nil {
		t.Fatal("key quota rejection missing")
	}
	after, remaining, n := creditState(t, b, uid)
	if after != balance || remaining != batches || n != count {
		t.Fatalf("quota failure was not rolled back: %v %v %d", after, remaining, n)
	}
	if e := charge(generation, 7); e == nil {
		t.Fatal("conflicting retry accepted")
	}
}

func TestCreditsRegistrationBonusIdempotent(t *testing.T) {
	b := integrationBackend(t)
	uid, email := seedAuthUser(t, b)
	cookie := signInTestUser(t, b, email)
	setStorageTestSetting(t, b, "REGISTRATION_BONUS_CREDITS", 12.5)
	setStorageTestSetting(t, b, "FREE_CREDITS_EXPIRY_DAYS", 7)
	for i := 0; i < 2; i++ {
		out := requireCreditResponse(t, authRequest(t, b, "POST", "/api/credits/registration-bonus", "", cookie), 200)
		if out["alreadyGranted"] != (i > 0) {
			t.Fatalf("bonus idempotency = %v", out)
		}
	}
	balance, batches, count := creditState(t, b, uid)
	if balance != 12.5 || batches != 12.5 || count != 1 {
		t.Fatalf("registration bonus state=%v %v %d", balance, batches, count)
	}
	var expires, issued time.Time
	if e := b.db.QueryRow(context.Background(), `SELECT issued_at,expires_at FROM credits_batch WHERE user_id=$1`, uid).Scan(&issued, &expires); e != nil {
		t.Fatal(e)
	}
	if expires.Sub(issued) < 6*24*time.Hour || expires.Sub(issued) > 8*24*time.Hour {
		t.Fatal("free bonus expiry missing")
	}
}

func TestImageFailureBillingSettlement(t *testing.T) {
	b := integrationBackend(t)
	for _, tc := range []struct {
		name      string
		cause     error
		completed bool
		retained  float64
	}{
		{"moderation_block", &apiError{451, "CONTENT_MODERATION_BLOCKED", "blocked"}, true, 6.25},
		{"moderation_unavailable", &apiError{503, "CONTENT_MODERATION_UNAVAILABLE", "unavailable"}, false, 0},
		{"provider_failure_after_moderation", fmt.Errorf("upstream unavailable"), true, 0.25},
		{"provider_failure_without_moderation", fmt.Errorf("upstream unavailable"), false, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			uid, _ := seedAuthUser(t, b)
			creditTestWallet(t, b, uid, 10)
			creditTestBatch(t, b, uid, "purchase", 10, nil)
			id, taskID := newRequestID(), newRequestID()
			meta := mustJSON(map[string]any{"billingSnapshot": map[string]any{"moderationOnlyCredits": 0.25, "moderationFailureCredits": 6.25}, "moderation": map[string]any{"completed": tc.completed}})
			if _, e := b.db.Exec(context.Background(), `INSERT INTO generation(id,user_id,prompt,model,status,credits_consumed,metadata) VALUES($1,$2,'test','test','pending',6.25,$3)`, id, uid, meta); e != nil {
				t.Fatal(e)
			}
			body := map[string]any{"generationId": id, "operation": "generate", "prompt": "test", "model": "test"}
			if _, e := b.db.Exec(context.Background(), `INSERT INTO image_async_task(id,user_id,api_key_id,plan,operation,generation_inputs,generation_ids,generation_input,input_digest,generation_id,response_format,status) VALUES($1,$2,'site','default','generate',$3,$4,$5,'md5:00000000000000000000000000000000',$6,'url','queued')`, taskID, uid, mustJSON([]any{body}), mustJSON([]string{id}), mustJSON(body), id); e != nil {
				t.Fatal(e)
			}
			tx, e := b.db.Begin(context.Background())
			if e != nil {
				t.Fatal(e)
			}
			if e = b.chargeImageGenerationTx(context.Background(), tx, uid, id, "", imageBillingQuote{Amount: 6.25}, nil); e != nil {
				rollback(tx)
				t.Fatal(e)
			}
			if e = tx.Commit(context.Background()); e != nil {
				t.Fatal(e)
			}
			worker := mediaWorker{backend: b}
			for i := 0; i < 2; i++ {
				if e = worker.failImageGeneration(context.Background(), taskID, tc.cause.Error(), tc.cause); e != nil {
					t.Fatal(e)
				}
			}
			balance, batches, count := creditState(t, b, uid)
			expected := creditRound(10 - tc.retained)
			if balance != expected || batches != expected {
				t.Fatalf("failed settlement: balance=%v batches=%v retained=%v", balance, batches, tc.retained)
			}
			wantCount := 1
			if tc.retained < 6.25 {
				wantCount = 2
			}
			if count != wantCount {
				t.Fatalf("duplicate refund: count=%d want=%d", count, wantCount)
			}
			var retained, net float64
			if e = b.db.QueryRow(context.Background(), `SELECT g.credits_consumed,o.net_consumed FROM generation g JOIN credit_usage_operation o ON o.operation_id=g.id AND o.user_id=g.user_id WHERE g.id=$1`, id).Scan(&retained, &net); e != nil {
				t.Fatal(e)
			}
			if retained != tc.retained || net != tc.retained {
				t.Fatalf("history/ledger drift: retained=%v net=%v", retained, net)
			}
		})
	}
}

func TestCreditsExpiryConcurrentPassesUseActualCounts(t *testing.T) {
	b := integrationBackend(t)
	expires := time.Now().UTC().Add(-time.Hour)
	for i := 0; i < 2; i++ {
		uid, _ := seedAuthUser(t, b)
		creditTestWallet(t, b, uid, 4)
		creditTestBatch(t, b, uid, "bonus", 4, &expires)
	}
	var wg sync.WaitGroup
	type result struct {
		users, batches int
		err            error
	}
	results := make(chan result, 5)
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			u, n, e := b.processExpiredCredits(context.Background())
			results <- result{u, n, e}
		}()
	}
	wg.Wait()
	close(results)
	users, batches := 0, 0
	for out := range results {
		if out.err != nil {
			t.Fatal(out.err)
		}
		users += out.users
		batches += out.batches
	}
	if users != 2 || batches != 2 {
		t.Fatalf("expiry counted processed rows more than once: users=%d batches=%d", users, batches)
	}
}

func TestCreditsCompatibilityServiceReturnsRealRowsAndExpiryDetails(t *testing.T) {
	b := integrationBackend(t)
	b.config.cronSecret = "service-test-secret"
	uid, _ := seedAuthUser(t, b)
	creditTestWallet(t, b, uid, 5.25)
	expires := time.Now().UTC().Add(-time.Hour)
	expiredID := creditTestBatch(t, b, uid, "bonus", 2, &expires)
	activeID := creditTestBatch(t, b, uid, "purchase", 3.25, nil)
	call := func(operation string, auth bool) *httptest.ResponseRecorder {
		raw := mustJSON(map[string]any{"operation": operation, "userId": uid, "limit": 1})
		r := httptest.NewRequest(http.MethodPost, "http://localhost:3000/api/internal/credits/service", strings.NewReader(raw))
		if auth {
			r.Header.Set("Authorization", "Bearer "+b.config.cronSecret)
		}
		w := httptest.NewRecorder()
		b.handler().ServeHTTP(w, r)
		return w
	}
	requireCreditResponse(t, call("balance", false), 401)
	w := call("processExpired", true)
	if w.Code != 200 {
		t.Fatalf("expiry service: %d %s", w.Code, w.Body.String())
	}
	var details []expiredCreditBatch
	if err := json.Unmarshal(w.Body.Bytes(), &details); err != nil {
		t.Fatal(err)
	}
	if len(details) != 1 || details[0].BatchID != expiredID || details[0].ExpiredAmount != 2 {
		t.Fatalf("fabricated expiry rows: %v", details)
	}
	out := requireCreditResponse(t, call("balance", true), 200)
	if out["balance"] != 3.25 || out["user_id"] != uid || out["id"] == nil || out["created_at"] == nil {
		t.Fatalf("wallet row incomplete: %v", out)
	}
	w = call("activeBatches", true)
	var batches []map[string]any
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &batches) != nil || len(batches) != 1 || batches[0]["id"] != activeID || batches[0]["status"] != "active" {
		t.Fatalf("batch row incomplete: %s", w.Body.String())
	}
	w = call("transactions", true)
	var transactions []map[string]any
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &transactions) != nil || len(transactions) != 1 || transactions[0]["amount"] != float64(2) || transactions[0]["type"] != "expiration" {
		t.Fatalf("ledger rows incomplete: %s", w.Body.String())
	}
	setStorageTestSetting(t, b, "FREE_CREDITS_EXPIRY_DAYS", 7)
	requireCreditResponse(t, call("registrationBonusExpiry", true), 200)
}
