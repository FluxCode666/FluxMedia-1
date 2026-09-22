//go:build integration

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

func historyFixtureImage(t *testing.T, b *backend, uid, id, model, status string, at time.Time, meta any) {
	t.Helper()
	var completed *time.Time
	if status != "pending" {
		v := at.Add(1600 * time.Millisecond)
		completed = &v
	}
	if _, e := b.db.Exec(context.Background(), `INSERT INTO generation(id,user_id,prompt,model,size,status,credits_consumed,metadata,created_at,completed_at,storage_key,storage_bucket) VALUES($1,$2,'history prompt',$3,'1024x1024',$4,2.25,$5,$6,$7,$2||'/history.png','generations')`, id, uid, model, status, mustJSON(meta), at, completed); e != nil {
		t.Fatal(e)
	}
}
func historyFixtureVideo(t *testing.T, b *backend, uid, id, model, status, stage string, at time.Time, meta, manifest any) {
	t.Helper()
	var storedManifest any
	if m, ok := manifest.(map[string]any); ok && len(m) > 0 {
		storedManifest = mustJSON(m)
	}
	var completed *time.Time
	if status == "completed" || status == "failed" {
		v := at.Add(4600 * time.Millisecond)
		completed = &v
	}
	if _, e := b.db.Exec(context.Background(), `INSERT INTO video_generation(id,user_id,prompt,model,status,stage,duration_seconds,resolution,aspect_ratio,credits_consumed,metadata,input_manifest,created_at,completed_at,principal_scope,output_width,output_height) VALUES($1,$2,'video prompt',$3,$4,$5,8,'720p','16:9',1.25,$6,$7,$8,$9,'user:'||$2,1280,720)`, id, uid, model, status, stage, mustJSON(meta), storedManifest, at, completed); e != nil {
		t.Fatal(e)
	}
}
func historyRead(t *testing.T, b *backend, cookie *http.Cookie, admin bool, input any) map[string]any {
	t.Helper()
	path := "/api/image-generation/history"
	if admin {
		path = "/api/admin/image-generation/history"
	}
	w := authRequest(t, b, "POST", path, mustJSON(input), cookie)
	out := requireCreditResponse(t, w, 200)
	if !strings.Contains(w.Header().Get("Cache-Control"), "no-store") {
		t.Fatal("private history was cacheable")
	}
	return out
}
func historyIDs(out map[string]any) []string {
	ids := []string{}
	for _, r := range out["records"].([]any) {
		ids = append(ids, r.(map[string]any)["id"].(string))
	}
	return ids
}
func historyExpectIDs(t *testing.T, out map[string]any, want ...string) {
	t.Helper()
	if got := historyIDs(out); !reflect.DeepEqual(got, want) {
		t.Fatalf("history order: got %v want %v", got, want)
	}
}
func historyAssertFields(t *testing.T, record map[string]any, admin bool) {
	t.Helper()
	fields := strings.Fields("kind id prompt model status creditsConsumed error createdAt completedAt processingDurationSeconds")
	if record["kind"] == "image" {
		fields = append(fields, strings.Fields("revisedPrompt size creditDetails promptRepairNotice referenceImages imageUrl")...)
	} else {
		fields = append(fields, strings.Fields("resolution duration aspectRatio generateAudio input billing videoUrl")...)
		if admin {
			fields = append(fields, "submissionAttempts")
		}
	}
	if admin {
		fields = append(fields, "userId", "userEmail", "backendAccount")
	}
	allowed := map[string]bool{}
	for _, key := range fields {
		allowed[key] = true
		if _, ok := record[key]; !ok {
			t.Fatalf("required history field missing: %s", key)
		}
	}
	for key := range record {
		if !allowed[key] {
			t.Fatalf("private/unknown history field leaked: %s", key)
		}
	}
}
func TestMigratedHistoryRoutesPaginationSnapshotAndSafeImageMetadata(t *testing.T) {
	b := integrationBackend(t)
	b.logger = slog.New(slog.NewTextHandler(os.Stderr, nil))
	uid, email := seedAuthUser(t, b)
	other, _ := seedAuthUser(t, b)
	cookie := signInTestUser(t, b, email)
	prefix := newRequestID()
	at := time.Date(2024, 6, 1, 12, 0, 0, 123456000, time.UTC)
	meta := map[string]any{"secret": "DO_NOT_LEAK", "upstreamRequestSnapshot": map[string]any{"apiKey": "DO_NOT_LEAK"}, "backend": map[string]any{"id": "member-before-delete", "name": "Original supplier", "billingGroupId": "group-old", "apiKey": "DO_NOT_LEAK"}, "creditCost": map[string]any{"baseCredits": 2, "moderationCredits": 0.25, "totalCredits": 2.25}, "outputImage": map[string]any{"requestedSize": "1024x1024", "actualSize": "1536x1024", "requestedResolution": "1k", "settledResolution": "2k", "perOutputCreditCosts": []any{map[string]any{"baseCredits": 1, "moderationCredits": 0.1, "totalCredits": 1.1}, map[string]any{"baseCredits": 1, "moderationCredits": 0.15, "totalCredits": 1.15}}, "chatRoundCredits": 0.1, "chatRoundCount": 2}, "moderationPromptRepair": map[string]any{"succeeded": true, "notice": "  Adjusted prompt  "}, "inputImages": map[string]any{"images": []any{map[string]any{"storageKey": uid + "/reference.png", "storageBucket": "generations", "name": " Original ", "sizeBytes": 42, "secret": "DO_NOT_LEAK"}}}}
	iz, ia, vz, vo, io := prefix+"image-z", prefix+"image-a", prefix+"video-z", prefix+"video-old", prefix+"image-old"
	historyFixtureImage(t, b, uid, iz, "firefly-gpt-image-1", "completed", at, meta)
	historyFixtureImage(t, b, uid, ia, "gpt-image-1", "pending", at, nil)
	historyFixtureVideo(t, b, uid, vz, "veo31", "running", "polling", at, map[string]any{"generateAudio": true}, map[string]any{})
	historyFixtureVideo(t, b, uid, vo, "veo31", "completed", "completed", at.Add(-time.Hour), nil, map[string]any{})
	historyFixtureImage(t, b, uid, io, "other-model", "failed", at.Add(-2*time.Hour), nil)
	historyFixtureImage(t, b, other, prefix+"foreign", "private-model", "completed", at.Add(time.Hour), nil)
	first := historyRead(t, b, cookie, false, map[string]any{"pageSize": 2})
	historyExpectIDs(t, first, iz, ia)
	if first["totalCount"] != float64(5) || first["previousCursor"] != nil || first["nextCursor"] == nil {
		t.Fatalf("first paging: %v", first)
	}
	for _, value := range first["records"].([]any) {
		historyAssertFields(t, value.(map[string]any), false)
	}
	r := first["records"].([]any)[0].(map[string]any)
	details := r["creditDetails"].(map[string]any)
	if r["model"] != "gpt-image-1" || r["processingDurationSeconds"] != float64(2) || r["promptRepairNotice"] != "Adjusted prompt" || details["totalCredits"] != 2.25 || details["actualImageCredits"] != 2.25 || details["baseCredits"] != float64(2) || details["chatCredits"] != 0.2 {
		t.Fatalf("image details: %v", r)
	}
	ref := r["referenceImages"].([]any)[0].(map[string]any)
	if len(ref) != 8 || ref["name"] != "Original" || !strings.Contains(ref["imageUrl"].(string), "sig=") || strings.Contains(mustJSON(first), "DO_NOT_LEAK") {
		t.Fatalf("unsafe/missing image projection: %v", r)
	}
	if len(first["modelOptions"].([]any)) != 3 {
		t.Fatalf("options must cover more than first page: %v", first["modelOptions"])
	}
	second := historyRead(t, b, cookie, false, map[string]any{"page": 2, "pageSize": 2, "cursor": first["nextCursor"]})
	historyExpectIDs(t, second, vz, vo)
	for _, value := range second["records"].([]any) {
		historyAssertFields(t, value.(map[string]any), false)
	}
	if second["totalCount"] != float64(5) || second["asOf"] != first["asOf"] {
		t.Fatalf("snapshot changed: %v", second)
	}
	offset := historyRead(t, b, cookie, false, map[string]any{"page": 2, "pageSize": 2})
	historyExpectIDs(t, offset, vz, vo)
	clamped := historyRead(t, b, cookie, false, map[string]any{"page": 9007199254740991, "pageSize": 2})
	historyExpectIDs(t, clamped, io)
	if clamped["page"] != float64(3) || clamped["nextCursor"] != nil {
		t.Fatalf("page not clamped %v", clamped)
	}
	newID := prefix + "new"
	historyFixtureImage(t, b, uid, newID, "new-model", "completed", time.Now().UTC().Add(time.Second), nil)
	third := historyRead(t, b, cookie, false, map[string]any{"page": 3, "pageSize": 2, "cursor": second["nextCursor"]})
	historyExpectIDs(t, third, io)
	if third["nextCursor"] != nil || third["totalCount"] != float64(5) || third["asOf"] != first["asOf"] {
		t.Fatalf("snapshot leaked new row: %v", third)
	}
	back := historyRead(t, b, cookie, false, map[string]any{"page": 2, "pageSize": 2, "cursor": third["previousCursor"]})
	historyExpectIDs(t, back, vz, vo)
	backFirst := historyRead(t, b, cookie, false, map[string]any{"page": 1, "pageSize": 2, "cursor": back["previousCursor"]})
	historyExpectIDs(t, backFirst, iz, ia)
	if backFirst["previousCursor"] != nil || backFirst["nextCursor"] == nil {
		t.Fatal("backward pagination boundaries wrong")
	}
	missing := historyRead(t, b, cookie, false, map[string]any{"model": "unused", "page": 400})
	if missing["page"] != float64(1) || missing["totalCount"] != float64(0) || len(historyIDs(missing)) != 0 {
		t.Fatalf("empty page: %v", missing)
	}
}

