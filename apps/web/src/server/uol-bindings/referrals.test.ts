/** 推广读取 binding 测试：确认 UOL 通过 Go API 读取，而不是回落到 Next 数据库。 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestGoJson: vi.fn(),
  fulfillReferralFirstPayment: vi.fn(),
}));

vi.mock("@/server/go-backend-client", () => ({
  requestGoJson: mocks.requestGoJson,
}));
vi.mock("@repo/shared/referrals", () => ({
  fulfillReferralFirstPayment: mocks.fulfillReferralFirstPayment,
}));

import { invokeOperation } from "@repo/shared/uol";
import "./referrals";

describe("referral Go bindings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requestGoJson.mockImplementation(async (path: string) => {
      if (path.endsWith("/dashboard")) {
        return {
          code: "ABC123",
          inviteUrl: "https://example.test/r/ABC123",
          invitedCount: 2,
          rewardedCount: 1,
          totalRewardCredits: 25,
          rewardConfig: {
            enabled: true,
            inviter: { mode: "fixed", value: 20 },
            invitee: { mode: "fixed", value: 5 },
          },
        };
      }
      return {
        records: [
          {
            id: "relationship-1",
            inviteeName: "Invitee",
            inviteeEmail: "i***@example.test",
            status: "rewarded",
            inviterRewardCredits: 20,
            inviteeRewardCredits: 5,
            createdAt: "2026-09-13T00:00:00.000Z",
            rewardedAt: "2026-09-13T00:01:00.000Z",
          },
        ],
        totalCount: 1,
      };
    });
  });

  it("routes dashboard and relationship reads to Go with session-derived identity", async () => {
    const principal = { type: "user" as const, userId: "user-1", role: "user" as const };
    await expect(invokeOperation("referral.getMyDashboard", {}, principal)).resolves.toMatchObject({ code: "ABC123" });
    await expect(invokeOperation("referral.listMyRelationships", {}, principal)).resolves.toMatchObject({ totalCount: 1 });
    expect(mocks.requestGoJson).toHaveBeenNthCalledWith(1, "/api/referrals/dashboard");
    expect(mocks.requestGoJson).toHaveBeenNthCalledWith(2, "/api/referrals/relationships");
  });

  it("rejects non-session principals before contacting Go", async () => {
    await expect(
      invokeOperation("referral.getMyDashboard", {}, { type: "system", reason: "test" })
    ).rejects.toMatchObject({ code: "unauthenticated" });
    expect(mocks.requestGoJson).not.toHaveBeenCalled();
  });
});
