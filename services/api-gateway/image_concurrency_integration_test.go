//go:build integration

package main

import (
	"context"
	"errors"
	"net/http/httptest"
	"sync"
	"testing"
)

func TestImageConcurrencyAdmissionAndGlobalClaimAreAtomic(t *testing.T) {
	b := integrationBackend(t)
	ctx := context.Background()
	uid, _ := seedAuthUser(t, b)
	model := "concurrency-" + newRequestID()
	seedImagePricingSettings(t, b, model)
	setStorageTestSetting(t, b, "CONTENT_MODERATION_ENABLED", false)
	setStorageTestSetting(t, b, "IMAGE_GENERATION_DEFAULT_USER_CONCURRENCY", 2)
	setStorageTestSetting(t, b, "IMAGE_GENERATION_GLOBAL_CONCURRENCY", 1)
	group := seedImagePricingGroup(t, b, true, nil, nil)
	seedImagePricingMember(t, b, group, model, "http://127.0.0.1:1", false, 1)
	creditTestWallet(t, b, uid, 100)
	creditTestBatch(t, b, uid, "purchase", 100, nil)
	var wg sync.WaitGroup
	results := make(chan error, 6)
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := b.createImageTask(httptest.NewRequest("POST", "http://localhost/api/images/generate", nil), &apiPrincipal{UserID: uid}, imagePricingInput(map[string]any{"model": model, "prompt": "test", "backendGroupId": group}), "generate")
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	accepted, blocked := 0, 0
	for err := range results {
		if err == nil {
			accepted++
			continue
		}
		var e *apiError
		if errors.As(err, &e) && e.status == 429 {
			blocked++
		} else {
			t.Fatal(err)
		}
	}
	if accepted != 2 || blocked != 4 {
		t.Fatalf("admission accepted=%d blocked=%d", accepted, blocked)
	}
	worker := &mediaWorker{backend: b}
	claims := make(chan string, 5)
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			id, err := worker.claimImageTask(ctx, "")
			if err != nil {
				t.Error(err)
			}
			claims <- id
		}()
	}
	wg.Wait()
	close(claims)
	claimed := ""
	n := 0
	for id := range claims {
		if id != "" {
			claimed = id
			n++
		}
	}
	if n != 1 {
		t.Fatalf("global concurrency reserved %d slots", n)
	}
	// Polling releases global capacity while the user still holds admission.
	if _, err := b.db.Exec(ctx, `UPDATE image_async_task SET claim_token=NULL,claim_expires_at=NULL,mq_delivery_due_at=now()+interval '1 minute' WHERE id=$1`, claimed); err != nil {
		t.Fatal(err)
	}
	next, err := worker.claimImageTask(ctx, "")
	if err != nil || next == "" || next == claimed {
		t.Fatalf("poll wait occupied global slot: %q %v", next, err)
	}
	if _, err := b.db.Exec(ctx, `UPDATE generation SET status='failed' WHERE id=(SELECT generation_id FROM image_async_task WHERE id=$1)`, claimed); err != nil {
		t.Fatal(err)
	}
	_, err = b.createImageTask(httptest.NewRequest("POST", "http://localhost/api/images/generate", nil), &apiPrincipal{UserID: uid}, imagePricingInput(map[string]any{"model": model, "prompt": "released", "backendGroupId": group}), "generate")
	if err != nil {
		t.Fatalf("settlement did not release admission: %v", err)
	}
}
