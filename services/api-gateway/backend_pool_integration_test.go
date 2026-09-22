//go:build integration

package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func poolTestWrite(t *testing.T, b *backend, handler func(http.ResponseWriter, *http.Request) error, path string, input any) (map[string]any, error) {
	t.Helper()
	rec := httptest.NewRecorder()
	r := httptest.NewRequest("POST", path, strings.NewReader(mustJSON(input)))
	err := handler(rec, r)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return out, err
}
func poolTestGroup(t *testing.T, b *backend) string {
	t.Helper()
	out, err := poolTestWrite(t, b, b.backendPoolSaveGroup, "/api/admin/image-backend/groups", map[string]any{"name": "test group", "isEnabled": true, "isUserSelectable": true, "contentSafety": "inherit", "childGroupIds": []string{}})
	if err != nil {
		t.Fatal(err)
	}
	id := out["id"].(string)
	t.Cleanup(func() { _, _ = b.db.Exec(context.Background(), `DELETE FROM image_backend_group WHERE id=$1`, id) })
	return id
}
func poolTestMember(group string) map[string]any {
	return map[string]any{"type": "api", "name": "test supplier", "groupIds": []string{group}, "supportedModelIds": []string{"gpt-image-2"}, "supportedResolutionsByModel": map[string]any{"gpt-image-2": []string{"1k"}}, "contentSafetyEnabled": true, "isEnabled": true, "alwaysActive": false, "failureCooldownEnabled": true, "priority": 0, "concurrency": 2, "config": map[string]any{"baseUrl": "https://provider.example/v1", "apiKey": "old-secret", "authentication": map[string]any{"mode": "bearer"}, "modelMappings": []any{}}}
}
func poolTestSaveMember(t *testing.T, b *backend, in map[string]any) (string, error) {
	t.Helper()
	out, err := poolTestWrite(t, b, b.backendPoolSaveMember, "/api/admin/image-backend/members", in)
	if err != nil {
		return "", err
	}
	id := out["id"].(string)
	if in["id"] == nil {
		t.Cleanup(func() {
			_, _ = b.db.Exec(context.Background(), `DELETE FROM image_backend_member WHERE id=$1`, id)
			_, _ = b.db.Exec(context.Background(), `DELETE FROM image_backend_member_api_adapter_version WHERE member_id_snapshot=$1`, id)
		})
	}
	return id, nil
}
func TestPoolMemberImmutableVersionCredentialAndSnapshot(t *testing.T) {
	b := integrationBackend(t)
	ctx := context.Background()
	group := poolTestGroup(t, b)
	in := poolTestMember(group)
	sizeID := newRequestID()
	_, err := b.db.Exec(ctx, `INSERT INTO image_size_config(id,name) VALUES($1,'official-size')`, sizeID)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = b.db.Exec(ctx, `DELETE FROM image_size_config WHERE id=$1`, sizeID) })
	_, err = b.db.Exec(ctx, `INSERT INTO image_size_config_mapping(id,config_id,resolution,aspect_ratio,size) VALUES($1,$2,'1k','1:1','1024x1024')`, newRequestID(), sizeID)
	if err != nil {
		t.Fatal(err)
	}
	cfg := in["config"].(map[string]any)
	cfg["imageSizeConfigId"] = sizeID
	cfg["credentialScope"] = "forged"
	id, err := poolTestSaveMember(t, b, in)
	if err != nil {
		t.Fatal(err)
	}
	var version, scope, key string
	var raw []byte
	read := func() {
		t.Helper()
		if err := b.db.QueryRow(ctx, `SELECT c.current_adapter_version_id,c.credential_scope,COALESCE(c.api_key,''),v.configuration FROM image_backend_member_api_config c JOIN image_backend_member_api_adapter_version v ON v.id=c.current_adapter_version_id WHERE c.member_id=$1`, id).Scan(&version, &scope, &key, &raw); err != nil {
			t.Fatal(err)
		}
	}
	read()
	original := version
	if scope != "https://provider.example|bearer" || strings.Contains(string(raw), "old-secret") || strings.Contains(string(raw), "imageSizeConfigId") || !strings.Contains(string(raw), "official-size") {
		t.Fatalf("untrusted snapshot %s %s", scope, raw)
	}
	in["id"] = id
	_, err = poolTestSaveMember(t, b, in)
	assertModelConfigStatus(t, err, 400)
	cfg["expectedCurrentVersionId"] = version
	cfg["apiKey"] = "rotated-secret"
	if _, err = poolTestSaveMember(t, b, in); err != nil {
		t.Fatal(err)
	}
	read()
	if version != original || key != "rotated-secret" {
		t.Fatal("key-only update rewrote immutable adapter")
	}
	records, err := b.backendPoolMembers(httptest.NewRequest("GET", "/api/admin/image-backend/members", nil))
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, record := range records {
		member := record.(map[string]any)
		if member["id"] != id {
			continue
		}
		found = true
		config := member["config"].(map[string]any)
		if config["currentAdapterVersion"].(map[string]any)["id"] != version || config["apiKey"] != nil || config["hasApiKey"] != true {
			t.Fatalf("edit DTO lost version or leaked secret %v", config)
		}
	}
	if !found {
		t.Fatal("saved member absent from read")
	}
	cfg["imageSizeConfig"] = map[string]any{"id": "forged"}
	_, err = poolTestSaveMember(t, b, in)
	assertModelConfigStatus(t, err, 400)
	delete(cfg, "imageSizeConfig")
	// Two editors starting from the same version cannot overwrite each other.
	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i := range 2 {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			var edit map[string]any
			_ = json.Unmarshal([]byte(mustJSON(in)), &edit)
			edit["config"].(map[string]any)["useStream"] = true
			edit["config"].(map[string]any)["videoSubmissionRetryCount"] = i
			_, errs[i] = poolTestWrite(t, b, b.backendPoolSaveMember, "/api/admin/image-backend/members", edit)
		}(i)
	}
	wg.Wait()
	success, conflict := 0, 0
	for _, err := range errs {
		if err == nil {
			success++
		} else if e, ok := err.(*apiError); ok && e.status == 409 {
			conflict++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatalf("CAS results %v", errs)
	}
	read()
	cfg["expectedCurrentVersionId"] = version
	userID, _ := seedAuthUser(t, b)
	generation := newRequestID()
	_, err = b.db.Exec(ctx, `INSERT INTO generation(id,user_id,model,prompt,status,metadata) VALUES($1,$2,'gpt-image-2','test','pending',$3)`, generation, userID, mustJSON(map[string]any{"billingSnapshot": map[string]any{"providerMemberId": id}}))
	if err != nil {
		t.Fatal(err)
	}
	cfg["baseUrl"] = "https://different.example"
	_, err = poolTestSaveMember(t, b, in)
	assertModelConfigStatus(t, err, 409)
	rec := httptest.NewRecorder()
	err = b.backendPoolDeleteMember(rec, httptest.NewRequest("DELETE", "/api/admin/image-backend/members/"+id, nil))
	assertModelConfigStatus(t, err, 409)
	_, _ = b.db.Exec(ctx, `DELETE FROM generation WHERE id=$1`, generation)
	cfg["authentication"] = map[string]any{"mode": "none"}
	if _, err = poolTestSaveMember(t, b, in); err != nil {
		t.Fatal(err)
	}
	read()
	if key != "" {
		t.Fatal("auth none retained credential")
	}
}
func TestPoolGroupTopologyDefaultRoutingAndProviderCapabilities(t *testing.T) {
	b := integrationBackend(t)
	ctx := context.Background()
	root, child, other := poolTestGroup(t, b), poolTestGroup(t, b), poolTestGroup(t, b)
	groupInput := func(id string, children []string) map[string]any {
		return map[string]any{"id": id, "name": "group", "isEnabled": true, "isUserSelectable": true, "contentSafety": "inherit", "childGroupIds": children}
	}
	if _, err := poolTestWrite(t, b, b.backendPoolSaveGroup, "/api/admin/image-backend/groups", groupInput(root, []string{child})); err != nil {
		t.Fatal(err)
	}
	_, err := poolTestWrite(t, b, b.backendPoolSaveGroup, "/api/admin/image-backend/groups", groupInput(child, []string{root}))
	assertModelConfigStatus(t, err, 400)
	_, err = poolTestWrite(t, b, b.backendPoolSaveGroup, "/api/admin/image-backend/groups", groupInput(root, []string{"missing"}))
	assertModelConfigStatus(t, err, 400)
	rec := httptest.NewRecorder()
	err = b.backendPoolDeleteGroup(rec, httptest.NewRequest("DELETE", "/api/admin/image-backend/groups/"+child, nil))
	assertModelConfigStatus(t, err, 409)
	ids, err := reachableMediaGroupIDs(ctx, b.db, root)
	if err != nil || len(ids) != 2 {
		t.Fatalf("tree %v %v", ids, err)
	}
	member := poolTestMember(child)
	member["config"].(map[string]any)["imageMaxReferenceImagesByModel"] = map[string]any{"gpt-image-2": float64(1)}
	id, err := poolTestSaveMember(t, b, member)
	if err != nil {
		t.Fatal(err)
	}
	group := imageGroupSnapshot{ID: root}
	cfg, err := b.pickImageProvider(ctx, "gpt-image-2", group, "", false)
	if err != nil || cfg.memberID != id {
		t.Fatalf("child member not routed %s %v", cfg.memberID, err)
	}
	var body map[string]json.RawMessage
	_ = json.Unmarshal([]byte(`{"model":"gpt-image-2","resolution":"1k","images":[{}]}`), &body)
	cfg, err = b.imageProviderForInput(ctx, "gpt-image-2", group, false, body)
	if err != nil || cfg.memberID != id {
		t.Fatalf("eligible child rejected %v", err)
	}
	body["images"] = json.RawMessage(`[{},{}]`)
	_, err = b.imageProviderForInput(ctx, "gpt-image-2", group, false, body)
	assertModelConfigStatus(t, err, 503)
	body["images"] = json.RawMessage(`[]`)
	body["resolution"] = json.RawMessage(`"4k"`)
	_, err = b.imageProviderForInput(ctx, "gpt-image-2", group, false, body)
	assertModelConfigStatus(t, err, 503)
	_, err = b.pickImageProvider(ctx, "gpt-image-2", imageGroupSnapshot{ID: other}, "", false)
	assertModelConfigStatus(t, err, 503)
	_, _ = b.db.Exec(ctx, `UPDATE image_backend_group SET is_enabled=false WHERE id=$1`, child)
	_, err = b.pickImageProvider(ctx, "gpt-image-2", group, "", false)
	assertModelConfigStatus(t, err, 503)
	var defaults []string
	if err = b.db.QueryRow(ctx, `SELECT COALESCE(array_agg(id),ARRAY[]::text[]) FROM image_backend_group WHERE is_default`).Scan(&defaults); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = b.db.Exec(ctx, `UPDATE image_backend_group SET is_default=(id=ANY($1::text[]))`, defaults)
	})
	for _, id := range []string{root, other} {
		input := groupInput(id, []string{})
		input["isDefault"] = true
		if _, err = poolTestWrite(t, b, b.backendPoolSaveGroup, "/api/admin/image-backend/groups", input); err != nil {
			t.Fatal(err)
		}
	}
	var count int
	if err = b.db.QueryRow(ctx, `SELECT count(*) FROM image_backend_group WHERE is_default`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("default not unique %d %v", count, err)
	}
}

