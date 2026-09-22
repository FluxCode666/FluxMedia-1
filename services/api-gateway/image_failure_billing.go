package main

import (
	"errors"
	"math"
)

// Failure charges use the persisted quote and actual moderation outcome, never
// current price settings. An unavailable moderation service earns no charge.
func imageFailureRetainedCredits(cause error, charged float64, metadata map[string]any) float64 {
	var failure *apiError
	code := ""
	if errors.As(cause, &failure) {
		code = failure.code
	}
	if code == "CONTENT_MODERATION_UNAVAILABLE" {
		return 0
	}
	snapshot, _ := metadata["billingSnapshot"].(map[string]any)
	cost, _ := metadata["creditCost"].(map[string]any)
	moderation, _ := metadata["moderation"].(map[string]any)
	value := float64(0)
	if code == "CONTENT_MODERATION_BLOCKED" {
		value = imageCreditValue(snapshot["moderationFailureCredits"], imageCreditValue(metadata["moderationFailureCredits"], charged))
	} else if completed, _ := moderation["completed"].(bool); completed {
		value = imageCreditValue(snapshot["moderationOnlyCredits"], imageCreditValue(cost["moderationOnlyCredits"], imageCreditValue(cost["moderationCredits"], 0)))
	}
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	return creditRound(math.Min(math.Max(0, charged), math.Max(0, value)))
}
