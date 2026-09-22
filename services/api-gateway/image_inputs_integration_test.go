//go:build integration

package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/png"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func TestImageInputsStageValidateAndCleanupOwnership(t *testing.T) {
	b := integrationBackend(t)
	b.config.storagePath = t.TempDir()
	setStorageTestSetting(t, b, "STORAGE_ENDPOINT", "")
	setStorageTestSetting(t, b, "GENERATION_STORAGE_BUCKET_NAME", "generations")
	uid, email := seedAuthUser(t, b)
	cookie := signInTestUser(t, b, email)
	otherID, otherEmail := seedAuthUser(t, b)
	otherCookie := signInTestUser(t, b, otherEmail)
	var data bytes.Buffer
	if err := png.Encode(&data, image.NewNRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	ref := imageInputReference{Source: "data", MIME: "image/png", Base64: base64.StdEncoding.EncodeToString(data.Bytes()), Bytes: data.Len()}
	stage := func(refs []imageInputReference, cookie *http.Cookie) *stagedImageInputs {
		t.Helper()
		raw, _ := json.Marshal(map[string]any{"references": refs, "generationId": "staging-test"})
		w := storageTestRequest(b, "POST", "/api/image-generation/inputs/stage", raw, cookie, nil)
		if w.Code != 200 {
			t.Fatalf("stage %d %s", w.Code, w.Body.String())
		}
		var out stagedImageInputs
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return &out
	}
	staged := stage([]imageInputReference{ref}, cookie)
	if len(staged.References) != 1 || len(staged.Objects) != 1 || staged.Objects[0].UserID != uid || staged.References[0].Base64 != "" {
		t.Fatalf("stage result %#v", staged)
	}
	object := staged.Objects[0]
	stored, err := b.readStorageObject(context.Background(), object.Bucket, object.Key)
	if err != nil || !bytes.Equal(stored, data.Bytes()) {
		t.Fatalf("staged bytes: %v", err)
	}
	if again := stage(staged.References, cookie); len(again.Objects) != 0 || again.References[0].Key != object.Key {
		t.Fatal("storage reference copied again")
	}
	for _, bad := range []imageInputReference{
		{Source: "data", MIME: "image/jpeg", Base64: ref.Base64, Bytes: ref.Bytes},
		{Source: "data", MIME: "image/png", Base64: ref.Base64, Bytes: ref.Bytes + 1},
		{Source: "remote", MIME: "image/png", URL: "https://127.0.0.1/private.png", Bytes: ref.Bytes},
		{Source: "storage", MIME: "image/png", Bucket: object.Bucket, Key: "../escape", Bytes: ref.Bytes},
	} {
		raw, _ := json.Marshal(map[string]any{"references": []imageInputReference{bad}})
		w := storageTestRequest(b, "POST", "/api/image-generation/inputs/stage", raw, cookie, nil)
		if w.Code != 400 {
			t.Fatalf("invalid reference %s accepted: %d %s", bad.Source, w.Code, w.Body.String())
		}
	}
	for _, operation := range []string{"stage", "cleanup"} {
		input := map[string]any{"references": staged.References}
		if operation == "cleanup" {
			input = map[string]any{"objects": staged.Objects}
		}
		raw, _ := json.Marshal(input)
		w := storageTestRequest(b, "POST", "/api/image-generation/inputs/"+operation, raw, otherCookie, nil)
		if w.Code != 403 {
			t.Fatalf("cross user %s accepted: %d %s (%s)", operation, w.Code, w.Body.String(), otherID)
		}
	}
	// A failed batch must remove the first successfully staged object.
	bad := ref
	bad.Bytes++
	raw, _ := json.Marshal(map[string]any{"references": []imageInputReference{ref, bad}})
	w := storageTestRequest(b, "POST", "/api/image-generation/inputs/stage", raw, cookie, nil)
	if w.Code != 400 {
		t.Fatalf("failed batch: %d", w.Code)
	}
	count := 0
	_ = filepath.Walk(b.config.storagePath, func(_ string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			count++
		}
		return nil
	})
	if count != 1 {
		t.Fatalf("failed staging leaked %d files", count-1)
	}
	// Input adopted by a generation must survive a client-side timeout cleanup.
	gid := newRequestID()
	metadata := mustJSON(map[string]any{"input": map[string]any{"images": staged.References}})
	_, err = b.db.Exec(context.Background(), `INSERT INTO generation(id,user_id,prompt,model,status,metadata) VALUES($1,$2,'test','test','pending',$3)`, gid, uid, metadata)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = b.db.Exec(context.Background(), `DELETE FROM generation WHERE id=$1`, gid) })
	raw, _ = json.Marshal(map[string]any{"objects": staged.Objects})
	w = storageTestRequest(b, "POST", "/api/image-generation/inputs/cleanup", raw, cookie, nil)
	if w.Code != 200 {
		t.Fatalf("adopted cleanup: %d %s", w.Code, w.Body.String())
	}
	if _, err = b.readStorageObject(context.Background(), object.Bucket, object.Key); err != nil {
		t.Fatal("adopted image was deleted")
	}
	_, _ = b.db.Exec(context.Background(), `DELETE FROM generation WHERE id=$1`, gid)
	w = storageTestRequest(b, "POST", "/api/image-generation/inputs/cleanup", raw, cookie, nil)
	if w.Code != 200 {
		t.Fatalf("cleanup: %d %s", w.Code, w.Body.String())
	}
	if _, err = b.readStorageObject(context.Background(), object.Bucket, object.Key); err == nil {
		t.Fatal("unadopted object was not deleted")
	}
}