func TestPoolHTTPFiltersAndObserverCannotMutateSizes(t *testing.T) {
	b := integrationBackend(t)
	ctx := context.Background()
	userID, email := seedAuthUser(t, b)
	if _, err := b.db.Exec(ctx, `UPDATE "user" SET role='observer_admin' WHERE id=$1`, userID); err != nil {
		t.Fatal(err)
	}
	cookie := signInTestUser(t, b, email)
	denied := authRequest(t, b, "POST", "/api/admin/image-backend/size-configs", `{"name":"forbidden","mappings":[{"resolution":"1k","aspectRatio":"1:1","size":"1024x1024"}]}`, cookie)
	if denied.Code != 403 {
		t.Fatalf("observer size write returned %d %s", denied.Code, denied.Body.String())
	}
	group := poolTestGroup(t, b)
	in := poolTestMember(group)
	in["name"] = "supplier-" + newRequestID()
	id, err := poolTestSaveMember(t, b, in)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = b.db.Exec(ctx, `UPDATE image_backend_member SET created_at='2026-09-13 16:30:00+00' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	name := in["name"].(string)
	for _, test := range []struct {
		query string
		count int
	}{
		{"&modelId=gpt-image-2&resolution=1k&createdFrom=2026-09-14&createdTo=2026-09-14&timeZone=Asia%2FShanghai", 1},
		{"&modelId=gpt-image-2&resolution=4k", 0},
		{"&createdFrom=2026-09-14&timeZone=UTC", 0},
	} {
		response := authRequest(t, b, "GET", "/api/admin/image-backend/members?name="+name+test.query, "", cookie)
		var payload map[string]any
		_ = json.Unmarshal(response.Body.Bytes(), &payload)
		if response.Code != 200 || int(numberValue(payload["totalCount"])) != test.count {
			t.Fatalf("filter %s: %d %s", test.query, response.Code, response.Body.String())
		}
	}
	response := authRequest(t, b, "GET", "/api/admin/image-backend/pool", "", cookie)
	if response.Code != 200 {
		t.Fatalf("pool read %d", response.Code)
	}
	var payload map[string]any
	_ = json.Unmarshal(response.Body.Bytes(), &payload)
	for _, raw := range payload["members"].([]any) {
		member := raw.(map[string]any)
		if _, exists := member["credentialHealthStatus"]; exists {
			t.Fatal("pool emitted list-only field outside strict contract")
		}
	}
}
