//go:build integration

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func seedImagePricingGroup(t *testing.T, b *backend, selectable bool, safety *bool, overrides any) string {
	t.Helper()
	id := newRequestID()
	if _, err := b.db.Exec(context.Background(), `INSERT INTO image_backend_group(id,name,is_user_selectable,content_safety_enabled,metadata) VALUES($1,'Image pricing test',$2,$3,$4)`, id, selectable, safety, mustJSON(map[string]any{"imageCreditOverrides": overrides})); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = b.db.Exec(context.Background(), `DELETE FROM image_backend_group WHERE id=$1`, id) })
	return id
}
func seedImagePricingMember(t *testing.T, b *backend, group, model, endpoint string, safety bool, priority int) string {
	t.Helper()
	id, version := newRequestID(), newRequestID()
	if _, err := b.db.Exec(context.Background(), `INSERT INTO image_backend_member(id,type,name,supported_model_ids,content_safety_enabled,priority) VALUES($1,'api','Image pricing test',$2,$3,$4)`, id, mustJSON([]string{model}), safety, priority); err != nil {
		t.Fatal(err)
	}
	config := map[string]any{"baseUrl": endpoint, "operations": map[string]any{"images.generate": map[string]any{"path": "/generate"}}}
	if _, err := b.db.Exec(context.Background(), `INSERT INTO image_backend_member_api_adapter_version(id,member_id_snapshot,revision,credential_scope,configuration) VALUES($1,$2,1,'pricing-test',$3)`, version, id, mustJSON(config)); err != nil {
		t.Fatal(err)
	}
	if _, err := b.db.Exec(context.Background(), `INSERT INTO image_backend_member_api_config(member_id,api_key,current_adapter_version_id,credential_scope) VALUES($1,'local-test',$2,'pricing-test')`, id, version); err != nil {
		t.Fatal(err)
	}
	if _, err := b.db.Exec(context.Background(), `INSERT INTO image_backend_member_group(id,member_id,group_id) VALUES($1,$2,$3)`, newRequestID(), id, group); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = b.db.Exec(context.Background(), `DELETE FROM image_backend_member WHERE id=$1`, id)
		_, _ = b.db.Exec(context.Background(), `DELETE FROM image_backend_member_api_adapter_version WHERE id=$1`, version)
	})
	return id
}
func seedImagePricingSettings(t *testing.T, b *backend, model string) {
	t.Helper()
	setStorageTestSetting(t, b, "IMAGE_MODEL_CREDIT_PRICES", map[string]any{"version": 1, "byModel": map[string]any{model: map[string]any{"base1024Credits": 1.01, "base1kCredits": 2.02, "base2kCredits": 3.03, "base4kCredits": 4.04, "base8kCredits": 8.08}}})
	setStorageTestSetting(t, b, "IMAGE_TEXT_MODERATION_CREDITS", 0.035)
	setStorageTestSetting(t, b, "IMAGE_INPUT_MODERATION_CREDITS", 0.065)
}
func imagePricingInput(input map[string]any) map[string]json.RawMessage {
	var out map[string]json.RawMessage
	_ = json.Unmarshal([]byte(mustJSON(input)), &out)
	return out
}

func TestImageBillingQuoteRespectsGroupPricesAndActualModerationSwitches(t *testing.T) {
	for _, scenario := range []struct {
		name           string
		global         bool
		group          *bool
		member         bool
		want           float64
		wantModeration bool
	}{
		{"enabled", true, nil, true, 12.17, true},
		{"global disabled", false, nil, true, 12, false},
		{"member disabled with global disabled", false, nil, false, 12, false},
		{"group disabled", true, new(bool), false, 12, false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			b := integrationBackend(t)
			uid, _ := seedAuthUser(t, b)
			model := "pricing-" + newRequestID()
			seedImagePricingSettings(t, b, model)
			setStorageTestSetting(t, b, "CONTENT_MODERATION_ENABLED", scenario.global)
			group := seedImagePricingGroup(t, b, true, scenario.group, map[string]any{"version": 1, "byModel": map[string]any{model: map[string]any{"base4kCredits": 12}}})
			provider := seedImagePricingMember(t, b, group, model, "http://127.0.0.1:1", scenario.member, 50)
			input := imagePricingInput(map[string]any{"backendGroupId": group, "size": "3840x2160", "images": []any{map[string]any{}, map[string]any{}}, "moderation": "low"})
			quote, err := b.resolveImageBillingQuote(context.Background(), &apiPrincipal{UserID: uid}, model, "", "edit", input)
			if err != nil {
				t.Fatal(err)
			}
			if quote.Amount != scenario.want || quote.Snapshot["moderationEnabled"] != scenario.wantModeration || quote.Snapshot["providerMemberId"] != provider {
				t.Fatalf("quote %+v", quote)
			}
			only, fail := 0.0, 0.0
			if scenario.wantModeration {
				only = 0.17
				fail = scenario.want
			}
			if quote.Snapshot["moderationOnlyCredits"] != only || quote.Snapshot["moderationFailureCredits"] != fail {
				t.Fatalf("settlement snapshot %+v", quote.Snapshot)
			}
			// User-controlled moderation and forged prices never turn platform checks off.
			input["moderation"] = json.RawMessage(`"none"`)
			input["billingSnapshot"] = json.RawMessage(`{"amount":0}`)
			again, err := b.resolveImageBillingQuote(context.Background(), &apiPrincipal{UserID: uid}, model, "", "mask", input)
			if err != nil || again.Amount != scenario.want {
				t.Fatalf("caller bypassed quote: %+v %v", again, err)
			}
		})
	}
}

