/**
 * 推广首充履约服务的幂等状态测试。
 *
 * 使用最小数据库与积分发放替身验证关系缺失、配置开关、两种奖励模式、
 * 首充唯一性和单方失败后的补偿重试；不连接真实 PostgreSQL。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  update: vi.fn(),
  getRuntimeSettingJson: vi.fn(),
  grantCredits: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  db: {
    select: mocks.select,
    update: mocks.update,
  },
  referralProfile: {
    userId: "referral_profile.user_id",
    code: "referral_profile.code",
  },
  referralRelationship: {
    id: "referral_relationship.id",
    inviterUserId: "referral_relationship.inviter_user_id",
    inviteeUserId: "referral_relationship.invitee_user_id",
    firstPaymentOrderId: "referral_relationship.first_payment_order_id",
    status: "referral_relationship.status",
    inviterRewardCredits: "referral_relationship.inviter_reward_credits",
    inviteeRewardCredits: "referral_relationship.invitee_reward_credits",
    createdAt: "referral_relationship.created_at",
    rewardedAt: "referral_relationship.rewarded_at",
  },
  user: {
    id: "user.id",
    name: "user.name",
    email: "user.email",
  },
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn(),
  desc: vi.fn(),
  eq: vi.fn(),
  isNull: vi.fn(),
  or: vi.fn(),
  sql: vi.fn(),
}));

vi.mock("../credits/core", () => ({
  grantCredits: mocks.grantCredits,
}));

vi.mock("../system-settings", () => ({
  getRuntimeSettingJson: mocks.getRuntimeSettingJson,
}));

import {
  fulfillReferralFirstPayment,
  listReferralRelationships,
} from "./service";

type Relationship = {
  id: string;
  inviterUserId: string;
  inviteeUserId: string;
  firstPaymentOrderId: string | null;
  status: "pending" | "rewarded" | "skipped";
  inviterRewardCredits: number;
  inviteeRewardCredits: number;
  rewardConfigSnapshot: Record<string, unknown>;
};

const enabledPercentageConfig = {
  enabled: true,
  inviter: { mode: "percentage" as const, value: 10 },
  invitee: { mode: "percentage" as const, value: 5 },
};

/** 创建可按场景覆盖的推广关系快照。 */
function relationship(overrides: Partial<Relationship> = {}): Relationship {
  return {
    id: "relationship-1",
    inviterUserId: "inviter-1",
    inviteeUserId: "invitee-1",
    firstPaymentOrderId: null,
    status: "pending",
    inviterRewardCredits: 0,
    inviteeRewardCredits: 0,
    rewardConfigSnapshot: {},
    ...overrides,
  };
}

/** 为一次履约场景装配最小 Drizzle 查询和更新链。 */
function prepareDatabase(
  selected: Relationship | undefined,
  claimed: Relationship | undefined = selected
) {
  const selectBuilder = (rows: Relationship[]) => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => rows),
      })),
    })),
  });
  mocks.select.mockReturnValue(selectBuilder(selected ? [selected] : []));
  mocks.update.mockImplementation(() => {
    return {
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => (claimed ? [claimed] : [])),
          // biome-ignore lint/suspicious/noThenProperty: Drizzle update builders are thenable in this test double.
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve(undefined).then(resolve),
        })),
      })),
    };
  });
}

