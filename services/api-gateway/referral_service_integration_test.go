//go:build integration

package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
)

func seedReferralPayment(t *testing.T, b *backend, uid string, credits float64) *paymentFulfillmentItem {
	t.Helper()
	id := newRequestID()
	if _, err := b.db.Exec(context.Background(), `INSERT INTO payment_order(id,user_id,client_request_id,provider,purpose,status,currency,amount,amount_minor,credits_amount,pricing_snapshot,provider_trade_no) VALUES($1,$2,$1,'epay','credit_package','fulfilled','CNY',1,100,$3,'{}',$1)`, id, uid, credits); err != nil {
		t.Fatal(err)
	}
	return &paymentFulfillmentItem{PaymentOrderID: id, UserID: uid, Provider: "epay", CreditsAmount: credits}
}
func seedReferralPair(t *testing.T, b *backend) (string, string) {
	t.Helper()
	inviter, _ := seedAuthUser(t, b)
	invitee, _ := seedAuthUser(t, b)
	profile, err := b.ensureReferralProfile(context.Background(), inviter)
	if err != nil {
		t.Fatal(err)
	}
	result, err := b.createReferralRelationship(context.Background(), invitee, strings.ToLower(profile.Code))
	if err != nil || result["linked"] != true {
		t.Fatalf("link %+v %v", result, err)
	}
	return inviter, invitee
}
func referralTestConfig(t *testing.T, b *backend, enabled bool) {
	t.Helper()
	setStorageTestSetting(t, b, "REFERRAL_REWARD_CONFIG", map[string]any{"enabled": enabled, "inviter": map[string]any{"mode": "percentage", "value": 10}, "invitee": map[string]any{"mode": "percentage", "value": 5}})
	setStorageTestSetting(t, b, "FREE_CREDITS_EXPIRY_DAYS", 7)
}
func referralBalance(t *testing.T, b *backend, uid string) float64 {
	t.Helper()
	var amount float64
	if err := b.db.QueryRow(context.Background(), `SELECT COALESCE((SELECT balance FROM credits_balance WHERE user_id=$1),0)`, uid).Scan(&amount); err != nil {
		t.Fatal(err)
	}
	return amount
}
func TestReferralAtomicConcurrentFirstPaymentAndSnapshotReplay(t *testing.T) {
	b := integrationBackend(t)
	referralTestConfig(t, b, true)
	inviter, invitee := seedReferralPair(t, b)
	item := seedReferralPayment(t, b, invitee, 123.45)
	var wg sync.WaitGroup
	results := make(chan referralFulfillmentResult, 8)
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			result, err := b.fulfillReferralReward(context.Background(), item)
			results <- result
			errs <- err
		}()
	}
	wg.Wait()
	close(results)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	for result := range results {
		if !result.Rewarded || result.InviterRewardCredits != 12.34 || result.InviteeRewardCredits != 6.17 {
			t.Fatalf("result %+v", result)
		}
	}
	if a, c := referralBalance(t, b, inviter), referralBalance(t, b, invitee); a != 12.34 || c != 6.17 {
		t.Fatalf("duplicate rewards %v %v", a, c)
	}
	var count, expires int
	if err := b.db.QueryRow(context.Background(), `SELECT count(*),count(expires_at) FROM credits_batch WHERE source_type='referral' AND user_id IN ($1,$2)`, inviter, invitee).Scan(&count, &expires); err != nil || count != 2 || expires != 2 {
		t.Fatalf("reward ledger count=%d expiry=%d err=%v", count, expires, err)
	}
	setStorageTestSetting(t, b, "REFERRAL_REWARD_CONFIG", map[string]any{"enabled": true, "inviter": map[string]any{"mode": "fixed", "value": 999}, "invitee": map[string]any{"mode": "fixed", "value": 888}})
	replay, err := b.fulfillReferralReward(context.Background(), item)
	if err != nil || replay.InviterRewardCredits != 12.34 || replay.InviteeRewardCredits != 6.17 {
		t.Fatalf("mutated terminal snapshot %+v %v", replay, err)
	}
	other := seedReferralPayment(t, b, invitee, 200)
	result, err := b.fulfillReferralReward(context.Background(), other)
	if err != nil || result.Reason != "already_used" {
		t.Fatalf("second payment %+v %v", result, err)
	}
}
func TestReferralRewardFailureRollsBackBothWalletsAndClaim(t *testing.T) {
	b := integrationBackend(t)
	referralTestConfig(t, b, true)
	inviter, invitee := seedReferralPair(t, b)
	item := seedReferralPayment(t, b, invitee, 100)
	creditTestWallet(t, b, inviter, 0)
	creditTestWallet(t, b, invitee, 0)
	frozen := inviter
	if invitee > inviter {
		frozen = invitee
	}
	if _, err := b.db.Exec(context.Background(), `UPDATE credits_balance SET status='frozen' WHERE user_id=$1`, frozen); err != nil {
		t.Fatal(err)
	}
	if _, err := b.fulfillReferralReward(context.Background(), item); err == nil {
		t.Fatal("frozen second wallet accepted")
	}
	var first *string
	var status string
	var count int
	if err := b.db.QueryRow(context.Background(), `SELECT first_payment_order_id,status,(SELECT count(*) FROM credits_transaction WHERE user_id IN ($2,$3)) FROM referral_relationship WHERE invitee_user_id=$1`, invitee, inviter, invitee).Scan(&first, &status, &count); err != nil {
		t.Fatal(err)
	}
	if first != nil || status != "pending" || count != 0 || referralBalance(t, b, inviter) != 0 || referralBalance(t, b, invitee) != 0 {
		t.Fatalf("partial transaction survived first=%v status=%s count=%d", first, status, count)
	}
	if _, err := b.db.Exec(context.Background(), `UPDATE credits_balance SET status='active' WHERE user_id=$1`, frozen); err != nil {
		t.Fatal(err)
	}
	if result, err := b.fulfillReferralReward(context.Background(), item); err != nil || !result.Rewarded {
		t.Fatalf("recovery %+v %v", result, err)
	}
}
func TestReferralLegacyPartialGrantUsesClaimedConfigAndDoesNotRepeatGrant(t *testing.T) {
	b := integrationBackend(t)
	b.config.cronSecret = "referral-test-secret"
	referralTestConfig(t, b, true)
	inviter, invitee := seedReferralPair(t, b)
	item := seedReferralPayment(t, b, invitee, 100)
	snapshot := map[string]any{"enabled": true, "inviter": map[string]any{"mode": "percentage", "value": 10}, "invitee": map[string]any{"mode": "percentage", "value": 5}}
	if _, err := b.db.Exec(context.Background(), `UPDATE referral_relationship SET first_payment_order_id=$2,reward_config_snapshot=$3 WHERE invitee_user_id=$1`, invitee, item.PaymentOrderID, mustJSON(snapshot)); err != nil {
		t.Fatal(err)
	}
	requireCreditResponse(t, creditsRequest(b, creditMutation{Operation: "grant", UserID: inviter, Amount: 10, SourceType: "referral", Type: "referral_reward", SourceRef: "referral:first_payment:" + item.PaymentOrderID + ":inviter"}, nil, true), 200)
	referralTestConfig(t, b, false)
	result, err := b.fulfillReferralReward(context.Background(), item)
	if err != nil || !result.Rewarded || result.InviterRewardCredits != 10 || result.InviteeRewardCredits != 5 || referralBalance(t, b, inviter) != 10 || referralBalance(t, b, invitee) != 5 {
		t.Fatalf("legacy recovery %+v %v", result, err)
	}
}
func TestReferralFirstOrderRaceAndInternalBoundary(t *testing.T) {
	b := integrationBackend(t)
	b.config.cronSecret = "referral-test-secret"
	referralTestConfig(t, b, true)
	inviter, invitee := seedReferralPair(t, b)
	orders := []*paymentFulfillmentItem{seedReferralPayment(t, b, invitee, 100), seedReferralPayment(t, b, invitee, 100)}
	var wg sync.WaitGroup
	results := make(chan referralFulfillmentResult, 2)
	for _, item := range orders {
		wg.Add(1)
		go func(item *paymentFulfillmentItem) {
			defer wg.Done()
			result, err := b.fulfillReferralReward(context.Background(), item)
			if err != nil {
				t.Error(err)
			}
			results <- result
		}(item)
	}
	wg.Wait()
	close(results)
	rewarded := 0
	for result := range results {
		if result.Rewarded {
			rewarded++
		} else if result.Reason != "already_used" {
			t.Errorf("unexpected result %+v", result)
		}
	}
	if rewarded != 1 || referralBalance(t, b, inviter) != 10 || referralBalance(t, b, invitee) != 5 {
		t.Fatal("competing first payments both rewarded")
	}
	input := map[string]any{"orderId": orders[0].PaymentOrderID, "inviteeUserId": invitee, "paymentProvider": "epay", "firstPaymentCredits": 100}
	raw, _ := json.Marshal(input)
	denied := storageTestRequest(b, http.MethodPost, "/api/internal/referrals/fulfill-first-payment", raw, nil, nil)
	if denied.Code != 403 {
		t.Fatalf("untrusted payment reward %d", denied.Code)
	}
	input["firstPaymentCredits"] = 999
	raw, _ = json.Marshal(input)
	invalid := storageTestRequest(b, http.MethodPost, "/api/internal/referrals/fulfill-first-payment", raw, nil, map[string]string{"Authorization": "Bearer " + b.config.cronSecret})
	if invalid.Code != 409 {
		t.Fatalf("forged payment value %d %s", invalid.Code, invalid.Body.String())
	}
}
func TestReferralDisabledConsumesFirstQualificationAndProfileIsStable(t *testing.T) {
	b := integrationBackend(t)
	referralTestConfig(t, b, false)
	inviter, invitee := seedReferralPair(t, b)
	item := seedReferralPayment(t, b, invitee, 100)
	first, err := b.fulfillReferralReward(context.Background(), item)
	if err != nil || first.Reason != "disabled" {
		t.Fatalf("disabled %+v %v", first, err)
	}
	referralTestConfig(t, b, true)
	replay, err := b.fulfillReferralReward(context.Background(), item)
	if err != nil || replay.Reason != "disabled" {
		t.Fatalf("disabled replay %+v %v", replay, err)
	}
	userID, _ := seedAuthUser(t, b)
	codes := make(chan string, 8)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			profile, err := b.ensureReferralProfile(context.Background(), userID)
			if err != nil {
				t.Error(err)
			}
			codes <- profile.Code
		}()
	}
	wg.Wait()
	close(codes)
	var code string
	for next := range codes {
		if code != "" && next != code {
			t.Fatal("profile returned a code that was not persisted")
		}
		code = next
	}
	if referralBalance(t, b, inviter) != 0 || referralBalance(t, b, invitee) != 0 {
		t.Fatal("disabled reward credited wallets")
	}
}