func TestImageBillingRejectsMissingGlobalPricesAndUnauthorizedGroups(t *testing.T) {
	b := integrationBackend(t)
	uid, _ := seedAuthUser(t, b)
	model := "pricing-" + newRequestID()
	ctx := context.Background()
	group := seedImagePricingGroup(t, b, true, nil, map[string]any{"version": 1, "byModel": map[string]any{model: map[string]any{"base1024Credits": 1, "base1kCredits": 2, "base2kCredits": 3, "base4kCredits": 4}}})
	seedImagePricingMember(t, b, group, model, "http://127.0.0.1:1", true, 50)
	input := imagePricingInput(map[string]any{"backendGroupId": group})
	setStorageTestSetting(t, b, "IMAGE_MODEL_CREDIT_PRICES", map[string]any{"version": 1, "byModel": map[string]any{}})
	if _, err := b.resolveImageBillingQuote(ctx, &apiPrincipal{UserID: uid}, model, "1k", "generate", input); err == nil {
		t.Fatal("missing global price accepted")
	}
	private := seedImagePricingGroup(t, b, false, nil, nil)
	if _, err := b.resolveImageGroup(ctx, &apiPrincipal{UserID: uid}, private); err == nil {
		t.Fatal("private group accepted")
	}
	key := newRequestID()
	hash := sha256.Sum256([]byte(key))
	if _, err := b.db.Exec(ctx, `INSERT INTO external_api_key(id,user_id,key_prefix,key_hash,last_four,generation_group_id) VALUES($1,$2,'test',$3,'last',$4)`, key, uid, hex.EncodeToString(hash[:]), group); err != nil {
		t.Fatal(err)
	}
	p := &apiPrincipal{UserID: uid, KeyID: key}
	if _, err := b.resolveImageGroup(ctx, p, group); err == nil {
		t.Fatal("API key overrode binding even with matching group")
	}
	got, err := b.resolveImageGroup(ctx, p, "")
	if err != nil || got.ID != group {
		t.Fatalf("API binding %+v %v", got, err)
	}
	other, _ := seedAuthUser(t, b)
	if _, err := b.resolveImageGroup(ctx, &apiPrincipal{UserID: other, KeyID: key}, ""); err == nil {
		t.Fatal("foreign API key accepted")
	}
}