func historyTestSnapshot(mode string) map[string]any {
	unit, price, quoted := "second", 1.125, 9.0
	if mode == "per_item" {
		unit, price, quoted = "item", 9.125, 9.13
	}
	payload := fmt.Sprintf(`{"version":1,"modelId":"veo31","resolution":"720p","mode":%q,"unit":%q,"unitPrice":%s,"durationSeconds":8,"quotedCredits":%s,"billingGroupId":"historical-group"}`, mode, unit, fmt.Sprint(price), fmt.Sprint(quoted))
	var snapshot map[string]any
	_ = json.Unmarshal([]byte(payload), &snapshot)
	sum := sha256.Sum256([]byte(payload))
	snapshot["digest"] = hex.EncodeToString(sum[:])
	return snapshot
}

func TestMigratedAdminHistoryScopeFiltersAuditAndVideoBilling(t *testing.T) {
	b := integrationBackend(t)
	b.logger = slog.New(slog.NewTextHandler(os.Stderr, nil))
	ctx := context.Background()
	admin, adminEmail := seedAuthUser(t, b)
	uid, email := seedAuthUser(t, b)
	other, otherEmail := seedAuthUser(t, b)
	if _, e := b.db.Exec(ctx, `UPDATE "user" SET role='observer_admin',time_zone='America/New_York' WHERE id=$1`, admin); e != nil {
		t.Fatal(e)
	}
	cookie := signInTestUser(t, b, adminEmail)
	userCookie := signInTestUser(t, b, email)
	prefix := newRequestID()
	at := time.Date(2024, 3, 10, 5, 0, 0, 0, time.UTC)
	inside, outside, nextDay := prefix+"inside", prefix+"outside", prefix+"next-day"
	historyFixtureImage(t, b, uid, outside, "outside-model", "completed", at.Add(-time.Microsecond), nil)
	historyFixtureImage(t, b, uid, nextDay, "next-day-model", "completed", at.Add(23*time.Hour), nil)
	historyFixtureImage(t, b, other, prefix+"foreign", "foreign-model", "completed", at, nil)
	manifest := map[string]any{"firstFrame": map[string]any{"source": "storage", "storageKey": uid + "/video-inputs/" + inside + "/attempt/frame.png", "storageBucket": "generations", "mimeType": "image/png", "byteLength": 5}}
	metadata := map[string]any{"generateAudio": true, "videoCapabilitySnapshot": map[string]any{"version": 2}, "videoBillingSnapshot": historyTestSnapshot("per_second"), "backend": map[string]any{"id": "retired-member", "name": "  Historical supplier  ", "apiKey": "DO_NOT_LEAK"}}
	historyFixtureVideo(t, b, uid, inside, "veo31", "pending", "created", at.Add(time.Hour), metadata, manifest)
	if _, e := b.db.Exec(ctx, `UPDATE video_generation SET capacity_wait_deadline_at=now()+interval '1 minute' WHERE id=$1`, inside); e != nil {
		t.Fatal(e)
	}
	attemptID := newRequestID()
	if _, e := b.db.Exec(ctx, `INSERT INTO video_generation_submission_attempt(id,video_generation_id,backend_member_id,member_attempt_number,global_attempt_number,request_id,retry_count_snapshot,max_attempts_snapshot,supplier_name_snapshot,api_adapter_member_id,api_adapter_version_id,failure_code,failure_reason,operations_reason,failed_at) VALUES($1,$2,'retired-member',1,1,'private-request',1,2,' Historical supplier ','private-member','private-version','network_error','Connection failed','Retry next supplier',$3)`, attemptID, inside, at); e != nil {
		t.Fatal(e)
	}
	input := map[string]any{"pageSize": 1, "createdFrom": "2024-03-10", "createdTo": "2024-03-10", "userEmail": " " + email + " ", "status": "in_progress"}
	out := historyRead(t, b, cookie, true, input)
	historyExpectIDs(t, out, inside)
	if out["totalCount"] != float64(1) || out["nextCursor"] != nil {
		t.Fatalf("DST/filter count %v", out)
	}
	record := out["records"].([]any)[0].(map[string]any)
	historyAssertFields(t, record, true)
	billing := record["billing"].(map[string]any)
	account := record["backendAccount"].(map[string]any)
	summary := record["input"].(map[string]any)
	attempts := record["submissionAttempts"].([]any)
	if record["status"] != "in_progress" || record["generateAudio"] != true || billing["kind"] != "snapshot" || billing["quotedCredits"] != float64(9) || billing["actualCredits"] != 1.25 || summary["mode"] != "first-frame" || summary["count"] != float64(1) || account["id"] != "retired-member" || account["name"] != "Historical supplier" || len(attempts) != 1 {
		t.Fatalf("video/admin detail %v", record)
	}
	if attempts[0].(map[string]any)["failureCode"] != "network_error" || len(attempts[0].(map[string]any)) != 6 || strings.Contains(mustJSON(out), "DO_NOT_LEAK") || strings.Contains(mustJSON(out), "private-request") || strings.Contains(mustJSON(billing), "historical-group") {
		t.Fatalf("audit/private metadata leaked %v", out)
	}
	models := out["modelOptions"].([]any)
	if len(models) != 3 {
		t.Fatalf("model options used active page filters %v", models)
	}
	for _, v := range models {
		if v == "foreign-model" {
			t.Fatal("email-scoped model options leaked")
		}
	}
	foundOther := false
	for _, v := range out["userOptions"].([]any) {
		if v.(map[string]any)["email"] == otherEmail {
			foundOther = true
		}
	}
	if !foundOther {
		t.Fatal("global user options constrained to current page/email")
	}
	all := historyRead(t, b, cookie, true, map[string]any{"userEmail": email, "pageSize": 1})
	if all["totalCount"] != float64(3) {
		t.Fatalf("admin total %v", all)
	}
	next := historyRead(t, b, cookie, true, map[string]any{"userEmail": email, "page": 2, "pageSize": 1, "cursor": all["nextCursor"]})
	historyExpectIDs(t, next, inside)
	back := historyRead(t, b, cookie, true, map[string]any{"userEmail": email, "page": 1, "pageSize": 1, "cursor": next["previousCursor"]})
	historyExpectIDs(t, back, nextDay)
	for _, status := range []string{"queued", "processing", "failed"} {
		filtered := historyRead(t, b, cookie, true, map[string]any{"userEmail": email, "status": status})
		if filtered["totalCount"] != float64(0) {
			t.Fatalf("status %s false positives %v", status, filtered)
		}
	}
	requireCreditResponse(t, authRequest(t, b, "POST", "/api/admin/image-generation/history", `{}`, userCookie), 403)
	if _, e := b.db.Exec(ctx, `UPDATE video_generation SET metadata=$2 WHERE id=$1`, inside, mustJSON(map[string]any{"videoCapabilitySnapshot": map[string]any{"version": 2}, "videoBillingSnapshot": historyTestSnapshot("per_item")})); e != nil {
		t.Fatal(e)
	}
	item := historyRead(t, b, cookie, true, map[string]any{"userEmail": email, "type": "video"})
	ib := item["records"].([]any)[0].(map[string]any)["billing"].(map[string]any)
	if ib["mode"] != "per_item" || ib["quotedCredits"] != 9.13 || ib["creditsPerSecond"] != nil {
		t.Fatalf("per item billing %v", ib)
	}
	if _, e := b.db.Exec(ctx, `UPDATE video_generation SET metadata=jsonb_set(metadata::jsonb,'{videoBillingSnapshot,quotedCredits}','3'::jsonb) WHERE id=$1`, inside); e != nil {
		t.Fatal(e)
	}
	requireCreditResponse(t, authRequest(t, b, "POST", "/api/admin/image-generation/history", mustJSON(map[string]any{"userEmail": email, "type": "video"}), cookie), 500)
}

