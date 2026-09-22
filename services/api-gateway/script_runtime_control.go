package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"time"
)

type scriptRuntimeDiagnostics struct {
	Lifecycle              string `json:"lifecycle"`
	WorkerCount            int64  `json:"workerCount"`
	LiveWorkerCount        int64  `json:"liveWorkerCount"`
	RequestQueueLength     int64  `json:"requestQueueLength"`
	ResponseQueueLength    int64  `json:"responseQueueLength"`
	ResponsePermitsInUse   int64  `json:"responsePermitsInUse"`
	ResponsePermitCapacity int64  `json:"responsePermitCapacity"`
	SaturationCount        int64  `json:"saturationCount"`
	ReplacementCount       int64  `json:"replacementCount"`
}

// The runtime is authoritative for deployment capacity and live counters. The
// gateway never fabricates a healthy snapshot from its own process environment.
func (c *scriptRuntimeClient) diagnostics(ctx context.Context) (*scriptRuntimeDiagnostics, error) {
	raw, err := c.control(ctx, http.MethodGet, "/v1/diagnostics")
	if err != nil {
		return nil, err
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return nil, errors.New("script runtime returned invalid diagnostics")
	}
	for _, key := range []string{"lifecycle", "workerCount", "liveWorkerCount", "requestQueueLength", "responseQueueLength", "responsePermitsInUse", "responsePermitCapacity", "saturationCount", "replacementCount"} {
		if len(fields[key]) == 0 || string(fields[key]) == "null" {
			return nil, errors.New("script runtime diagnostics omitted a field")
		}
	}
	var result scriptRuntimeDiagnostics
	if json.Unmarshal(raw, &result) != nil {
		return nil, errors.New("script runtime returned invalid diagnostics")
	}
	switch result.Lifecycle {
	case "starting", "ready", "unavailable", "draining", "closed":
	default:
		return nil, errors.New("script runtime returned invalid lifecycle")
	}
	for _, value := range []int64{result.WorkerCount, result.LiveWorkerCount, result.RequestQueueLength, result.ResponseQueueLength, result.ResponsePermitsInUse, result.ResponsePermitCapacity, result.SaturationCount, result.ReplacementCount} {
		if value < 0 {
			return nil, errors.New("script runtime returned invalid counters")
		}
	}
	if result.WorkerCount > 8 || result.LiveWorkerCount > result.WorkerCount || result.ResponsePermitsInUse > result.ResponsePermitCapacity {
		return nil, errors.New("script runtime returned invalid capacity")
	}
	return &result, nil
}

func (c *scriptRuntimeClient) reserveResponse(ctx context.Context) (string, error) {
	raw, err := c.control(ctx, http.MethodPost, "/v1/response-permits")
	if err != nil {
		return "", err
	}
	var result struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(raw, &result) != nil || !uuidPattern.MatchString(result.ID) {
		return "", &scriptRuntimeUnavailableError{}
	}
	return result.ID, nil
}

func (c *scriptRuntimeClient) releaseResponse(ctx context.Context, id string) error {
	if id == "" {
		return nil
	}
	_, err := c.control(ctx, http.MethodDelete, "/v1/response-permits/"+url.PathEscape(id))
	return err
}

func (c *scriptRuntimeClient) control(ctx context.Context, method, path string) (json.RawMessage, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	response, err := c.client.Do(req)
	if err != nil {
		return nil, &scriptRuntimeUnavailableError{}
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, &scriptRuntimeUnavailableError{retryAfterSeconds: imageProviderRetryAfter(response.Header.Get("Retry-After"), time.Now())}
	}
	if method == http.MethodDelete && response.StatusCode == http.StatusNoContent {
		return nil, nil
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 8193))
	if err != nil || len(raw) > 8192 {
		return nil, &scriptRuntimeUnavailableError{}
	}
	var payload struct {
		Data json.RawMessage `json:"data"`
	}
	if json.Unmarshal(raw, &payload) != nil || len(payload.Data) == 0 || string(payload.Data) == "null" {
		return nil, &scriptRuntimeUnavailableError{}
	}
	return payload.Data, nil
}
