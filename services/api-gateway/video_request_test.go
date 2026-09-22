package main

import (
	"encoding/json"
	"net/http/httptest"
	"reflect"
	"testing"
)

func videoTestBody(input map[string]any) map[string]json.RawMessage {
	var body map[string]json.RawMessage
	_ = json.Unmarshal([]byte(mustJSON(input)), &body)
	return body
}

func videoTestInput() map[string]any {
	return map[string]any{"clientRequestId": "video-request", "model": "veo31", "prompt": "a moving subject", "duration": 8, "aspectRatio": "16:9", "resolution": "720p"}
}

func TestNativeVideoImmutableRequestFingerprint(t *testing.T) {
	base, err := parseNativeVideoInput(videoTestBody(videoTestInput()))
	if err != nil {
		t.Fatal(err)
	}
	token := base
	token.QuoteToken = "fresh-quote"
	if token.fingerprint() != base.fingerprint() {
		t.Fatal("quote refresh changed immutable identity")
	}
	for _, change := range []func(*nativeVideoInput){
		func(v *nativeVideoInput) { v.Prompt = "another prompt" },
		func(v *nativeVideoInput) { v.CallbackURL = "https://example.com/callback" },
		func(v *nativeVideoInput) { v.GeminiOperationID = "changedoperation123456" },
	} {
		modified := base
		change(&modified)
		if modified.fingerprint() == base.fingerprint() {
			t.Fatal("changed video request retained fingerprint")
		}
	}
}

func TestNativeVideoAcceptsCompatibleSecondsAndAsyncAliases(t *testing.T) {
	input := videoTestInput()
	input["seconds"] = "8"
	input["async"] = true
	parsed, err := parseNativeVideoInput(videoTestBody(input))
	if err != nil || parsed.Duration != 8 {
		t.Fatalf("compatible request rejected: %+v %v", parsed, err)
	}
	input["seconds"] = "6"
	if _, err := parseNativeVideoInput(videoTestBody(input)); err == nil {
		t.Fatal("conflicting duration aliases accepted")
	}
}

func TestNativeVideoOutputPixelsMatchSharedCatalog(t *testing.T) {
	resolutions := []string{"480p", "720p", "1080p", "2k", "4k", "8k"}
	shorts := []int{480, 720, 1080, 1440, 2160, 4320}
	landscape := [][2]int{{854, 1120}, {1280, 1680}, {1920, 2520}, {2560, 3360}, {3840, 5040}, {7680, 10080}}
	for i, resolution := range resolutions {
		for _, pair := range []struct {
			ratio string
			w, h  int
		}{
			{"1:1", shorts[i], shorts[i]}, {"4:3", shorts[i] * 4 / 3, shorts[i]}, {"3:4", shorts[i], shorts[i] * 4 / 3},
			{"16:9", landscape[i][0], shorts[i]}, {"9:16", shorts[i], landscape[i][0]}, {"21:9", landscape[i][1], shorts[i]},
		} {
			w, h, err := nativeVideoOutputSize(nativeVideoInput{Resolution: resolution, AspectRatio: pair.ratio}, goVideoModelConfig{})
			if err != nil || w != pair.w || h != pair.h {
				t.Fatalf("%s %s: %dx%d %v", resolution, pair.ratio, w, h, err)
			}
		}
	}
}

func TestNativeGeminiStrictConversionAndStableReplay(t *testing.T) {
	r := httptest.NewRequest("POST", "http://localhost/models/veo-3.1-generate-preview:predictLongRunning", nil)
	r.SetPathValue("model", "veo-3.1-generate-preview:predictLongRunning")
	r.Header.Set("Idempotency-Key", "gemini-replay")
	body := videoTestBody(map[string]any{"instances": []any{map[string]any{"prompt": "original prompt", "image": map[string]any{"inlineData": map[string]any{"mimeType": "image/png", "data": "aW1hZ2U="}}}}, "parameters": map[string]any{"durationSeconds": "8"}})
	a, err := parseGeminiNativeVideoRequest(r, "external:u:k", body)
	if err != nil {
		t.Fatal(err)
	}
	b, err := parseGeminiNativeVideoRequest(r, "external:u:k", body)
	if err != nil || !reflect.DeepEqual(a, b) {
		t.Fatal("Gemini retry changed operation identity")
	}
	input, err := parseNativeVideoInput(a)
	if err != nil {
		t.Fatal(err)
	}
	if input.Prompt != "original prompt" || input.Model != "veo31" || input.Duration != 8 || input.FirstFrame["source"] != "data" || !*input.GenerateAudio {
		t.Fatalf("unexpected conversion: %+v", input)
	}
	for _, invalidBody := range []map[string]any{
		{"model": "veo31", "instances": []any{map[string]any{"prompt": "test"}}},
		{"instances": []any{}},
		{"instances": []any{map[string]any{}}},
		{"instances": []any{map[string]any{"prompt": "test", "unknown": true}}},
		{"instances": []any{map[string]any{"prompt": "test", "image": nil}}},
		{"instances": []any{map[string]any{"prompt": "test", "reference_videos": []any{}}}},
		{"instances": []any{map[string]any{"prompt": "test"}}, "parameters": map[string]any{"aspectRatio": ""}},
		{"instances": []any{map[string]any{"prompt": "test"}}, "parameters": map[string]any{"durationSeconds": "08"}},
		{"instances": []any{map[string]any{"prompt": "test"}}, "parameters": map[string]any{"durationSeconds": 5}},
		{"instances": []any{map[string]any{"prompt": "test", "image": map[string]any{"uri": "https://example.com/image.png"}}}},
	} {
		if _, err := parseGeminiNativeVideoRequest(r, "external:u:k", videoTestBody(invalidBody)); err == nil {
			t.Fatalf("accepted invalid Gemini request %v", invalidBody)
		}
	}
	r.Header.Set("X-Request-ID", "different")
	if _, err := parseGeminiNativeVideoRequest(r, "external:u:k", body); err == nil {
		t.Fatal("conflicting request headers accepted")
	}
}

func TestNativeGeminiOperationOutput(t *testing.T) {
	for _, task := range []map[string]any{{"status": "queued"}, {"status": "failed"}, {"status": "completed"}, {"status": "completed", "videoUrl": "https://example.com/video.mp4"}} {
		operation := geminiNativeOperation("veo31", "operation1234567890", task)
		_, response := operation["response"]
		_, failure := operation["error"]
		if operation["name"] != "models/veo31/operations/operation1234567890" {
			t.Fatal(operation)
		}
		if operation["done"] == false && (response || failure) {
			t.Fatal(operation)
		}
		if operation["done"] == true && response == failure {
			t.Fatal(operation)
		}
	}
}

func TestNativeVideoInputSummaryDoesNotExposeStorageIdentity(t *testing.T) {
	for field, mode := range map[string]string{"referenceImages": "references", "referenceVideos": "reference-videos", "referenceAudios": "reference-audio"} {
		got := videoInputSummary(map[string]any{field: []any{map[string]any{"storageKey": "private"}}})
		if len(got) != 2 || got["mode"] != mode || got["count"] != 1 {
			t.Fatal(got)
		}
	}
}