func TestImageChargedTaskPinsAuthorizedRouteAndPriceAcrossSettingsChanges(t *testing.T) {
	b := integrationBackend(t)
	uid, _ := seedAuthUser(t, b)
	model := "pricing-" + newRequestID()
	ctx := context.Background()
	b.config.storagePath = t.TempDir()
	setStorageTestSetting(t, b, "STORAGE_ENDPOINT", "")
	setStorageTestSetting(t, b, "STORAGE_GENERATIONS_BUCKET", "generations")
	seedImagePricingSettings(t, b, model)
	setStorageTestSetting(t, b, "CONTENT_MODERATION_ENABLED", false)
	creditTestWallet(t, b, uid, 100)
	creditTestBatch(t, b, uid, "purchase", 100, nil)
	var calls, foreignCalls atomic.Int32
	var endpoint string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/generate" {
			calls.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]any{"url": endpoint + "/output"}}})
			return
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write([]byte("stored-provider-image"))
	}))
	defer server.Close()
	endpoint = server.URL
	foreign := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { foreignCalls.Add(1); w.WriteHeader(500) }))
	defer foreign.Close()
	group := seedImagePricingGroup(t, b, true, nil, map[string]any{"version": 1, "byModel": map[string]any{model: map[string]any{"base2kCredits": 6.25}}})
	otherGroup := seedImagePricingGroup(t, b, true, nil, nil)
	provider := seedImagePricingMember(t, b, group, model, server.URL, true, 99)
	seedImagePricingMember(t, b, otherGroup, model, foreign.URL, true, 0)
	input := imagePricingInput(map[string]any{"model": model, "prompt": "local fixture", "backendGroupId": group, "resolution": "2k", "groupAuthorization": map[string]any{"id": otherGroup}, "billingSnapshot": map[string]any{"amount": 0}})
	r := httptest.NewRequest(http.MethodPost, "http://localhost/api/images/generate", nil)
	task, err := b.createImageTask(r, &apiPrincipal{UserID: uid}, input, "generate")
	if err != nil {
		t.Fatal(err)
	}
	taskID, generationID := stringValue(task["id"]), stringValue(task["generationId"])
	var charged float64
	var raw []byte
	if err := b.db.QueryRow(ctx, `SELECT credits_consumed,metadata FROM generation WHERE id=$1`, generationID).Scan(&charged, &raw); err != nil {
		t.Fatal(err)
	}
	var metadata map[string]any
	_ = json.Unmarshal(raw, &metadata)
	quote, _ := metadata["billingSnapshot"].(map[string]any)
	trusted, _ := quote["group"].(map[string]any)
	if charged != 6.25 || quote["providerMemberId"] != provider || trusted["id"] != group {
		t.Fatalf("untrusted admission snapshot: %s charge=%v", raw, charged)
	}
	// Configuration changes and a higher-priority foreign member cannot change
	// the accepted group's provider or the already charged rate.
	setStorageTestSetting(t, b, "IMAGE_MODEL_CREDIT_PRICES", map[string]any{"version": 1, "byModel": map[string]any{}})
	if _, err := b.db.Exec(ctx, `UPDATE image_backend_group SET metadata='{}' WHERE id=$1`, group); err != nil {
		t.Fatal(err)
	}
	worker := mediaWorker{backend: b}
	if err := worker.processImage(ctx, taskID); err != nil {
		t.Fatal(err)
	}
	if err := worker.processImage(ctx, taskID); err != nil {
		t.Fatal(err)
	}
	var status string
	if err := b.db.QueryRow(ctx, `SELECT status,credits_consumed FROM generation WHERE id=$1`, generationID).Scan(&status, &charged); err != nil {
		t.Fatal(err)
	}
	balance, batches, count := creditState(t, b, uid)
	if status != "completed" || calls.Load() != 1 || foreignCalls.Load() != 0 || charged != 6.25 || balance != 93.75 || batches != 93.75 || count != 1 {
		t.Fatalf("status=%s calls=%d foreign=%d charged=%v balance=%v batches=%v count=%d", status, calls.Load(), foreignCalls.Load(), charged, balance, batches, count)
	}
}

func TestImageGroupRequiresUniqueDefaultAndAllowsUnboundAPIKeyDefault(t *testing.T) {
	b := integrationBackend(t)
	uid, _ := seedAuthUser(t, b)
	ctx := context.Background()
	p := &apiPrincipal{UserID: uid}
	if _, err := b.resolveImageGroup(ctx, p, ""); err == nil {
		t.Fatal("missing default group accepted")
	}
	group := seedImagePricingGroup(t, b, true, nil, nil)
	if _, err := b.db.Exec(ctx, `UPDATE image_backend_group SET is_default=true WHERE id=$1`, group); err != nil {
		t.Fatal(err)
	}
	selected, err := b.resolveImageGroup(ctx, p, "")
	if err != nil || selected.ID != group {
		t.Fatalf("unique default %+v %v", selected, err)
	}
	key := newRequestID()
	hash := sha256.Sum256([]byte(key))
	if _, err := b.db.Exec(ctx, `INSERT INTO external_api_key(id,user_id,key_prefix,key_hash,last_four) VALUES($1,$2,'test',$3,'last')`, key, uid, hex.EncodeToString(hash[:])); err != nil {
		t.Fatal(err)
	}
	selected, err = b.resolveImageGroup(ctx, &apiPrincipal{UserID: uid, KeyID: key}, "")
	if err != nil || selected.ID != group {
		t.Fatalf("unbound valid key default %+v %v", selected, err)
	}
	other := seedImagePricingGroup(t, b, true, nil, nil)
	if _, err := b.db.Exec(ctx, `UPDATE image_backend_group SET is_default=true WHERE id=$1`, other); err != nil {
		t.Fatal(err)
	}
	if _, err := b.resolveImageGroup(ctx, p, ""); err == nil {
		t.Fatal("ambiguous default groups accepted")
	}
	if _, err := b.db.Exec(ctx, `UPDATE image_backend_group SET is_enabled=false WHERE id=$1`, group); err != nil {
		t.Fatal(err)
	}
	if _, err := b.resolveImageGroup(ctx, p, group); err == nil {
		t.Fatal("disabled group accepted")
	}
}
