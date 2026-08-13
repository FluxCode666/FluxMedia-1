/**
 * 推广关系 UOL 契约测试。
 *
 * 使用方：Vitest；锁定统计与明细分离、Principal 身份边界、human-only 暴露和
 * 统一 offset 分页信封，避免关系明细重新混入看板摘要。
 */
import { describe, expect, it } from "vitest";

import {
  getMyReferralDashboard,
  listMyReferralRelationships,
} from "./referrals";

describe("referral pagination operation contracts", () => {
  it("keeps the dashboard output limited to aggregate fields", () => {
    expect(
      getMyReferralDashboard.output.safeParse({
        code: "INVITE123",
        inviteUrl: "https://example.com/r/INVITE123",
        invitedCount: 2,
        rewardedCount: 1,
        totalRewardCredits: 10,
        rewardConfig: {
          enabled: true,
          inviter: { mode: "fixed", value: 10 },
          invitee: { mode: "fixed", value: 5 },
        },
        relationships: [],
      }).success
    ).toBe(false);
  });

  it("registers a session-only human pagination read", () => {
    expect(listMyReferralRelationships).toMatchObject({
      access: { kind: "user" },
      agentExposure: "human-only",
      readOnly: true,
      destructive: false,
      idempotency: { kind: "natural" },
      sideEffects: [],
    });
    expect(
      listMyReferralRelationships.input.safeParse({
        page: 2,
        pageSize: 50,
      }).success
    ).toBe(true);
    expect(
      listMyReferralRelationships.input.safeParse({
        page: 2,
        pageSize: 50,
        userId: "forged-user",
      }).success
    ).toBe(false);
  });

  it("accepts the shared offset envelope without raw email fields", () => {
    const parsed = listMyReferralRelationships.output.safeParse({
      records: [
        {
          id: "relationship-1",
          inviteeName: "Example User",
          inviteeEmail: "e***@example.com",
          status: "rewarded",
          inviterRewardCredits: 10,
          inviteeRewardCredits: 5,
          createdAt: "2026-08-12T08:00:00.000Z",
          rewardedAt: "2026-08-13T08:00:00.000Z",
        },
      ],
      page: 1,
      pageSize: 20,
      totalCount: 1,
      totalPages: 1,
    });
    expect(parsed.success).toBe(true);
  });
});
