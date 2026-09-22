package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestImageProcessingDuplexRuntimeAndCancellation(t *testing.T) {
	image := []byte("runtime output")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := http.NewResponseController(w).EnableFullDuplex(); err != nil {
			t.Error(err)
			return
		}
		var input imageProcessingRequest
		decoder := json.NewDecoder(r.Body)
		if err := decoder.Decode(&input); err != nil {
			t.Error(err)
			return
		}
		if input.Repair != "whole" || input.RequestedSize != "1024x1024" {
			t.Error("Go options missing")
		}
		w.Header().Set("Content-Type", "application/x-ndjson")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		encoder := json.NewEncoder(w)
		_ = encoder.Encode(map[string]any{"type": "edit", "index": 0, "width": 1024, "height": 1024, "prompt": "restore", "imageBase64": input.ImageBase64})
		w.(http.Flusher).Flush()
		var reply map[string]any
		if err := decoder.Decode(&reply); err != nil {
			t.Error(err)
			return
		}
		if reply["type"] != "editResult" || reply["imageBase64"] != base64.StdEncoding.EncodeToString(image) {
			t.Error("repair callback was not delivered")
		}
		_ = encoder.Encode(map[string]any{"type": "result", "imageBase64": reply["imageBase64"]})
		w.(http.Flusher).Flush()
	}))
	defer server.Close()
	t.Setenv("GO_MEDIA_PROCESSING_URL", server.URL)
	b := &backend{}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	calls := 0
	result, err := b.processImageWithRuntime(ctx, imageProcessingRequest{ImageBase64: base64.StdEncoding.EncodeToString(image), RequestedSize: "1024x1024", Repair: "whole"}, func(message imageProcessingMessage) ([]byte, error) { calls++; return image, nil })
	if err != nil || !bytes.Equal(result, image) || calls != 1 {
		t.Fatalf("duplex processing failed: %q %d %v", result, calls, err)
	}
	cancelled, stop := context.WithCancel(context.Background())
	stop()
	if _, err = b.processImageWithRuntime(cancelled, imageProcessingRequest{}, nil); err == nil {
		t.Fatal("cancelled processing was attempted")
	}
}

func TestImageProcessingRejectsUnexpectedPaidEdits(t *testing.T) {
	for _, message := range []map[string]any{{"type": "edit", "index": 16, "width": 1024, "height": 1024}, {"type": "edit", "index": 0, "width": 5000, "height": 1024}, {"type": "error"}, {"type": "result", "imageBase64": ""}} {
		var replies bytes.Buffer
		called := false
		_, err := consumeImageProcessingStream(context.Background(), bytes.NewBufferString(mustJSON(message)), json.NewEncoder(&replies), func(imageProcessingMessage) ([]byte, error) { called = true; return nil, nil })
		if err == nil || called {
			t.Fatalf("invalid runtime request caused edit: %v", message)
		}
	}
}

func TestImagePostprocessingMultipartFlagsNormalizeBeforeFingerprint(t *testing.T) {
	fields := map[string]json.RawMessage{"model": json.RawMessage(`"gpt-image-2"`), "prompt": json.RawMessage(`"test"`), "generationId": json.RawMessage(`"postprocess-flags"`), "hd_repair": json.RawMessage(`"true"`), "transparent_matte": json.RawMessage(`"true"`), "block_repair": json.RawMessage(`"false"`), "repair_prompt": json.RawMessage(`"keep composition"`)}
	normalized, first, err := normalizeImageTaskInput(fields, "edit")
	if err != nil {
		t.Fatal(err)
	}
	if string(normalized["hdRepair"]) != "true" || string(normalized["transparentMatte"]) != "true" || string(normalized["blockRepair"]) != "false" || normalized["repairPrompt"] == nil {
		t.Fatalf("multipart repair flags lost: %v", normalized)
	}
	_, second, err := normalizeImageTaskInput(normalized, "edit")
	if err != nil || first != second {
		t.Fatal("normalized flag aliases changed replay identity")
	}
	normalized["hd_repair"] = json.RawMessage(`false`)
	if _, _, err = normalizeImageTaskInput(normalized, "edit"); err == nil {
		t.Fatal("conflicting repair aliases accepted")
	}
}
