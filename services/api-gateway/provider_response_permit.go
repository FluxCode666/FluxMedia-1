package main

import (
	"context"
	"strings"
	"time"
)

type providerResponsePermitContextKey struct{}
type imageBeforeSendContextKey struct{}

// Reserve response adaptation capacity before a billable provider request.
// Keep the permit inside the platform transport, never in provider headers,
// script input/context, persisted task metadata, or public responses.
func (b *backend) reserveProviderResponse(ctx context.Context, cfg providerConfig, operation string) (context.Context, func(), error) {
	op, _ := cfg.operations[operation].(map[string]any)
	mode := extractString(cfg.adapter, "videoProtocolMode")
	if strings.TrimSpace(extractString(op, "responseScript")) == "" ||
		(strings.HasPrefix(operation, "videos.") && (mode == "gemini" || mode == "seedance")) {
		return ctx, func() {}, nil
	}
	client := newScriptRuntimeClient(b.config.scriptRuntimeURL, b.config.scriptRuntimeToken)
	if client == nil {
		return ctx, nil, &scriptRuntimeUnavailableError{}
	}
	id, err := client.reserveResponse(ctx)
	if err != nil {
		return ctx, nil, err
	}
	release := func() {
		// Cancellation of the upstream request must not cancel permit cleanup.
		cleanup, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = client.releaseResponse(cleanup, id)
	}
	return context.WithValue(ctx, providerResponsePermitContextKey{}, id), release, nil
}

func providerResponsePermitID(ctx context.Context) string {
	id, _ := ctx.Value(providerResponsePermitContextKey{}).(string)
	return id
}
