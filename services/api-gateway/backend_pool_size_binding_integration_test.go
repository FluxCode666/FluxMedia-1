//go:build integration

package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestPoolSizeConfigUpdatesBoundVersionsAndPreservesHistory(t *testing.T) {
	b := integrationBackend(t)
	ctx := context.Background()
	user, email := seedAuthUser(t, b)
	if _, err := b.db.Exec(ctx, `UPDATE "user" SET role='super_admin' WHERE id=$1`, user); err != nil {
		t.Fatal(err)
	}
	cookie := signInTestUser(t, b, email)
	path := "/api/admin/image-backend/size-configs"
	id := "binding-" + newRequestID()
	input := map[string]any{"id": id, "name": "binding size", "mappings": []any{map[string]any{"resolution": "1k", "aspectRatio": "1:1", "size": "1024x1024"}}}
	save := func() int { return authRequest(t, b, http.MethodPost, path, mustJSON(input), cookie).Code }
	if status := save(); status != 200 {
		t.Fatalf("create size status %d", status)
	}
	t.Cleanup(func() { _, _ = b.db.Exec(ctx, `DELETE FROM image_size_config WHERE id=$1`, id) })
	group := poolTestGroup(t, b)
	memberInput := poolTestMember(group)
	memberInput["config"].(map[string]any)["imageSizeConfigId"] = id
	memberInput["config"].(map[string]any)["imageSizeConfigIdsByModel"] = map[string]any{"gpt-image-2": id}
	member, err := poolTestSaveMember(t, b, memberInput)
	if err != nil {
		t.Fatal(err)
	}
	read := func() (string, map[string]any) {
		t.Helper()
		var version string
		var raw []byte
		if err := b.db.QueryRow(ctx, `SELECT c.current_adapter_version_id,v.configuration FROM image_backend_member_api_config c JOIN image_backend_member_api_adapter_version v ON v.id=c.current_adapter_version_id WHERE c.member_id=$1`, member).Scan(&version, &raw); err != nil {
			t.Fatal(err)
		}
		var cfg map[string]any
		if err := json.Unmarshal(raw, &cfg); err != nil {
			t.Fatal(err)
		}
		return version, cfg
	}
	original, _ := read()
	if status := save(); status != 200 {
		t.Fatalf("unchanged save %d", status)
	}
	if current, _ := read(); current != original {
		t.Fatal("unchanged size created an adapter version")
	}
	input["name"] = "updated binding"
	input["mappings"].([]any)[0].(map[string]any)["size"] = "1152x1152"
	if status := save(); status != 200 {
		t.Fatalf("update size %d", status)
	}
	updated, cfg := read()
	if updated == original || !strings.Contains(mustJSON(cfg["imageSizeConfig"]), "1152x1152") || !strings.Contains(mustJSON(goMapObject(cfg, "imageSizeConfigsByModel")["gpt-image-2"]), "1152x1152") {
		t.Fatal("both size bindings did not advance")
	}
	var historical string
	if err := b.db.QueryRow(ctx, `SELECT configuration::text FROM image_backend_member_api_adapter_version WHERE id=$1`, original).Scan(&historical); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(historical, "1024x1024") || strings.Contains(historical, "1152x1152") {
		t.Fatal("historical task adapter mutated")
	}
	memberInput["id"] = member
	memberInput["config"].(map[string]any)["expectedCurrentVersionId"] = original
	if _, err := poolTestSaveMember(t, b, memberInput); err == nil {
		t.Fatal("stale member edit overwrote updated size binding")
	}
	// A failure after writing the size table must roll back both it and all
	// supplier versions, including when the version-pointer write is rejected.
	trigger := "fail_size_binding_" + newRequestID()
	statement := `CREATE FUNCTION ` + trigger + `() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.member_id='` + member + `' THEN RAISE EXCEPTION 'test pointer failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER ` + trigger + ` BEFORE UPDATE ON image_backend_member_api_config FOR EACH ROW EXECUTE FUNCTION ` + trigger + `() `
	if _, err := b.db.Exec(ctx, statement); err != nil {
		t.Fatal(err)
	}
	cleanupTrigger := func() {
		_, _ = b.db.Exec(ctx, `DROP TRIGGER IF EXISTS `+trigger+` ON image_backend_member_api_config; DROP FUNCTION IF EXISTS `+trigger+`()`)
	}
	t.Cleanup(cleanupTrigger)
	input["name"] = "must rollback"
	if status := save(); status < 400 {
		t.Fatal("late adapter failure committed size update")
	}
	current, _ := read()
	var name string
	if err := b.db.QueryRow(ctx, `SELECT name FROM image_size_config WHERE id=$1`, id).Scan(&name); err != nil {
		t.Fatal(err)
	}
	if current != updated || name != "updated binding" {
		t.Fatal("failed version switch leaked size state")
	}
	cleanupTrigger()
	if response := authRequest(t, b, http.MethodDelete, path+"/"+id, "", cookie); response.Code != 200 {
		t.Fatalf("delete size %d %s", response.Code, response.Body.String())
	}
	deleted, cfg := read()
	if deleted == updated || cfg["imageSizeConfig"] != nil || goMapObject(cfg, "imageSizeConfigsByModel")["gpt-image-2"] != nil {
		t.Fatal("deleted size remains bound to current adapter")
	}
	if err := b.db.QueryRow(ctx, `SELECT configuration::text FROM image_backend_member_api_adapter_version WHERE id=$1`, updated).Scan(&historical); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(historical, "1152x1152") {
		t.Fatal("delete changed historical adapter")
	}
}
