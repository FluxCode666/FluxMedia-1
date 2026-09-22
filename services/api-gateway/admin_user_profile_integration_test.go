//go:build integration

package main

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

func TestAdminUserProfilePersistsAvatarClearAndAtomicAudit(t *testing.T) {
	b := integrationBackend(t)
	ctx := context.Background()
	admin, email := seedAuthUser(t, b)
	target, _ := seedAuthUser(t, b)
	if _, err := b.db.Exec(ctx, `UPDATE "user" SET role='super_admin' WHERE id=$1`, admin); err != nil {
		t.Fatal(err)
	}
	cookie := signInTestUser(t, b, email)
	t.Cleanup(func() {
		_, _ = b.db.Exec(ctx, `DELETE FROM admin_audit_log WHERE admin_user_id=$1 AND target_user_id=$2`, admin, target)
	})
	path := "/api/admin/users/" + target
	avatar := "https://example.com/avatar.png"
	assertStored := func(wantName string, wantImage *string, audits int) {
		t.Helper()
		var name string
		var image *string
		var count int
		if err := b.db.QueryRow(ctx, `SELECT name,image,(SELECT count(*) FROM admin_audit_log WHERE target_user_id=$1 AND action='user.profile.update') FROM "user" WHERE id=$1`, target).Scan(&name, &image, &count); err != nil {
			t.Fatal(err)
		}
		if name != wantName || (image == nil) != (wantImage == nil) || image != nil && *image != *wantImage || count != audits {
			t.Fatalf("name=%q image=%v audits=%d; want name=%q image=%v audits=%d", name, image, count, wantName, wantImage, audits)
		}
	}
	requireCreditResponse(t, authRequest(t, b, http.MethodPatch, path, mustJSON(map[string]any{"userId": target, "name": "Renamed", "image": avatar}), cookie), 200)
	assertStored("Renamed", &avatar, 1)
	var before, after map[string]any
	if err := b.db.QueryRow(ctx, `SELECT before,after FROM admin_audit_log WHERE admin_user_id=$1 AND target_user_id=$2 AND action='user.profile.update'`, admin, target).Scan(&before, &after); err != nil {
		t.Fatal(err)
	}
	if before["image"] != nil || before["name"] != "Test" || after["image"] != avatar || after["name"] != "Renamed" {
		t.Fatalf("incorrect profile audit: before=%v after=%v", before, after)
	}
	// Omitting image preserves the existing avatar.
	requireCreditResponse(t, authRequest(t, b, http.MethodPatch, path, `{"name":"Name only"}`, cookie), 200)
	assertStored("Name only", &avatar, 2)
	// A failed combined profile write must roll back the avatar and its audit.
	failed := authRequest(t, b, http.MethodPatch, path, mustJSON(map[string]any{"email": email, "image": nil}), cookie)
	if failed.Code < 400 {
		t.Fatalf("duplicate email mutation unexpectedly succeeded: %s", failed.Body.String())
	}
	assertStored("Name only", &avatar, 2)
	for _, invalidImage := range []any{42, false, map[string]any{"url": avatar}, "", "not a URL", "javascript:alert(1)"} {
		t.Run("invalid "+mustJSON(invalidImage), func(t *testing.T) {
			requireCreditResponse(t, authRequest(t, b, http.MethodPatch, path, mustJSON(map[string]any{"name": "Should not persist", "image": invalidImage}), cookie), 400)
			assertStored("Name only", &avatar, 2)
		})
	}
	requireCreditResponse(t, authRequest(t, b, http.MethodPatch, path, mustJSON(map[string]any{"userId": admin, "image": nil}), cookie), 400)
	assertStored("Name only", &avatar, 2)
	// Explicit null clears the stored avatar rather than behaving like omission.
	requireCreditResponse(t, authRequest(t, b, http.MethodPatch, path, `{"image":null}`, cookie), 200)
	assertStored("Name only", nil, 3)
	var clearAfter []byte
	if err := b.db.QueryRow(ctx, `SELECT after FROM admin_audit_log WHERE target_user_id=$1 AND action='user.profile.update' ORDER BY created_at DESC LIMIT 1`, target).Scan(&clearAfter); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(clearAfter, &after); err != nil {
		t.Fatal(err)
	}
	if after["image"] != nil {
		t.Fatalf("clear audit image=%v", after["image"])
	}
}

func TestAdminUserProfileAvatarRequiresSuperAdminForSetAndClear(t *testing.T) {
	b := integrationBackend(t)
	ctx := context.Background()
	target, _ := seedAuthUser(t, b)
	avatar := "https://example.com/original.png"
	if _, err := b.db.Exec(ctx, `UPDATE "user" SET image=$1 WHERE id=$2`, avatar, target); err != nil {
		t.Fatal(err)
	}
	path := "/api/admin/users/" + target
	for _, role := range []string{"admin", "observer_admin", "user"} {
		t.Run(role, func(t *testing.T) {
			actor, email := seedAuthUser(t, b)
			if _, err := b.db.Exec(ctx, `UPDATE "user" SET role=$1 WHERE id=$2`, role, actor); err != nil {
				t.Fatal(err)
			}
			cookie := signInTestUser(t, b, email)
			for _, body := range []string{`{"image":"https://example.com/replaced.png"}`, `{"image":null}`, `{"banned":true,"image":null}`} {
				requireCreditResponse(t, authRequest(t, b, http.MethodPatch, path, body, cookie), 403)
			}
		})
	}
	requireCreditResponse(t, authRequest(t, b, http.MethodPatch, path, `{"image":null}`), 401)
	var stored string
	var banned bool
	if err := b.db.QueryRow(ctx, `SELECT image,banned FROM "user" WHERE id=$1`, target).Scan(&stored, &banned); err != nil {
		t.Fatal(err)
	}
	if stored != avatar || banned {
		t.Fatalf("unauthorized avatar update changed user: image=%s banned=%v", stored, banned)
	}
}
