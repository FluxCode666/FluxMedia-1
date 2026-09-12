package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type scriptRuntimeClient struct {
	baseURL string
	token   string
	client  *http.Client
}

type scriptRuntimeRequest struct {
	Script    string `json:"script"`
	Operation string `json:"operation"`
	Stage     string `json:"stage"`
	Input     any    `json:"input"`
	Context   any    `json:"context"`
}

type scriptRuntimeResponse struct {
	Data *struct {
		Output json.RawMessage `json:"output"`
	} `json:"data"`
	Error *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func newScriptRuntimeClient(baseURL, token string) *scriptRuntimeClient {
	if strings.TrimSpace(baseURL) == "" {
		return nil
	}
	return &scriptRuntimeClient{baseURL: strings.TrimRight(baseURL, "/"), token: token, client: &http.Client{Timeout: 2 * time.Second}}
}

func (c *scriptRuntimeClient) execute(ctx context.Context, request scriptRuntimeRequest) (json.RawMessage, error) {
	body, err := json.Marshal(request)
	if err != nil {
		return nil, fmt.Errorf("encode script runtime request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/v1/execute", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("script runtime unavailable: %w", err)
	}
	defer resp.Body.Close()
	var payload scriptRuntimeResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&payload); err != nil {
		return nil, errors.New("script runtime returned invalid JSON")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if payload.Error != nil && payload.Error.Message != "" {
			return nil, fmt.Errorf("script runtime %s: %s", payload.Error.Code, payload.Error.Message)
		}
		return nil, fmt.Errorf("script runtime returned HTTP %d", resp.StatusCode)
	}
	if payload.Data == nil || len(payload.Data.Output) == 0 {
		return nil, errors.New("script runtime response omitted output")
	}
	return payload.Data.Output, nil
}

func (c *scriptRuntimeClient) ready(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/healthz", nil)
	if err != nil {
		return err
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("script runtime returned HTTP %d", resp.StatusCode)
	}
	return nil
}
