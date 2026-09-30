package main

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"
)

func seedanceTestRequest(idempotencyKey string) *http.Request {
	r := httptest.NewRequest("POST", "http://localhost/api/v3/contents/generations/tasks", nil)
	if idempotencyKey != "" {
		r.Header.Set("Idempotency-Key", idempotencyKey)
	}
	return r
}

func seedanceTestBody(extra map[string]any, content ...any) map[string]json.RawMessage {
	body := map[string]any{"model": "doubao-seedance-2-0-260128", "content": content}
	for key, value := range extra {
		body[key] = value
	}
	return videoTestBody(body)
}

func seedanceText(text string) map[string]any { return map[string]any{"type": "text", "text": text} }

func seedanceMedia(kind, url, role string) map[string]any {
	item := map[string]any{"type": kind, kind: map[string]any{"url": url}}
	if role != "" {
		item["role"] = role
	}
	return item
}

func seedanceErrorCode(t *testing.T, err error) string {
	t.Helper()
	var known *apiError
	if !errors.As(err, &known) {
		t.Fatalf("expected apiError, got %v", err)
	}
	return known.code
}

func TestSeedanceTextToVideoDefaultsAndStableReplay(t *testing.T) {
	r := seedanceTestRequest("seedance-replay")
	body := seedanceTestBody(map[string]any{"callback_url": "https://example.com/hook", "safety_identifier": "user-1"}, seedanceText("a cat running"))
	a, err := parseSeedanceNativeVideoRequest(r, body)
	if err != nil {
		t.Fatal(err)
	}
	b, err := parseSeedanceNativeVideoRequest(r, body)
	if err != nil || !reflect.DeepEqual(a, b) {
		t.Fatal("Seedance retry changed task identity")
	}
	input, err := parseNativeVideoInput(a)
	if err != nil {
		t.Fatal(err)
	}
	if input.ClientRequestID != "seedance-replay" || input.Model != "seedance2" || input.SeedanceModel != "doubao-seedance-2-0-260128" || input.Prompt != "a cat running" || input.Duration != 5 || input.AspectRatio != "16:9" || input.Resolution != "720p" || !*input.GenerateAudio || input.CallbackURL != "https://example.com/hook" {
		t.Fatalf("unexpected defaults: %+v", input)
	}
	withoutAudio, err := parseSeedanceNativeVideoRequest(r, seedanceTestBody(map[string]any{"generate_audio": false, "ratio": "9:16", "resolution": "1080p", "duration": 10}, seedanceText("a cat")))
	if err != nil {
		t.Fatal(err)
	}
	input, err = parseNativeVideoInput(withoutAudio)
	if err != nil {
		t.Fatal(err)
	}
	if *input.GenerateAudio || input.AspectRatio != "9:16" || input.Resolution != "1080p" || input.Duration != 10 {
		t.Fatalf("explicit parameters ignored: %+v", input)
	}
}

func TestSeedanceModelMapping(t *testing.T) {
	r := seedanceTestRequest("seedance-models")
	for model, platform := range map[string]string{
		"doubao-seedance-2-0-260128":        "seedance2",
		"dreamina-seedance-2-0-260128":      "seedance2",
		"doubao-seedance-2-0-fast-260128":   "seedance2-fast",
		"dreamina-seedance-2-0-fast-260128": "seedance2-fast",
		"seedance2-fast":                    "seedance2-fast",
	} {
		body, err := parseSeedanceNativeVideoRequest(r, videoTestBody(map[string]any{"model": model, "content": []any{seedanceText("test")}}))
		if err != nil {
			t.Fatal(model, err)
		}
		if rawString(body, "model") != platform || rawString(body, "seedanceModel") != model {
			t.Fatalf("model %s mapped to %s", model, rawString(body, "model"))
		}
	}
}