func TestMigratedHistoryRejectsCursorTamperingAndInvalidQuery(t *testing.T) {
	b := integrationBackend(t)
	b.config.internalPrincipalSecret = "history-integration-internal-secret"
	uid, email := seedAuthUser(t, b)
	if _, e := b.db.Exec(context.Background(), `UPDATE "user" SET time_zone='UTC' WHERE id=$1`, uid); e != nil {
		t.Fatal(e)
	}
	other, otherEmail := seedAuthUser(t, b)
	cookie := signInTestUser(t, b, email)
	otherCookie := signInTestUser(t, b, otherEmail)
	at := time.Now().UTC().Add(-time.Hour)
	for i := 0; i < 3; i++ {
		historyFixtureImage(t, b, uid, newRequestID(), "model", "completed", at.Add(time.Duration(i)*time.Second), nil)
	}
	first := historyRead(t, b, cookie, false, map[string]any{"pageSize": 1})
	token := first["nextCursor"].(string)
	cases := []string{`null`, `[]`, `{"page":0}`, `{"page":null}`, `{"pageSize":0}`, `{"limit":51}`, `{"limit":1,"pageSize":2}`, `{"page":1.5}`, `{"cursor":""}`, `{"createdFrom":"2024-02-30"}`, `{"createdFrom":"2024-3-10"}`, `{"createdFrom":"2024-04-02","createdTo":"2024-04-01"}`, `{"model":" "}`, `{"status":"running"}`, `{"type":"audio"}`, `{"userId":"` + other + `"}`, `{"userEmail":"` + otherEmail + `"}`, `{} {}`}
	for _, body := range cases {
		t.Run(body, func(t *testing.T) {
			requireCreditResponse(t, authRequest(t, b, "POST", "/api/image-generation/history", body, cookie), 400)
		})
	}
	for _, input := range []map[string]any{{"page": 2, "pageSize": 1, "cursor": token + "x"}, {"page": 1, "pageSize": 1, "cursor": token}, {"page": 2, "pageSize": 2, "cursor": token}, {"page": 2, "pageSize": 1, "cursor": token, "type": "image"}, {"page": 2, "pageSize": 1, "cursor": token, "model": "other"}} {
		requireCreditResponse(t, authRequest(t, b, "POST", "/api/image-generation/history", mustJSON(input), cookie), 400)
	}
	requireCreditResponse(t, authRequest(t, b, "POST", "/api/image-generation/history", mustJSON(map[string]any{"page": 2, "pageSize": 1, "cursor": token}), otherCookie), 400)
	if _, e := b.db.Exec(context.Background(), `UPDATE "user" SET role='admin' WHERE id=$1`, uid); e != nil {
		t.Fatal(e)
	}
	requireCreditResponse(t, authRequest(t, b, "POST", "/api/admin/image-generation/history", mustJSON(map[string]any{"page": 2, "pageSize": 1, "cursor": token}), cookie), 400)
	if _, e := b.db.Exec(context.Background(), `UPDATE "user" SET time_zone='Asia/Shanghai' WHERE id=$1`, uid); e != nil {
		t.Fatal(e)
	}
	requireCreditResponse(t, authRequest(t, b, "POST", "/api/image-generation/history", mustJSON(map[string]any{"page": 2, "pageSize": 1, "cursor": token}), cookie), 400)
	// API credential assertions cannot enter the browser session history boundary.
	for _, kind := range []string{"mcp", "external"} {
		p := internalPrincipal{Type: "apiKey", UserID: uid, CredentialKind: kind, APIKeyID: "test-key"}
		encoded, signature, ok := internalPrincipalHeaders(p, b.config.internalPrincipalSecret)
		if !ok {
			t.Fatal("internal signer unavailable")
		}
		request := httptest.NewRequest("POST", "http://localhost:3000/api/image-generation/history", strings.NewReader(`{}`))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Flux-Principal", encoded)
		request.Header.Set("X-Flux-Principal-Signature", signature)
		w := httptest.NewRecorder()
		b.handler().ServeHTTP(w, request)
		requireCreditResponse(t, w, 401)
	}
}