describe("fulfillReferralFirstPayment", () => {
  beforeEach(() => {
    mocks.select.mockReset();
    mocks.update.mockReset();
    mocks.getRuntimeSettingJson.mockReset();
    mocks.grantCredits.mockReset();
    mocks.grantCredits.mockResolvedValue({ batchId: "batch-1" });
    mocks.getRuntimeSettingJson.mockResolvedValue(enabledPercentageConfig);
  });

  it("does nothing when the invitee has no referral relationship", async () => {
    prepareDatabase(undefined);

    await expect(
      fulfillReferralFirstPayment({
        orderId: "order-1",
        inviteeUserId: "invitee-1",
        firstPaymentCredits: 100,
        paymentProvider: "epay",
      })
    ).resolves.toEqual({ rewarded: false, reason: "no_referral" });
    expect(mocks.grantCredits).not.toHaveBeenCalled();
  });

  it("marks a relationship skipped while the feature is disabled", async () => {
    prepareDatabase(relationship());
    mocks.getRuntimeSettingJson.mockResolvedValue({
      ...enabledPercentageConfig,
      enabled: false,
    });

    await expect(
      fulfillReferralFirstPayment({
        orderId: "order-disabled",
        inviteeUserId: "invitee-1",
        firstPaymentCredits: 100,
        paymentProvider: "epay",
      })
    ).resolves.toEqual({ rewarded: false, reason: "disabled" });
    expect(mocks.grantCredits).not.toHaveBeenCalled();
  });

  it("grants percentage rewards to both sides", async () => {
    const selected = relationship();
    prepareDatabase(selected);

    await expect(
      fulfillReferralFirstPayment({
        orderId: "order-percentage",
        inviteeUserId: "invitee-1",
        firstPaymentCredits: 200,
        paymentProvider: "epay",
      })
    ).resolves.toEqual({
      rewarded: true,
      inviterRewardCredits: 20,
      inviteeRewardCredits: 10,
    });
    expect(mocks.grantCredits).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        userId: "inviter-1",
        amount: 20,
        sourceRef: "referral:first_payment:order-percentage:inviter",
      })
    );
    expect(mocks.grantCredits).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        userId: "invitee-1",
        amount: 10,
        sourceRef: "referral:first_payment:order-percentage:invitee",
      })
    );
  });

  it("grants fixed rewards to both sides", async () => {
    mocks.getRuntimeSettingJson.mockResolvedValue({
      enabled: true,
      inviter: { mode: "fixed", value: 12.5 },
      invitee: { mode: "fixed", value: 8 },
    });
    prepareDatabase(relationship());

    await expect(
      fulfillReferralFirstPayment({
        orderId: "order-fixed",
        inviteeUserId: "invitee-1",
        firstPaymentCredits: 1,
        paymentProvider: "creem",
      })
    ).resolves.toEqual({
      rewarded: true,
      inviterRewardCredits: 12.5,
      inviteeRewardCredits: 8,
    });
  });

  it("rejects a different second payment after the first order is claimed", async () => {
    prepareDatabase(
      relationship({ firstPaymentOrderId: "order-first", status: "rewarded" })
    );

    await expect(
      fulfillReferralFirstPayment({
        orderId: "order-second",
        inviteeUserId: "invitee-1",
        firstPaymentCredits: 500,
        paymentProvider: "alipay",
      })
    ).resolves.toEqual({ rewarded: false, reason: "already_used" });
    expect(mocks.grantCredits).not.toHaveBeenCalled();
  });

  it("keeps a disabled first payment skipped after the feature is enabled", async () => {
    prepareDatabase(
      relationship({
        firstPaymentOrderId: "order-skipped",
        status: "skipped",
        rewardConfigSnapshot: {
          ...enabledPercentageConfig,
          enabled: false,
        },
      })
    );

    await expect(
      fulfillReferralFirstPayment({
        orderId: "order-skipped",
        inviteeUserId: "invitee-1",
        firstPaymentCredits: 100,
        paymentProvider: "epay",
      })
    ).resolves.toEqual({ rewarded: false, reason: "disabled" });
    expect(mocks.grantCredits).not.toHaveBeenCalled();
  });

  it("returns stored rewards for a completed duplicate order", async () => {
    prepareDatabase(
      relationship({
        firstPaymentOrderId: "order-complete",
        status: "rewarded",
        inviterRewardCredits: 11,
        inviteeRewardCredits: 6,
        rewardConfigSnapshot: enabledPercentageConfig,
      })
    );

    await expect(
      fulfillReferralFirstPayment({
        orderId: "order-complete",
        inviteeUserId: "invitee-1",
        firstPaymentCredits: 999,
        paymentProvider: "alipay",
      })
    ).resolves.toEqual({
      rewarded: true,
      inviterRewardCredits: 11,
      inviteeRewardCredits: 6,
    });
    expect(mocks.grantCredits).not.toHaveBeenCalled();
  });

  it("lets a concurrent webhook take over a claimed pending order", async () => {
    const initial = relationship();
    const claimedByOther = relationship({
      firstPaymentOrderId: "order-concurrent",
      rewardConfigSnapshot: enabledPercentageConfig,
    });
    const selectBuilder = (rows: Relationship[]) => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => rows),
        })),
      })),
    });
    mocks.select
      .mockReturnValueOnce(selectBuilder([initial]))
      .mockReturnValueOnce(selectBuilder([claimedByOther]));
    mocks.update.mockImplementation(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => []),
          // biome-ignore lint/suspicious/noThenProperty: Drizzle update builders are thenable in this test double.
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve(undefined).then(resolve),
        })),
      })),
    }));

    await expect(
      fulfillReferralFirstPayment({
        orderId: "order-concurrent",
        inviteeUserId: "invitee-1",
        firstPaymentCredits: 100,
        paymentProvider: "alipay",
      })
    ).resolves.toEqual({
      rewarded: true,
      inviterRewardCredits: 10,
      inviteeRewardCredits: 5,
    });
    expect(mocks.grantCredits).toHaveBeenCalledTimes(2);
  });

  it("uses the claimed snapshot and stable keys after a single-side failure", async () => {
    const snapshot = {
      enabled: true,
      inviter: { mode: "fixed", value: 7 },
      invitee: { mode: "fixed", value: 9 },
    };
    const selected = relationship({
      firstPaymentOrderId: "order-retry",
      rewardConfigSnapshot: snapshot,
    });
    prepareDatabase(selected, selected);
    mocks.getRuntimeSettingJson.mockResolvedValue({
      enabled: true,
      inviter: { mode: "fixed", value: 100 },
      invitee: { mode: "fixed", value: 200 },
    });
    mocks.grantCredits
      .mockResolvedValueOnce({ batchId: "inviter-batch" })
      .mockRejectedValueOnce(new Error("invitee ledger down"));

    await expect(
      fulfillReferralFirstPayment({
        orderId: "order-retry",
        inviteeUserId: "invitee-1",
        firstPaymentCredits: 100,
        paymentProvider: "creem",
      })
    ).rejects.toThrow("invitee ledger down");

    mocks.grantCredits.mockResolvedValue({ batchId: "batch-1" });
    await expect(
      fulfillReferralFirstPayment({
        orderId: "order-retry",
        inviteeUserId: "invitee-1",
        firstPaymentCredits: 100,
        paymentProvider: "creem",
      })
    ).resolves.toEqual({
      rewarded: true,
      inviterRewardCredits: 7,
      inviteeRewardCredits: 9,
    });
    expect(mocks.grantCredits).toHaveBeenCalledTimes(4);
    expect(mocks.grantCredits.mock.calls[3]?.[0]).toEqual(
      expect.objectContaining({ userId: "invitee-1", amount: 9 })
    );
  });
});