func TestSeedanceContentRoles(t *testing.T) {
	r := seedanceTestRequest("seedance-roles")
	image := "data:image/png;base64,aW1hZ2U="
	parse := func(content ...any) nativeVideoInput {
		t.Helper()
		body, err := parseSeedanceNativeVideoRequest(r, seedanceTestBody(nil, content...))
		if err != nil {
			t.Fatal(err)
		}
		input, err := parseNativeVideoInput(body)
		if err != nil {
			t.Fatal(err)
		}
		return input
	}
	input := parse(seedanceText("single"), seedanceMedia("image_url", image, ""))
	if input.FirstFrame["source"] != "data" || input.FirstFrame["mimeType"] != "image/png" || input.LastFrame != nil {
		t.Fatalf("roleless single image must become first frame: %+v", input)
	}
	input = parse(seedanceText("frames"), seedanceMedia("image_url", image, "first_frame"), seedanceMedia("image_url", "https://8.8.8.8/last.JPG?x=1", "last_frame"))
	if input.FirstFrame == nil || input.LastFrame["source"] != "remote" || input.LastFrame["mimeType"] != "image/jpeg" {
		t.Fatalf("frame roles not mapped: %+v", input)
	}
	input = parse(seedanceText("refs"), seedanceMedia("image_url", image, "reference_image"), seedanceMedia("video_url", "https://8.8.8.8/clip.mp4", "reference_video"), seedanceMedia("audio_url", "data:audio/mp3;base64,YXVkaW8=", "reference_audio"))
	if len(input.ReferenceImages) != 1 || len(input.ReferenceVideos) != 1 || len(input.ReferenceAudios) != 1 || input.FirstFrame != nil {
		t.Fatalf("reference roles not mapped: %+v", input)
	}
	if input.ReferenceVideos[0]["mimeType"] != "video/mp4" || input.ReferenceAudios[0]["mimeType"] != "audio/mpeg" {
		t.Fatalf("reference media types not normalized: %+v", input)
	}
	for name, content := range map[string][]any{
		"missing text":             {seedanceMedia("image_url", image, "")},
		"two texts":                {seedanceText("a"), seedanceText("b")},
		"empty text":               {seedanceText("   ")},
		"roleless with video":      {seedanceText("a"), seedanceMedia("image_url", image, ""), seedanceMedia("video_url", "https://8.8.8.8/clip.mp4", "reference_video")},
		"two roleless images":      {seedanceText("a"), seedanceMedia("image_url", image, ""), seedanceMedia("image_url", image, "")},
		"last frame only":          {seedanceText("a"), seedanceMedia("image_url", image, "last_frame")},
		"two first frames":         {seedanceText("a"), seedanceMedia("image_url", image, "first_frame"), seedanceMedia("image_url", image, "first_frame")},
		"frame with reference":     {seedanceText("a"), seedanceMedia("image_url", image, "first_frame"), seedanceMedia("image_url", image, "reference_image")},
		"audio only":               {seedanceText("a"), seedanceMedia("audio_url", "data:audio/wav;base64,YXVkaW8=", "reference_audio")},
		"bad image role":           {seedanceText("a"), seedanceMedia("image_url", image, "reference_video")},
		"bad video role":           {seedanceText("a"), seedanceMedia("video_url", "https://8.8.8.8/clip.mp4", "first_frame")},
		"asset id":                 {seedanceText("a"), seedanceMedia("image_url", "asset://asset-123", "")},
		"private url":              {seedanceText("a"), seedanceMedia("image_url", "http://127.0.0.1/a.png", "")},
		"unknown extension":        {seedanceText("a"), seedanceMedia("image_url", "https://8.8.8.8/image", "")},
		"video data as image":      {seedanceText("a"), seedanceMedia("image_url", "data:video/mp4;base64,dmlkZW8=", "")},
		"invalid base64":           {seedanceText("a"), seedanceMedia("image_url", "data:image/png;base64,***", "")},
		"draft task":               {seedanceText("a"), map[string]any{"type": "draft_task", "draft_task": map[string]any{"id": "cgt-1"}}},
		"unknown type":             {seedanceText("a"), map[string]any{"type": "file_url"}},
		"mismatched fields":        {map[string]any{"type": "text", "text": "a", "image_url": map[string]any{"url": image}}},
		"role on text":             {map[string]any{"type": "text", "text": "a", "role": "first_frame"}},
		"unknown content property": {map[string]any{"type": "text", "text": "a", "extra": true}},
	} {
		if _, err := parseSeedanceNativeVideoRequest(r, seedanceTestBody(nil, content...)); err == nil {
			t.Fatalf("accepted invalid content %q", name)
		}
	}
}

