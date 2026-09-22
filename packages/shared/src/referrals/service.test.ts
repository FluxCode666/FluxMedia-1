/** Go owns referral persistence and settlement; these tests verify the shared boundary. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.hoisted(() => vi.fn());
vi.mock("../http/go-backend", () => ({ requestGoBackendInternalJson: request }));

import { REFERRAL_CODE_COOKIE } from "./cookie";
import {
  createReferralRelationshipFromCode,
  ensureReferralProfile,
  fulfillReferralFirstPayment,
  getReferralDashboard,
  listReferralRelationships,
  readReferralCodeFromAuthContext,
} from "./service";

beforeEach(() => {
  request.mockReset();
});

describe("referral Go service boundary", () => {
  it("hydrates profile timestamps returned by Go", async () => {
    const profile = { userId: "user-1", code: "ABC123", createdAt: "2026-09-01T01:00:00.000Z", updatedAt: "2026-09-02T02:00:00.000Z" };
    request.mockResolvedValue(profile);
    await expect(ensureReferralProfile("user-1")).resolves.toEqual({ ...profile, createdAt: new Date(profile.createdAt), updatedAt: new Date(profile.updatedAt) });
    expect(request).toHaveBeenCalledWith("/api/internal/referrals/profile", { method: "POST", body: JSON.stringify({ userId: "user-1" }) });
  });

  it("normalizes attribution before forwarding to Go", async () => {
    request.mockResolvedValue({ linked: true, relationshipId: "relationship-1" });
    await expect(createReferralRelationshipFromCode("invitee-1", " abc123 ")).resolves.toEqual({ linked: true, relationshipId: "relationship-1" });
    expect(request).toHaveBeenCalledWith("/api/internal/referrals/link", { method: "POST", body: JSON.stringify({ inviteeUserId: "invitee-1", code: "ABC123" }) });
  });

  it.each([undefined, null, 123456, "short", "ABC_123"])("does not dispatch invalid attribution %j", async (code) => {
    await expect(createReferralRelationshipFromCode("invitee-1", code)).resolves.toEqual({ linked: false, reason: "invalid_code" });
    expect(request).not.toHaveBeenCalled();
  });

  it("uses the caller's public application URL for invitation links", async () => {
    const dashboard = { code: "ABC123", inviteUrl: "http://internal:8080/r/ABC123", invitedCount: 4, rewardedCount: 2, totalRewardCredits: 12.34, rewardConfig: { enabled: true, inviter: { mode: "percentage", value: 10 }, invitee: { mode: "fixed", value: 5 } } };
    request.mockResolvedValue(dashboard);
    await expect(getReferralDashboard({ userId: "user-1", appUrl: "https://media.example/" })).resolves.toEqual({ ...dashboard, inviteUrl: "https://media.example/r/ABC123" });
    expect(request).toHaveBeenCalledWith("/api/internal/referrals/dashboard", { method: "POST", body: JSON.stringify({ userId: "user-1" }) });
  });

  it("preserves the scoped, masked relationship list returned by Go", async () => {
    const list = { records: [{ id: "relationship-1", inviteeName: "U***", inviteeEmail: "u***@example.com", status: "rewarded", inviterRewardCredits: 12.34, inviteeRewardCredits: 6.17, createdAt: "2026-09-01T01:00:00.000Z", rewardedAt: "2026-09-02T02:00:00.000Z" }], totalCount: 1 };
    request.mockResolvedValue(list);
    await expect(listReferralRelationships("inviter-1", {})).resolves.toEqual(list);
    expect(request).toHaveBeenCalledWith("/api/internal/referrals/relationships", { method: "POST", body: JSON.stringify({ userId: "inviter-1" }) });
  });

  it.each(["alipay", "alipay_f2f", "epay", "creem"] as const)("forwards verified %s payment work without changing financial inputs", async (paymentProvider) => {
    const input = { orderId: "order-1", inviteeUserId: "invitee-1", firstPaymentCredits: 123.45, paymentProvider };
    request.mockResolvedValue({ rewarded: true, inviterRewardCredits: 12.34, inviteeRewardCredits: 6.17 });
    await expect(fulfillReferralFirstPayment(input)).resolves.toEqual({ rewarded: true, inviterRewardCredits: 12.34, inviteeRewardCredits: 6.17 });
    expect(request).toHaveBeenCalledWith("/api/internal/referrals/fulfill-first-payment", { method: "POST", body: JSON.stringify(input) });
  });

  it.each(["no_referral", "already_used", "disabled"])("preserves Go's %s settlement result", async (reason) => {
    request.mockResolvedValue({ rewarded: false, reason });
    await expect(fulfillReferralFirstPayment({ orderId: "order-1", inviteeUserId: "invitee-1", firstPaymentCredits: 100, paymentProvider: "epay" })).resolves.toEqual({ rewarded: false, reason });
  });

  it("propagates settlement failures so payment recovery can retry", async () => {
    const failure = new Error("Referral payment does not match the verified order");
    request.mockRejectedValue(failure);
    await expect(fulfillReferralFirstPayment({ orderId: "order-1", inviteeUserId: "invitee-1", firstPaymentCredits: 999, paymentProvider: "epay" })).rejects.toBe(failure);
  });
});

describe("registration referral context", () => {
  function context(body: unknown, cookie: string) {
    return { body, request: new Request("https://media.example/api/auth/sign-up/email", { headers: { cookie } }) };
  }

  it("prefers an explicit valid code over the cookie", () => {
    expect(readReferralCodeFromAuthContext(context({ referralCode: " explicit123 " }, `${REFERRAL_CODE_COOKIE}=COOKIE123`))).toBe("EXPLICIT123");
    expect(request).not.toHaveBeenCalled();
  });

  it("falls back to a normalized cookie when the explicit field is invalid", () => {
    expect(readReferralCodeFromAuthContext(context({ referralCode: "invalid!" }, `other=value; ${REFERRAL_CODE_COOKIE}=%20cookie123%20; last=value`))).toBe("COOKIE123");
  });

  it("ignores missing, malformed, and similarly named cookies", () => {
    expect(readReferralCodeFromAuthContext(undefined)).toBeNull();
    expect(readReferralCodeFromAuthContext(context(null, `${REFERRAL_CODE_COOKIE}=%E0%A4%A`))).toBeNull();
    expect(readReferralCodeFromAuthContext(context({}, `${REFERRAL_CODE_COOKIE}_other=COOKIE123`))).toBeNull();
  });
});
