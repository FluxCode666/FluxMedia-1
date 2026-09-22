//go:build integration

package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/png"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestImagePostprocessingRuntimeRepairPersistsChargeAndReleasesLease(t *testing.T) {
	b := integrationBackend(t)
	ctx := context.Background()
	uid, _ := seedAuthUser(t, b)
	b.config.storagePath = t.TempDir()
	setStorageTestSetting(t, b, "STORAGE_ENDPOINT", "")
	setStorageTestSetting(t, b, "GENERATIONS_BUCKET_NAME", "generations")
	setStorageTestSetting(t, b, "CONTENT_MODERATION_ENABLED", false)
	setStorageTestSetting(t, b, "IMAGE_BLOCK_REPAIR_ENABLED", true)
	setStorageTestSetting(t, b, "IMAGE_MASK_OUTPAINT_ENABLED", false)
	setStorageTestSetting(t, b, "IMAGE_SUPER_RESOLUTION_ENABLED", false)
	seedImagePricingSettings(t, b, "gpt-image-2")
	creditTestWallet(t, b, uid, 100)
	creditTestBatch(t, b, uid, "purchase", 100, nil)
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, image.NewNRGBA(image.Rect(0, 0, 32, 24))); err != nil {
		t.Fatal(err)
	}
	fixture := encoded.Bytes()
	var calls, edits atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path == "/edit" {
			edits.Add(1)
			if err := r.ParseMultipartForm(16 << 20); err != nil {
				t.Error(err)
				w.WriteHeader(500)
				return
			}
			defer r.MultipartForm.RemoveAll()
			if r.FormValue("prompt") != "restore requested" {
				t.Error("repair prompt was not forwarded")
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]any{"b64_json": base64.StdEncoding.EncodeToString(fixture)}}})
	}))
	defer provider.Close()
	group := seedImagePricingGroup(t, b, true, nil, nil)
	child := seedImagePricingGroup(t, b, false, nil, nil)
	if _, err := b.db.Exec(ctx, `UPDATE image_backend_group SET metadata=$2 WHERE id=$1`, group, mustJSON(map[string]any{"childGroupIds": []string{child}})); err != nil {
		t.Fatal(err)
	}
	member := seedImagePricingMember(t, b, child, "gpt-image-2", provider.URL, false, 1)
	adapter := map[string]any{"baseUrl": provider.URL, "operations": map[string]any{"images.generate": map[string]any{"path": "/generate"}, "images.edit": map[string]any{"path": "/edit"}}}
	if _, err := b.db.Exec(ctx, `UPDATE image_backend_member_api_adapter_version SET configuration=$2 WHERE member_id_snapshot=$1`, member, mustJSON(adapter)); err != nil {
		t.Fatal(err)
	}
	// Higher-priority members cannot handle the repair dimensions. Both primary
	// routing and auxiliary edits must skip them rather than lose the repair.
	unsupported := seedImagePricingMember(t, b, child, "gpt-image-2", "http://127.0.0.1:1", false, 0)
	if _, err := b.db.Exec(ctx, `UPDATE image_backend_member SET supported_resolutions_by_model=$2 WHERE id=$1`, unsupported, mustJSON(map[string]any{"gpt-image-2": []string{"2k"}})); err != nil {
		t.Fatal(err)
	}
	wrongSize := seedImagePricingMember(t, b, child, "gpt-image-2", "http://127.0.0.1:1", false, 0)
	wrongAdapter := map[string]any{"baseUrl": "http://127.0.0.1:1", "operations": adapter["operations"], "imageSizeConfig": map[string]any{"id": "wrong-size", "name": "wrong size", "mappings": []any{map[string]any{"resolution": "1k", "aspectRatio": "1:1", "size": "1024x1024"}}}}
	if _, err := b.db.Exec(ctx, `UPDATE image_backend_member_api_adapter_version SET configuration=$2 WHERE member_id_snapshot=$1`, wrongSize, mustJSON(wrongAdapter)); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	command := exec.Command("node", "../media-processing-runtime/server.mjs")
	command.Env = append(os.Environ(), "MEDIA_PROCESSING_PORT="+strconv.Itoa(port), "MEDIA_PROCESSING_HOST=127.0.0.1")
	var runtimeOutput bytes.Buffer
	command.Stdout = &runtimeOutput
	command.Stderr = &runtimeOutput
	if err = command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = command.Process.Kill(); _ = command.Wait() })
	runtimeURL := "http://127.0.0.1:" + strconv.Itoa(port)
	t.Setenv("GO_MEDIA_PROCESSING_URL", runtimeURL)
	ready := false
	for i := 0; i < 100; i++ {
		response, err := http.Get(runtimeURL + "/healthz")
		if err == nil {
			_ = response.Body.Close()
			ready = response.StatusCode == 200
			if ready {
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !ready {
		t.Fatal("media runtime did not start")
	}
	input := imagePricingInput(map[string]any{"model": "gpt-image-2", "prompt": "test", "backendGroupId": group, "resolution": "1k", "blockRepair": true, "repairPrompt": "restore requested"})
	task, err := b.createImageTask(httptest.NewRequest("POST", "http://localhost/api/images/generate", nil), &apiPrincipal{UserID: uid}, input, "generate")
	if err != nil {
		t.Fatal(err)
	}
	taskID, generationID := stringValue(task["id"]), stringValue(task["generationId"])
	worker := mediaWorker{backend: b}
	work, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if err = worker.processImage(work, taskID); err != nil {
		t.Fatal(err)
	}
	var status string
	var amount float64
	var raw []byte
	if err = b.db.QueryRow(ctx, `SELECT status,credits_consumed,metadata FROM generation WHERE id=$1`, generationID).Scan(&status, &amount, &raw); err != nil {
		t.Fatal(err)
	}
	if status != "completed" || calls.Load() != 2 || edits.Load() != 1 || amount != 4.04 {
		t.Fatalf("repair pipeline failed status=%s calls=%d edits=%d amount=%v metadata=%s", status, calls.Load(), edits.Load(), amount, raw)
	}
	var metadata map[string]any
	_ = json.Unmarshal(raw, &metadata)
	receipt := goMapObject(goMapObject(metadata, "imageRepairSteps"), "0:0")
	if receipt["stage"] != "completed" {
		t.Fatal("paid repair receipt missing")
	}
	var leases int
	if err = b.db.QueryRow(ctx, `SELECT count(*) FROM image_backend_member_lease WHERE id LIKE $1`, "%"+taskID+"%").Scan(&leases); err != nil || leases != 0 {
		t.Fatalf("repair leaked capacity %d %v", leases, err)
	}
	if err = worker.processImage(work, taskID); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 {
		t.Fatal("completed task repeated paid repair")
	}
	if a, success, failed, _ := schedulerCounts(t, b, member); a != 2 || success != 2 || failed != 0 {
		t.Fatalf("main and repair outcomes collapsed or replayed: %d/%d/%d", a, success, failed)
	}
	if err = b.cleanupImageRepairObjects(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = b.readStorageObject(ctx, extractString(receipt, "storageBucket"), extractString(receipt, "storageKey")); err == nil {
		t.Fatal("repair intermediate was not reclaimed")
	}
	// The single repair charge is attributed to the original generation and is replay safe.
	var chargeCount int
	if err = b.db.QueryRow(ctx, `SELECT count(*) FROM credits_transaction WHERE source_ref LIKE $1`, generationID+":blockrepair-%").Scan(&chargeCount); err != nil || chargeCount != 1 {
		t.Fatalf("repair charge count=%d err=%v", chargeCount, err)
	}
	if strings.Contains(string(raw), "imageBase64") {
		t.Fatal("runtime bytes leaked into generation metadata")
	}
}
