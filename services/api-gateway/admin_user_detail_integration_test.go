//go:build integration

package main

import (
	"context"
	"net/http"
	"net/url"
	"testing"
)

func TestAdminUserDetailReturnsGovernanceAndNullableRows(t *testing.T) {
	b := integrationBackend(t)
	ctx := context.Background()
	admin, email := seedAuthUser(t, b)
	target, _ := seedAuthUser(t, b)
	if _, err := b.db.Exec(ctx, `UPDATE "user" SET role='admin' WHERE id=$1`, admin); err != nil {
		t.Fatal(err)
	}
	if _, err := b.db.Exec(ctx, `UPDATE "user" SET image_generation_concurrency_override=7,moderation_block_risk_level_override='low' WHERE id=$1`, target); err != nil {
		t.Fatal(err)
	}
	cookie := signInTestUser(t, b, email)
	setStorageTestSetting(t, b, globalModerationPolicySetting, "medium")
	setStorageTestSetting(t, b, "IMAGE_GENERATION_DEFAULT_USER_CONCURRENCY", 20)
	setStorageTestSetting(t, b, "MEDIA_MAX_FILE_SIZE_MB", 5)
	setStorageTestSetting(t, b, "MEDIA_MAX_UPLOAD_SIZE_MB", 75)
	setStorageTestSetting(t, b, "IMAGE_EDIT_MAX_REFERENCE_IMAGES", 16)
	keyID, transactionID, auditID := newRequestID(), newRequestID(), newRequestID()
	if _, err := b.db.Exec(ctx, `INSERT INTO external_api_key(id,user_id,name,key_prefix,key_hash,last_four,credit_limit) VALUES($1,$2,'Unlimited','test',$1,'last',NULL)`, keyID, target); err != nil {
		t.Fatal(err)
	}
	if _, err := b.db.Exec(ctx, `INSERT INTO credits_transaction(id,user_id,type,amount,debit_account,credit_account,description) VALUES($1,$2,'purchase',3,'SYSTEM:test','WALLET:'||$2,NULL)`, transactionID, target); err != nil {
		t.Fatal(err)
	}
	if _, err := b.db.Exec(ctx, `INSERT INTO admin_audit_log(id,admin_user_id,target_user_id,action,reason,before,after,metadata) VALUES($1,$2,$3,$4,'audit detail','{"level":null}','{"level":"low"}','{"requestId":"admin-detail"}')`, auditID, admin, target, userModerationPolicyAction); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = b.db.Exec(ctx, `DELETE FROM admin_audit_log WHERE id=$1`, auditID) })
	for i := 0; i < 13; i++ {
		if _, err := b.db.Exec(ctx, `INSERT INTO generation(id,user_id,prompt,model,status,storage_key,storage_bucket,credits_consumed) VALUES($1,$2,'test','test','completed',$3,'generations',2)`, newRequestID(), target, target+"/test.png"); err != nil {
			t.Fatal(err)
		}
	}
	out := requireCreditResponse(t, authRequest(t, b, http.MethodGet, "/api/admin/users/"+target, "", cookie), 200)
	if out["creditsBalance"] != nil {
		t.Fatal("missing wallet must remain null")
	}
	policy := out["moderationPolicy"].(map[string]any)
	limits := out["mediaLimits"].(map[string]any)
	if policy["globalDefault"] != "medium" || policy["effectiveLevel"] != "low" || policy["source"] != "user_override" || limits["override"] != float64(7) || limits["limit"] != float64(7) || limits["maxEditReferenceImages"] != float64(16) {
		t.Fatalf("governance fields missing: policy=%v limits=%v", policy, limits)
	}
	keys := out["apiKeys"].([]any)
	transactions := out["transactions"].([]any)
	audits := out["auditLogs"].([]any)
	generations := out["generations"].([]any)
	summary := out["generationSummary"].(map[string]any)
	if len(keys) != 1 || keys[0].(map[string]any)["creditLimit"] != nil || len(transactions) != 1 || transactions[0].(map[string]any)["description"] != nil || out["transactionsCount"] != float64(1) {
		t.Fatalf("nullable database rows were dropped: keys=%v transactions=%v", keys, transactions)
	}
	if len(audits) != 1 || audits[0].(map[string]any)["id"] != auditID || audits[0].(map[string]any)["metadata"].(map[string]any)["requestId"] != "admin-detail" {
		t.Fatalf("audit records missing: %v", audits)
	}
	if len(generations) != 12 || summary["total"] != float64(13) || summary["creditsConsumed"] != float64(26) {
		t.Fatalf("generation detail missing: count=%d summary=%v", len(generations), summary)
	}
	imageURL, err := url.Parse(generations[0].(map[string]any)["imageUrl"].(string))
	if err != nil || imageURL.Path != "/api/storage/generations/"+target+"/test.png" {
		t.Fatalf("generation URL missing: url=%v err=%v", imageURL, err)
	}
}