describe("listReferralRelationships", () => {
  beforeEach(() => {
    mocks.select.mockReset();
  });

  it("returns every relationship in stable descending order", async () => {
    const orderBy = vi.fn(async () => [
      {
        id: "relationship-41",
        inviteeName: "Example User",
        inviteeEmail: "example@example.com",
        status: "rewarded" as const,
        inviterRewardCredits: 10,
        inviteeRewardCredits: 5,
        createdAt: new Date("2026-08-12T08:00:00.000Z"),
        rewardedAt: new Date("2026-08-13T08:00:00.000Z"),
      },
    ]);
    const rowsWhere = vi.fn(() => ({ orderBy }));
    mocks.select.mockReturnValue({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({ where: rowsWhere })),
      })),
    });

    await expect(listReferralRelationships("inviter-1", {})).resolves.toEqual({
      records: [
        {
          id: "relationship-41",
          inviteeName: "Example User",
          inviteeEmail: "e***@example.com",
          status: "rewarded",
          inviterRewardCredits: 10,
          inviteeRewardCredits: 5,
          createdAt: "2026-08-12T08:00:00.000Z",
          rewardedAt: "2026-08-13T08:00:00.000Z",
        },
      ],
      totalCount: 1,
    });
    expect(mocks.select).toHaveBeenCalledTimes(1);
    expect(orderBy).toHaveBeenCalledTimes(1);
  });
});
