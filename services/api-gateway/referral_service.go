package main

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type referralProfileResult struct {
	UserID    string    `json:"userId"`
	Code      string    `json:"code"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type referralFulfillmentResult struct {
	Rewarded             bool    `json:"rewarded"`
	Reason               string  `json:"reason,omitempty"`
	InviterRewardCredits float64 `json:"inviterRewardCredits,omitempty"`
	InviteeRewardCredits float64 `json:"inviteeRewardCredits,omitempty"`
}

func (result referralFulfillmentResult) MarshalJSON() ([]byte, error) {
	if !result.Rewarded {
		return json.Marshal(map[string]any{"rewarded": false, "reason": result.Reason})
	}
	return json.Marshal(map[string]any{"rewarded": true, "inviterRewardCredits": result.InviterRewardCredits, "inviteeRewardCredits": result.InviteeRewardCredits})
}

func (b *backend) registerReferralServiceRoutes(mux *http.ServeMux) {
	for _, operation := range []string{"profile", "link", "dashboard", "relationships", "fulfill-first-payment"} {
		mux.HandleFunc("POST /api/internal/referrals/"+operation, b.endpoint(b.handleReferralService))
	}
}
func (b *backend) handleReferralService(w http.ResponseWriter, r *http.Request) error {
	if !b.cronAuthorized(r) {
		return &apiError{403, "FORBIDDEN", "Internal referral service access required"}
	}
	var input struct {
		UserID        string  `json:"userId"`
		InviteeUserID string  `json:"inviteeUserId"`
		Code          string  `json:"code"`
		OrderID       string  `json:"orderId"`
		Provider      string  `json:"paymentProvider"`
		Credits       float64 `json:"firstPaymentCredits"`
	}
	if err := decodeBody(r, &input); err != nil {
		return err
	}
	var output any
	var err error
	switch strings.TrimPrefix(r.URL.Path, "/api/internal/referrals/") {
	case "profile":
		output, err = b.ensureReferralProfile(r.Context(), input.UserID)
	case "link":
		output, err = b.createReferralRelationship(r.Context(), input.InviteeUserID, input.Code)
	case "dashboard":
		output, err = b.referralDashboard(r.Context(), input.UserID)
	case "relationships":
		return b.writeReferralRelationships(w, r, input.UserID)
	case "fulfill-first-payment":
		output, err = b.fulfillReferralReward(r.Context(), &paymentFulfillmentItem{PaymentOrderID: input.OrderID, UserID: input.InviteeUserID, Provider: input.Provider, CreditsAmount: input.Credits})
	default:
		return invalid("Unknown referral operation")
	}
	if err != nil {
		return err
	}
	writeJSON(w, 200, output)
	return nil
}

func (b *backend) ensureReferralProfile(ctx context.Context, userID string) (referralProfileResult, error) {
	var profile referralProfileResult
	if strings.TrimSpace(userID) == "" {
		return profile, invalid("User ID required")
	}
	for attempt := 0; attempt < 4; attempt++ {
		err := b.db.QueryRow(ctx, `SELECT user_id,code,created_at,updated_at FROM referral_profile WHERE user_id=$1`, userID).Scan(&profile.UserID, &profile.Code, &profile.CreatedAt, &profile.UpdatedAt)
		if err == nil {
			return profile, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return profile, err
		}
		// Re-read after ON CONFLICT: concurrent callers must return the winning code.
		code := strings.ToUpper(strings.ReplaceAll(newRequestID(), "-", ""))[:10]
		if _, err = b.db.Exec(ctx, `INSERT INTO referral_profile(user_id,code) VALUES($1,$2) ON CONFLICT DO NOTHING`, userID, code); err != nil {
			return profile, err
		}
	}
	return profile, errors.New("Unable to create referral code")
}
func (b *backend) createReferralRelationship(ctx context.Context, userID, rawCode string) (map[string]any, error) {
	return createReferralRelationshipInStore(ctx, b.db, userID, rawCode)
}

type referralLinkStore interface {
	QueryRow(context.Context, string, ...any) pgx.Row
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

func createReferralRelationshipInStore(ctx context.Context, database referralLinkStore, userID, rawCode string) (map[string]any, error) {
	if strings.TrimSpace(userID) == "" {
		return nil, invalid("Invitee user ID required")
	}
	code := strings.ToUpper(strings.TrimSpace(rawCode))
	if !referralCodePattern.MatchString(code) {
		return map[string]any{"linked": false, "reason": "invalid_code"}, nil
	}
	var inviter string
	err := database.QueryRow(ctx, `SELECT user_id FROM referral_profile WHERE code=$1`, code).Scan(&inviter)
	if errors.Is(err, pgx.ErrNoRows) || inviter == userID {
		return map[string]any{"linked": false, "reason": "invalid_or_self"}, nil
	}
	if err != nil {
		return nil, err
	}
	id := newRequestID()
	tag, err := database.Exec(ctx, `INSERT INTO referral_relationship(id,inviter_user_id,invitee_user_id,referral_code,reward_config_snapshot) VALUES($1,$2,$3,$4,'{}') ON CONFLICT(invitee_user_id) DO NOTHING`, id, inviter, userID, code)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return map[string]any{"linked": false, "reason": "already_linked"}, nil
	}
	return map[string]any{"linked": true, "relationshipId": id}, nil
}
func (b *backend) referralDashboard(ctx context.Context, userID string) (map[string]any, error) {
	profile, err := b.ensureReferralProfile(ctx, userID)
	if err != nil {
		return nil, err
	}
	var invited, rewarded int
	var total float64
	if err := b.db.QueryRow(ctx, `SELECT count(*),count(*) FILTER(WHERE status='rewarded'),COALESCE(sum(inviter_reward_credits),0) FROM referral_relationship WHERE inviter_user_id=$1`, userID).Scan(&invited, &rewarded, &total); err != nil {
		return nil, err
	}
	config, err := b.referralRewardConfig(ctx)
	if err != nil {
		return nil, err
	}
	base := strings.TrimRight(b.config.authURL, "/")
	if base == "" {
		base = "http://localhost:3000"
	}
	return map[string]any{"code": profile.Code, "inviteUrl": base + "/r/" + profile.Code, "invitedCount": invited, "rewardedCount": rewarded, "totalRewardCredits": total, "rewardConfig": config}, nil
}

// Both rewards and the relationship terminal state commit together. The row
// lock also serializes competing first orders; legacy partial grants replay
// through the shared wallet ledger with the original saved pricing snapshot.
func (b *backend) fulfillReferralReward(ctx context.Context, item *paymentFulfillmentItem) (referralFulfillmentResult, error) {
	var result referralFulfillmentResult
	if item == nil || item.PaymentOrderID == "" || item.UserID == "" || !isFinitePaymentNumber(item.CreditsAmount) || item.CreditsAmount <= 0 {
		return result, invalid("Invalid referral payment input")
	}
	provider := item.Provider
	if provider == "alipay" {
		provider = "alipay_f2f"
	}
	if provider != "alipay_f2f" && provider != "epay" && provider != "creem" {
		return result, invalid("Unsupported referral payment provider")
	}
	tx, err := b.db.Begin(ctx)
	if err != nil {
		return result, err
	}
	defer rollback(tx)
	var owner, storedProvider, orderStatus string
	var credits float64
	if err = tx.QueryRow(ctx, `SELECT user_id,provider,status,credits_amount FROM payment_order WHERE id=$1 FOR SHARE`, item.PaymentOrderID).Scan(&owner, &storedProvider, &orderStatus, &credits); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return result, &apiError{404, "NOT_FOUND", "Payment order not found"}
		}
		return result, err
	}
	if owner != item.UserID || storedProvider != provider || (orderStatus != "fulfilling" && orderStatus != "fulfilled") || creditRound(credits) != creditRound(item.CreditsAmount) {
		return result, &apiError{409, "PAYMENT_ORDER_MISMATCH", "Referral payment does not match the verified order"}
	}
	var id, inviter, invitee, status string
	var firstOrder *string
	var snapshot []byte
	var oldInviter, oldInvitee float64
	err = tx.QueryRow(ctx, `SELECT id,inviter_user_id,invitee_user_id,status,first_payment_order_id,reward_config_snapshot,inviter_reward_credits,invitee_reward_credits FROM referral_relationship WHERE invitee_user_id=$1 FOR UPDATE`, owner).Scan(&id, &inviter, &invitee, &status, &firstOrder, &snapshot, &oldInviter, &oldInvitee)
	if errors.Is(err, pgx.ErrNoRows) {
		return referralFulfillmentResult{Reason: "no_referral"}, nil
	}
	if err != nil {
		return result, err
	}
	if firstOrder != nil && *firstOrder != item.PaymentOrderID {
		return referralFulfillmentResult{Reason: "already_used"}, nil
	}
	if firstOrder != nil && status == "rewarded" {
		return referralFulfillmentResult{Rewarded: true, InviterRewardCredits: oldInviter, InviteeRewardCredits: oldInvitee}, nil
	}
	if firstOrder != nil && status == "skipped" {
		return referralFulfillmentResult{Reason: "disabled"}, nil
	}
	var config map[string]any
	if firstOrder != nil {
		var value any
		if err = json.Unmarshal(snapshot, &value); err != nil {
			return result, err
		}
		config = normalizeReferralRewardConfig(value)
	} else {
		config, err = b.referralRewardConfig(ctx)
		if err != nil {
			return result, err
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE referral_relationship SET first_payment_order_id=$2,reward_config_snapshot=$3,updated_at=now() WHERE id=$1`, id, item.PaymentOrderID, paymentMustJSON(config)); err != nil {
		return result, err
	}
	if !boolValue(config["enabled"]) {
		if _, err = tx.Exec(ctx, `UPDATE referral_relationship SET status='skipped',updated_at=now() WHERE id=$1`, id); err != nil {
			return result, err
		}
		return referralFulfillmentResult{Reason: "disabled"}, tx.Commit(ctx)
	}
	result = referralFulfillmentResult{Rewarded: true, InviterRewardCredits: referralRewardAmount(config["inviter"], credits), InviteeRewardCredits: referralRewardAmount(config["invitee"], credits)}
	rewards := []struct {
		user, role string
		amount     float64
	}{{inviter, "inviter", result.InviterRewardCredits}, {invitee, "invitee", result.InviteeRewardCredits}}
	sort.Slice(rewards, func(i, j int) bool { return rewards[i].user < rewards[j].user })
	request := (&http.Request{}).WithContext(ctx)
	for _, reward := range rewards {
		if reward.amount <= 0 {
			continue
		}
		wallet, err := b.lockCreditWallet(request, tx, reward.user)
		if err != nil {
			return result, err
		}
		_, err = b.grantCreditTx(request, tx, wallet, creditMutation{UserID: reward.user, Amount: reward.amount, Type: "referral_reward", SourceType: "referral", SourceRef: "referral:first_payment:" + item.PaymentOrderID + ":" + reward.role, DebitAccount: "SYSTEM:referral_reward", Reason: "推广首充奖励（" + reward.role + "）", Metadata: map[string]any{"role": reward.role, "orderId": item.PaymentOrderID, "provider": paymentProviderName(provider)}})
		if err != nil {
			return result, err
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE referral_relationship SET status='rewarded',inviter_reward_credits=$2,invitee_reward_credits=$3,rewarded_at=now(),updated_at=now() WHERE id=$1`, id, result.InviterRewardCredits, result.InviteeRewardCredits); err != nil {
		return result, err
	}
	return result, tx.Commit(ctx)
}

func normalizeReferralRewardConfig(value any) map[string]any {
	if encoded, ok := value.(string); ok {
		var parsed any
		if json.Unmarshal([]byte(encoded), &parsed) == nil {
			value = parsed
		}
	}
	candidate, _ := value.(map[string]any)
	result := map[string]any{"enabled": boolValue(candidate["enabled"])}
	for _, side := range []string{"inviter", "invitee"} {
		result[side] = normalizeReferralRewardSide(candidate[side], map[string]any{"mode": "percentage", "value": 10.0})
	}
	return result
}

func validReferralRewardNumber(value any, fallback float64) float64 {
	number := imageCreditValue(value, fallback)
	if math.IsNaN(number) || math.IsInf(number, 0) || number < 0 {
		return fallback
	}
	return number
}
