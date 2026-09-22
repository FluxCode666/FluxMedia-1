package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type imageBillingQuote struct {
	Amount   float64
	Snapshot map[string]any
}

// The authorized group, model prices and moderation fees are fixed before
// charging. Neither caller-supplied price fields nor later settings changes
// participate in retry or failure settlement.
func (b *backend) resolveImageBillingQuote(ctx context.Context, p *apiPrincipal, model, resolution, operation string, input map[string]json.RawMessage) (imageBillingQuote, error) {
	group, err := b.resolveImageGroup(ctx, p, rawString(input, "backendGroupId", "backend_group_id"))
	if err != nil {
		return imageBillingQuote{}, err
	}
	global, err := b.setting(ctx, "IMAGE_MODEL_CREDIT_PRICES", nil)
	if err != nil {
		return imageBillingQuote{}, err
	}
	prices, err := resolveImagePrices(model, global, group.ImageCreditOverrides)
	if err != nil {
		return imageBillingQuote{}, err
	}
	globalModeration, err := b.settingBool(ctx, "CONTENT_MODERATION_ENABLED", true)
	if err != nil {
		return imageBillingQuote{}, err
	}
	cfg, err := b.imageProviderForInput(ctx, model, group, globalModeration && (group.ContentSafetyEnabled == nil || *group.ContentSafetyEnabled), input)
	if err != nil {
		return imageBillingQuote{}, err
	}
	moderationEnabled := globalModeration && cfg.contentSafetyEnabled
	textValue, err := b.setting(ctx, "IMAGE_TEXT_MODERATION_CREDITS", 0.04)
	if err != nil {
		return imageBillingQuote{}, err
	}
	imageValue, err := b.setting(ctx, "IMAGE_INPUT_MODERATION_CREDITS", 0.06)
	if err != nil {
		return imageBillingQuote{}, err
	}
	textPrice, imagePrice := imageModerationPrice(textValue, 0.04), imageModerationPrice(imageValue, 0.06)
	refs := 0
	if raw, ok := input["images"]; ok {
		var values []json.RawMessage
		if json.Unmarshal(raw, &values) == nil {
			refs = len(values)
		}
	}
	// A mask selects pixels; it is not an additional user reference image.
	// The moderation request still inspects it, but the legacy billing contract
	// charges only reference images plus the prompt.
	key := imageBillingPriceKey(resolution, rawString(input, "size"), prices)
	baseAmount := prices[key]
	textFee, imageFee := 0.0, 0.0
	if moderationEnabled {
		textFee = textPrice
		imageFee = float64(refs) * imagePrice
	}
	moderationOnly := roundUpImageCredits(textFee + imageFee)
	amount := roundUpImageCredits(baseAmount + textFee + imageFee)
	failureCredits := 0.0
	if moderationEnabled {
		failureCredits = amount
	}
	return imageBillingQuote{Amount: amount, Snapshot: map[string]any{
		"version": 2, "model": model, "resolution": resolution, "amount": amount, "baseAmount": baseAmount,
		"textModerationCredits": textFee, "imageInputModerationCredits": imageFee, "referenceCount": refs,
		"priceKey": key, "basePricing": prices, "moderationEnabled": moderationEnabled,
		"moderationOnlyCredits": moderationOnly, "moderationFailureCredits": failureCredits,
		"group": group, "providerMemberId": cfg.memberID,
	}}, nil
}

func imageCreditValue(value any, fallback float64) float64 {
	switch n := value.(type) {
	case float64:
		return n
	case int:
		return float64(n)
	case json.Number:
		if parsed, err := n.Float64(); err == nil {
			return parsed
		}
	case string:
		var parsed float64
		if _, err := fmt.Sscan(n, &parsed); err == nil {
			return parsed
		}
	}
	return fallback
}

// chargeImageGenerationTx atomically reserves wallet credits for a newly
// inserted generation. It is idempotent on generation id/source_ref and must
// be called in the same transaction as generation/task creation.
func (b *backend) chargeImageGenerationTx(ctx context.Context, tx pgx.Tx, userID, generationID, apiKeyID string, quote imageBillingQuote, metadata map[string]any) error {
	r := (&http.Request{}).WithContext(ctx)
	wallet, err := b.lockCreditWallet(r, tx, userID)
	if err != nil {
		return err
	}
	var createdAt time.Time
	if err = tx.QueryRow(ctx, `SELECT created_at FROM generation WHERE id=$1 AND user_id=$2`, generationID, userID).Scan(&createdAt); err != nil {
		return err
	}
	result, err := b.consumeCreditTx(r, tx, wallet, creditMutation{UserID: userID, Amount: quote.Amount, ServiceName: "image_generation", SourceRef: generationID, Reason: "图片生成扣费", OperationType: "image_generation", OperationID: generationID, OperationCreatedAt: &createdAt, Metadata: map[string]any{"generationId": generationID, "billingSnapshot": quote.Snapshot, "metadata": metadata}})
	if err != nil {
		return err
	}
	if result.Replayed {
		return nil
	}
	if strings.TrimSpace(apiKeyID) != "" {
		tag, err := tx.Exec(ctx, `UPDATE external_api_key SET credits_used=credits_used+$3,last_used_at=now(),updated_at=now() WHERE id=$1 AND user_id=$2 AND is_active AND (credit_limit IS NULL OR credits_used+$3<=credit_limit)`, apiKeyID, userID, quote.Amount)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return &apiError{402, "API_KEY_CREDIT_LIMIT", "API key credit limit exceeded"}
		}
	}
	return nil
}
