package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// deliverImageAsyncCallback emits the same public task envelope used by the
// external API. Callback delivery is best effort: task/generation state remains
// authoritative and a callback failure never reopens a settled generation.
func (b *backend) deliverImageAsyncCallback(ctx context.Context, taskID string) error {
	var callback, operation, userID, keyID string
	err := b.db.QueryRow(ctx, `SELECT COALESCE(callback_url,''),operation,user_id,api_key_id FROM image_async_task WHERE id=$1`, taskID).Scan(&callback, &operation, &userID, &keyID)
	if err != nil || strings.TrimSpace(callback) == "" {
		return err
	}
	payload, err := b.publicImageTask(ctx, &apiPrincipal{UserID: userID, KeyID: keyID}, taskID)
	if err != nil {
		return err
	}
	payload["operation"] = operation
	body, _ := json.Marshal(payload)
	parsed, parseErr := url.Parse(callback)
	if parseErr != nil || !strings.EqualFold(parsed.Scheme, "https") {
		return fmt.Errorf("image callback URL must use HTTPS")
	}
	reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, callback, strings.NewReader(string(body)))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Tokens-Callback", "true")
	if err := validatePublicMediaURL(callback); err != nil {
		return err
	}
	transport := publicMediaTransport()
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 10 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("image callback returned HTTP %d", resp.StatusCode)
	}
	return nil
}

func imageStringValue(value *string, fallback string) string {
	if value != nil && strings.TrimSpace(*value) != "" {
		return *value
	}
	return fallback
}
