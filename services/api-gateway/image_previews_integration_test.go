//go:build integration

package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type imagePreviewRecorder struct {
	*httptest.ResponseRecorder
	partial chan struct{}
	once    sync.Once
}

func (w *imagePreviewRecorder) Write(data []byte) (int, error) {
	if strings.Contains(string(data), "event: image_generation.partial_image") {
		w.once.Do(func() { close(w.partial) })
	}
	return w.ResponseRecorder.Write(data)
}

func TestImagePreviewArrivesBeforeProviderCompletesAndIsNotBillable(t *testing.T) {
	b := integrationBackend(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	uid, _ := seedAuthUser(t, b)
	b.config.storagePath = t.TempDir()
	setStorageTestSetting(t, b, "STORAGE_ENDPOINT", "")
	setStorageTestSetting(t, b, "CONTENT_MODERATION_ENABLED", false)
	setStorageTestSetting(t, b, "IMAGE_SUPER_RESOLUTION_ENABLED", false)
	model := "preview-" + newRequestID()
	seedImagePricingSettings(t, b, model)
	creditTestWallet(t, b, uid, 100)
	creditTestBatch(t, b, uid, "purchase", 100, nil)
	preview := make(chan struct{})
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "event: image_generation.partial_image\ndata: {\"partial_image_b64\":\"cHJldmlldw==\",\"partial_image_index\":0}\n\n")
		w.(http.Flusher).Flush()
		select {
		case <-preview:
		case <-ctx.Done():
			return
		}
		_, _ = fmt.Fprintf(w, "event: image_generation.completed\ndata: {\"b64_json\":\"%s\"}\n\n", base64.StdEncoding.EncodeToString([]byte("final image")))
	}))
	defer provider.Close()
	group := seedImagePricingGroup(t, b, true, nil, nil)
	member := seedImagePricingMember(t, b, group, model, provider.URL, false, 1)
	if _, err := b.db.Exec(ctx, `UPDATE image_backend_member_api_adapter_version SET configuration=(configuration::jsonb||'{"useStream":true}'::jsonb)::json WHERE member_id_snapshot=$1`, member); err != nil {
		t.Fatal(err)
	}
	key, _ := seedPublicImageKey(t, b, uid, group)
	generationID := newRequestID()
	taskID := "task_" + generationID
	t.Cleanup(func() { _ = b.redis.Del(context.Background(), "fluxmedia:go:image-preview:"+taskID).Err() })
	workerDone := make(chan error, 1)
	go func() {
		for {
			var exists bool
			err := b.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM image_async_task WHERE id=$1)`, taskID).Scan(&exists)
			if err != nil {
				workerDone <- err
				return
			}
			if exists {
				worker := mediaWorker{backend: b}
				workerDone <- worker.processImage(ctx, taskID)
				return
			}
			select {
			case <-ctx.Done():
				workerDone <- ctx.Err()
				return
			case <-time.After(10 * time.Millisecond):
			}
		}
	}()
	request := httptest.NewRequest("POST", "http://localhost:3000/v1/images/generations", strings.NewReader(mustJSON(map[string]any{"model": model, "prompt": "preview test", "generationId": generationID, "stream": true}))).WithContext(ctx)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+key)
	out := &imagePreviewRecorder{ResponseRecorder: httptest.NewRecorder(), partial: preview}
	b.handler().ServeHTTP(out, request)
	if err := <-workerDone; err != nil {
		t.Fatal(err)
	}
	result := out.Body.String()
	partial, complete := strings.Index(result, "event: image_generation.partial_image"), strings.Index(result, "event: image_generation.completed")
	if partial < 0 || complete <= partial {
		t.Fatalf("live partial stream missing: %s", result)
	}
	var credits float64
	var count int
	if err := b.db.QueryRow(ctx, `SELECT credits_consumed,jsonb_array_length(metadata::jsonb->'outputImage'->'imageOutputs') FROM generation WHERE id=$1`, generationID).Scan(&credits, &count); err != nil {
		t.Fatal(err)
	}
	if count != 1 || credits != 1.01 {
		t.Fatalf("preview became a paid output: count=%d credits=%v", count, credits)
	}
}
