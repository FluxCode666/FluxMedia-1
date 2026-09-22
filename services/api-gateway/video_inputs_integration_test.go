//go:build integration

package main

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

func TestVideoInputsAdoptionAndOwnership(t *testing.T) {
	b := integrationBackend(t)
	b.config.storagePath = t.TempDir()
	ctx := context.Background()
	setStorageTestSetting(t, b, "STORAGE_ENDPOINT", "")
	uid, _ := seedAuthUser(t, b)
	other, _ := seedAuthUser(t, b)
	id, attempt := newRequestID(), newRequestID()
	if _, err := b.db.Exec(ctx, `INSERT INTO video_task_staging_reservation(task_id,reservation_token,user_id,principal_scope,expires_at) VALUES($1,$2,$3,$3,now()+interval '10 minutes')`, id, attempt, uid); err != nil {
		t.Fatal(err)
	}
	data := []byte{0x89, 'P', 'N', 'G', 13, 10, 26, 10, 0, 0, 0, 0}
	input := map[string]any{"firstFrame": map[string]any{"source": "data", "mimeType": "image/png", "base64": base64.StdEncoding.EncodeToString(data), "byteLength": len(data)}}
	manifest, err := b.stageNativeVideoInputs(ctx, uid, id, input)
	if err != nil {
		t.Fatal(err)
	}
	frame := manifest["firstFrame"].(map[string]any)
	if frame["source"] != "storage" || frame["base64"] != nil {
		t.Fatal("input not persisted", frame)
	}
	key, bucket := mapString(frame, "storageKey"), mapString(frame, "storageBucket")
	if _, err := b.readStorageObject(ctx, bucket, key); err != nil {
		t.Fatal(err)
	}
	if _, err := b.stageNativeVideoInputs(ctx, other, id, map[string]any{"firstFrame": frame}); err == nil {
		t.Fatal("foreign staging admitted")
	}
	var count int
	if err := b.db.QueryRow(ctx, `SELECT count(*) FROM video_input_cleanup WHERE video_id=$1`, id).Scan(&count); err != nil || count != 1 {
		t.Fatalf("missing orphan intent %d %v", count, err)
	}
	tx, err := b.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := b.adoptNativeVideoInputs(ctx, tx, uid, id, manifest); err != nil {
		rollback(tx)
		t.Fatal(err)
	}
	rollback(tx)
	if err := b.db.QueryRow(ctx, `SELECT count(*) FROM video_input_cleanup WHERE video_id=$1`, id).Scan(&count); err != nil || count != 1 {
		t.Fatal("rollback lost orphan cleanup")
	}
	tx, err = b.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := b.adoptNativeVideoInputs(ctx, tx, uid, id, manifest); err != nil {
		rollback(tx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := b.db.QueryRow(ctx, `SELECT count(*) FROM video_input_cleanup WHERE video_id=$1`, id).Scan(&count); err != nil || count != 0 {
		t.Fatal("adopted input left orphan")
	}
}

func TestVideoInputsValidateContentsBeforeUpload(t *testing.T) {
	b := integrationBackend(t)
	b.config.storagePath = t.TempDir()
	ctx := context.Background()
	setStorageTestSetting(t, b, "STORAGE_ENDPOINT", "")
	uid, _ := seedAuthUser(t, b)
	id := newRequestID()
	if _, err := b.db.Exec(ctx, `INSERT INTO video_task_staging_reservation(task_id,reservation_token,user_id,principal_scope,expires_at) VALUES($1,$2,$3,$3,now()+interval '10 minutes')`, id, newRequestID(), uid); err != nil {
		t.Fatal(err)
	}
	for _, ref := range []map[string]any{
		{"source": "data", "mimeType": "image/png", "base64": base64.StdEncoding.EncodeToString([]byte("not a PNG")), "byteLength": 9},
		{"source": "remote", "mimeType": "image/png", "url": "http://127.0.0.1/private.png"},
		{"source": "storage", "mimeType": "image/png", "storageBucket": "generations", "storageKey": "other/private.png"},
	} {
		if _, err := b.stageNativeVideoInputs(ctx, uid, id, map[string]any{"firstFrame": ref}); err == nil {
			t.Fatal("invalid input accepted", ref)
		}
	}
	var count int
	if err := b.db.QueryRow(ctx, `SELECT count(*) FROM video_input_cleanup WHERE video_id=$1`, id).Scan(&count); err != nil || count != 0 {
		t.Fatal("invalid inputs were uploaded")
	}
}

func TestVideoInputsAssetsRespectOwnershipAndExposeOnlySignedMedia(t *testing.T) {
	b := integrationBackend(t)
	b.config.storagePath = t.TempDir()
	ctx := context.Background()
	setStorageTestSetting(t, b, "STORAGE_ENDPOINT", "")
	setStorageTestSetting(t, b, "GENERATIONS_BUCKET_NAME", "generations")
	owner, ownerEmail := seedAuthUser(t, b)
	_, otherEmail := seedAuthUser(t, b)
	observer, observerEmail := seedAuthUser(t, b)
	if _, err := b.db.Exec(ctx, `UPDATE "user" SET role='observer_admin' WHERE id=$1`, observer); err != nil {
		t.Fatal(err)
	}
	taskID := newRequestID()
	key := owner + "/video-inputs/" + taskID + "/attempt/firstFrame-0.png"
	data := []byte{0x89, 'P', 'N', 'G', 13, 10, 26, 10, 0, 0, 0, 0}
	if err := b.putStorageObject(ctx, "generations", key, data, "image/png"); err != nil {
		t.Fatal(err)
	}
	manifest := map[string]any{"firstFrame": map[string]any{"source": "storage", "mimeType": "image/png", "storageBucket": "generations", "storageKey": key, "byteLength": len(data)}}
	if _, err := b.db.Exec(ctx, `INSERT INTO video_generation(id,user_id,principal_scope,model,prompt,duration_seconds,aspect_ratio,resolution,output_width,output_height,storage_bucket,status,stage,input_manifest) VALUES($1,$2,$2,'veo31','preview',8,'16:9','720p',1280,720,'generations','pending','created',$3)`, taskID, owner, mustJSON(manifest)); err != nil {
		t.Fatal(err)
	}
	body := mustJSON(map[string]any{"taskId": taskID})
	path := "/api/image-generation/video-inputs"
	requireCreditResponse(t, authRequest(t, b, http.MethodPost, path, body), 401)
	requireCreditResponse(t, authRequest(t, b, http.MethodPost, path, body, signInTestUser(t, b, otherEmail)), 404)
	for _, email := range []string{ownerEmail, observerEmail} {
		response := authRequest(t, b, http.MethodPost, path, body, signInTestUser(t, b, email))
		out := requireCreditResponse(t, response, 200)
		asset := out["firstFrame"].(map[string]any)
		if len(asset) != 2 || asset["mimeType"] != "image/png" || out["taskId"] != taskID || out["summary"].(map[string]any)["mode"] != "first-frame" {
			t.Fatalf("invalid public projection: %v", out)
		}
		signed, err := url.Parse(asset["url"].(string))
		if err != nil || !signed.IsAbs() || signed.Query().Get("sig") == "" || signed.Query().Get("exp") == "" {
			t.Fatalf("asset lacks signed absolute URL: %v", asset)
		}
		read := authRequest(t, b, http.MethodGet, signed.RequestURI(), "")
		if read.Code != 200 || !strings.Contains(response.Header().Get("Cache-Control"), "no-store") || !strings.EqualFold(read.Header().Get("Content-Type"), "image/png") {
			t.Fatalf("signed read failed: %d %s", read.Code, read.Body.String())
		}
	}
	if _, err := b.readStorageObjectLimited(ctx, "generations", key, int64(len(data)-1)); err == nil {
		t.Fatal("oversized storage object accepted")
	}
	if exact, err := b.readStorageObjectLimited(ctx, "generations", key, int64(len(data))); err != nil || len(exact) != len(data) {
		t.Fatalf("exact size object rejected: %v", err)
	}
}