func TestReferralRequiresVerifiedPaymentAndPreservesZeroRewards(t *testing.T) {
	b := integrationBackend(t)
	b.config.cronSecret = "referral-test-secret"
	referralTestConfig(t, b, true)
	inviter, invitee := seedReferralPair(t, b)
	item := seedReferralPayment(t, b, invitee, 100)
	for _, change := range []func(*paymentFulfillmentItem){
		func(input *paymentFulfillmentItem) { input.UserID = inviter },
		func(input *paymentFulfillmentItem) { input.Provider = "creem" },
		func(input *paymentFulfillmentItem) { input.CreditsAmount = 200 },
	} {
		input := *item
		change(&input)
		if _, err := b.fulfillReferralReward(context.Background(), &input); err == nil {
			t.Fatalf("mismatched payment accepted %+v", input)
		}
	}
	if _, err := b.db.Exec(context.Background(), `UPDATE payment_order SET status='pending' WHERE id=$1`, item.PaymentOrderID); err != nil {
		t.Fatal(err)
	}
	if _, err := b.fulfillReferralReward(context.Background(), item); err == nil {
		t.Fatal("unverified payment accepted")
	}
	if _, err := b.db.Exec(context.Background(), `UPDATE payment_order SET status='fulfilled' WHERE id=$1`, item.PaymentOrderID); err != nil {
		t.Fatal(err)
	}
	setStorageTestSetting(t, b, "REFERRAL_REWARD_CONFIG", map[string]any{"enabled": true, "inviter": map[string]any{"mode": "fixed", "value": 0}, "invitee": map[string]any{"mode": "percentage", "value": 0}})
	raw, err := json.Marshal(map[string]any{"orderId": item.PaymentOrderID, "inviteeUserId": invitee, "paymentProvider": "epay", "firstPaymentCredits": 100})
	if err != nil {
		t.Fatal(err)
	}
	response := storageTestRequest(b, http.MethodPost, "/api/internal/referrals/fulfill-first-payment", raw, nil, map[string]string{"Authorization": "Bearer " + b.config.cronSecret})
	var result map[string]any
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &result) != nil || result["rewarded"] != true || result["inviterRewardCredits"] != float64(0) || result["inviteeRewardCredits"] != float64(0) {
		t.Fatalf("zero reward contract %d %s", response.Code, response.Body.String())
	}
	if referralBalance(t, b, inviter) != 0 || referralBalance(t, b, invitee) != 0 {
		t.Fatal("invalid payment or zero configuration credited wallets")
	}
	otherUser, _ := seedAuthUser(t, b)
	otherOrder := seedReferralPayment(t, b, otherUser, 100)
	if result, err := b.fulfillReferralReward(context.Background(), otherOrder); err != nil || result.Rewarded || result.Reason != "no_referral" {
		t.Fatalf("unattributed payment result %+v %v", result, err)
	}
}