func TestSeedanceRejectsUnsupportedParameters(t *testing.T) {
	r := seedanceTestRequest("seedance-unsupported")
	accepted := map[string]any{"watermark": false, "seed": -1, "camera_fixed": false, "return_last_frame": false, "draft": false, "service_tier": "default", "output_format": "mp4", "omni_reference_task_type": "auto", "priority": 0, "frames": nil, "tools": nil}
	if _, err := parseSeedanceNativeVideoRequest(r, seedanceTestBody(accepted, seedanceText("defaults"))); err != nil {
		t.Fatalf("default values rejected: %v", err)
	}
	for field, value := range map[string]any{
		"watermark": true, "seed": 42, "camera_fixed": true, "return_last_frame": true, "draft": true,
		"service_tier": "flex", "output_format": "mov", "omni_reference_task_type": "multi_ref", "priority": 5,
		"frames": 121, "execution_expires_after": 3600, "tools": []any{map[string]any{"type": "web_search"}},
		"ratio": "adaptive", "duration": -1, "unknown_field": true,
	} {
		_, err := parseSeedanceNativeVideoRequest(r, seedanceTestBody(map[string]any{field: value}, seedanceText("test")))
		if err == nil {
			t.Fatalf("accepted unsupported %s", field)
		}
		if code := seedanceErrorCode(t, err); code != "InvalidParameter.UnsupportedParameter" {
			t.Fatalf("%s returned %s", field, code)
		}
	}
	for name, extra := range map[string]map[string]any{
		"missing model":    {"model": ""},
		"invalid model":    {"model": "Bad Model"},
		"long safety id":   {"safety_identifier": "12345678901234567890123456789012345678901234567890123456789012345"},
		"zero duration":    {"duration": 0},
		"invalid ratio":    {"ratio": "2:1"},
		"invalid callback": {"callback_url": "ftp://example.com/hook"},
		"string duration":  {"duration": "5"},
	} {
		if _, err := parseSeedanceNativeVideoRequest(r, seedanceTestBody(extra, seedanceText("test"))); err == nil {
			t.Fatalf("accepted invalid request %q", name)
		}
	}
	if _, err := parseSeedanceNativeVideoRequest(r, videoTestBody(map[string]any{"model": "doubao-seedance-2-0-260128"})); err == nil || seedanceErrorCode(t, err) != "MissingParameter" {
		t.Fatalf("missing content returned %v", err)
	}
}

func TestSeedancePromptFlags(t *testing.T) {
	r := seedanceTestRequest("seedance-flags")
	body, err := parseSeedanceNativeVideoRequest(r, seedanceTestBody(nil, seedanceText("a dog on the beach --rs 1080p --rt 9:16 --dur 8 --seed -1 --wm false --cf false")))
	if err != nil {
		t.Fatal(err)
	}
	input, err := parseNativeVideoInput(body)
	if err != nil {
		t.Fatal(err)
	}
	if input.Prompt != "a dog on the beach" || input.Resolution != "1080p" || input.AspectRatio != "9:16" || input.Duration != 8 {
		t.Fatalf("prompt parameters not applied: %+v", input)
	}
	body, err = parseSeedanceNativeVideoRequest(r, seedanceTestBody(map[string]any{"duration": 8}, seedanceText("same value --duration 8")))
	if err != nil {
		t.Fatal(err)
	}
	if rawString(body, "prompt") != "same value" {
		t.Fatalf("matching prompt parameter not stripped: %s", body["prompt"])
	}
	for name, test := range map[string]struct {
		extra map[string]any
		text  string
	}{
		"body conflict":      {map[string]any{"duration": 5}, "a --dur 8"},
		"duplicate conflict": {nil, "a --dur 5 --dur 8"},
		"embedded flag":      {nil, "a --dur 8 more text"},
		"flag after unknown": {nil, "a --rs 1080p --style anime"},
		"invalid bool":       {nil, "a --wm yes"},
		"watermark":          {nil, "a --wm true"},
		"seed":               {nil, "a --seed 7"},
		"frames":             {nil, "a --frames 121"},
		"invalid duration":   {nil, "a --dur five"},
		"only flags":         {nil, "--dur 5"},
		"dangling flag":      {nil, "a --rs"},
	} {
		if _, err := parseSeedanceNativeVideoRequest(r, seedanceTestBody(test.extra, seedanceText(test.text))); err == nil {
			t.Fatalf("accepted prompt parameters %q", name)
		}
	}
	body, err = parseSeedanceNativeVideoRequest(r, seedanceTestBody(nil, seedanceText("anime style --style anime")))
	if err != nil {
		t.Fatal(err)
	}
	if rawString(body, "prompt") != "anime style --style anime" {
		t.Fatalf("unknown trailing option must remain in the prompt: %s", body["prompt"])
	}
}

