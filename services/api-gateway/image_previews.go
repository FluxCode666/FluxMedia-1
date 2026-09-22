package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

type imagePreviewContextKey struct{}

const imagePreviewMaxEncodedBytes = 24 << 20

func (b *backend) withImagePreviewPublisher(ctx context.Context, taskID, generationID string) context.Context {
	if b.redis == nil {
		return ctx
	}
	return context.WithValue(ctx, imagePreviewContextKey{}, func(item map[string]any) {
		encoded := extractString(item, "partial_image_b64", "b64_json", "imageBase64")
		if encoded == "" || len(encoded) > imagePreviewMaxEncodedBytes {
			return
		}
		if _, err := base64.StdEncoding.DecodeString(encoded); err != nil {
			return
		}
		payload := map[string]any{"b64_json": encoded, "generationId": generationID}
		if value, ok := item["partial_image_index"].(float64); ok && value >= 0 && value < 1000 {
			payload["partial_image_index"] = int(value)
		}
		// Frames are bounded ephemeral progress; they never create output facts or
		// billable generation rows. A Redis outage must not fail the paid generation.
		script := `local id=redis.call('XADD',KEYS[1],'MAXLEN',8,'*','payload',ARGV[1]);redis.call('PEXPIRE',KEYS[1],1800000);return id`
		if err := b.redis.Eval(ctx, script, []string{"fluxmedia:go:image-preview:" + taskID}, mustJSON(payload)).Err(); err != nil {
			b.logger.WarnContext(ctx, "image preview publication failed", "task_id", taskID)
		}
	})
}

func (b *backend) flushImagePreviews(ctx context.Context, w http.ResponseWriter, taskID, operation, lastID string) (string, error) {
	if b.redis == nil {
		return lastID, nil
	}
	start := "-"
	if lastID != "" {
		start = "(" + lastID
	}
	messages, err := b.redis.XRangeN(ctx, "fluxmedia:go:image-preview:"+taskID, start, "+", 8).Result()
	if err != nil {
		return lastID, nil
	}
	event := "image_generation.partial_image"
	if operation != "generate" {
		event = "image_edit.partial_image"
	}
	for _, message := range messages {
		lastID = message.ID
		raw, ok := message.Values["payload"].(string)
		if !ok || len(raw) > imagePreviewMaxEncodedBytes+1024 {
			continue
		}
		var payload map[string]any
		if json.Unmarshal([]byte(raw), &payload) != nil {
			continue
		}
		payload["type"] = event
		payload["index"] = 0
		encoded, err := json.Marshal(payload)
		if err != nil {
			return lastID, err
		}
		if _, err = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, strings.TrimSpace(string(encoded))); err != nil {
			return lastID, err
		}
		if err = http.NewResponseController(w).Flush(); err != nil {
			return lastID, err
		}
	}
	return lastID, nil
}