func TestExternalVideoIdempotencyKey(t *testing.T) {
	var got []string
	var errs []error
	handler := withRequestID(slog.New(slog.NewTextHandler(io.Discard, nil)), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key, err := externalVideoIdempotencyKey(r)
		got = append(got, key)
		errs = append(errs, err)
	}))
	for _, headers := range []map[string]string{
		{"Idempotency-Key": "only-idempotency"},
		{"X-Request-ID": "only-request"},
		{"Idempotency-Key": "same", "X-Request-ID": "same"},
		{"Idempotency-Key": "left", "X-Request-ID": "right"},
		{"Idempotency-Key": "valid-key", "X-Request-ID": "invalid request id"},
		{},
	} {
		r := httptest.NewRequest("POST", "http://localhost/api/v3/contents/generations/tasks", nil)
		for name, value := range headers {
			r.Header.Set(name, value)
		}
		handler.ServeHTTP(httptest.NewRecorder(), r)
	}
	if got[0] != "only-idempotency" || errs[0] != nil {
		t.Fatalf("Idempotency-Key alone rejected: %q %v", got[0], errs[0])
	}
	if got[1] != "only-request" || errs[1] != nil {
		t.Fatalf("client request ID ignored: %q %v", got[1], errs[1])
	}
	if got[2] != "same" || errs[2] != nil {
		t.Fatalf("matching headers rejected: %q %v", got[2], errs[2])
	}
	if errs[3] == nil {
		t.Fatal("conflicting headers accepted")
	}
	if got[4] != "valid-key" || errs[4] != nil {
		t.Fatalf("gateway-generated request ID must not conflict: %q %v", got[4], errs[4])
	}
	if got[5] == "" || errs[5] != nil {
		t.Fatalf("missing headers must generate a key: %q %v", got[5], errs[5])
	}
}

func TestSeedanceTaskViewObject(t *testing.T) {
	created := time.Unix(1_700_000_000, 0)
	updated := created.Add(90 * time.Second)
	view := seedanceTaskView{ID: "video_1", Model: "doubao-seedance-2-0-260128", Ratio: "16:9", Resolution: "720p", Duration: 5, GenerateAudio: true, CreatedAt: created, UpdatedAt: updated}
	for status, want := range map[string]string{"queued": "queued", "in_progress": "running", "completed": "succeeded", "failed": "failed"} {
		view.Status = status
		if got := view.object()["status"]; got != want {
			t.Fatalf("%s mapped to %v", status, got)
		}
	}
	view.Status, view.VideoURL = "completed", "https://example.com/video.mp4"
	object := view.object()
	if object["error"] != nil || !reflect.DeepEqual(object["content"], map[string]any{"video_url": "https://example.com/video.mp4"}) || object["created_at"] != int64(1_700_000_000) || object["updated_at"] != int64(1_700_000_090) || object["service_tier"] != "default" || object["generate_audio"] != true {
		t.Fatalf("unexpected succeeded object: %v", object)
	}
	view.Status, view.VideoURL = "in_progress", ""
	if _, exists := view.object()["content"]; exists {
		t.Fatal("running task exposes content")
	}
	view.Status = "failed"
	failure, _ := view.object()["error"].(map[string]any)
	if failure["code"] != "VideoGenerationFailed" || failure["message"] != "Video generation failed" {
		t.Fatalf("unexpected failure: %v", failure)
	}
	view.Error = "upstream rejected the prompt"
	failure, _ = view.object()["error"].(map[string]any)
	if failure["message"] != "upstream rejected the prompt" {
		t.Fatalf("failure message dropped: %v", failure)
	}
}

func TestSeedanceErrorBody(t *testing.T) {
	for _, test := range []struct {
		err        *apiError
		code, kind string
	}{
		{&apiError{400, "MissingParameter", "model is required"}, "MissingParameter", "BadRequest"},
		{&apiError{400, "InvalidParameter.UnsupportedParameter", "x"}, "InvalidParameter.UnsupportedParameter", "BadRequest"},
		{&apiError{400, "INVALID_REQUEST", "x"}, "InvalidParameter", "BadRequest"},
		{&apiError{401, "invalid_api_key", "x"}, "AuthenticationError", "Unauthorized"},
		{&apiError{403, "FORBIDDEN", "x"}, "AccessDenied", "Forbidden"},
		{&apiError{404, "NOT_FOUND", "x"}, "NotFound", "NotFound"},
		{&apiError{409, "IDEMPOTENCY_CONFLICT", "x"}, "IDEMPOTENCY_CONFLICT", "Conflict"},
		{&apiError{500, "INTERNAL", "x"}, "InternalServiceError", "InternalServerError"},
	} {
		body, _ := seedanceErrorBody(test.err)["error"].(map[string]any)
		if body["code"] != test.code || body["type"] != test.kind || body["message"] != test.err.message {
			t.Fatalf("%+v rendered as %v", test.err, body)
		}
	}
}
