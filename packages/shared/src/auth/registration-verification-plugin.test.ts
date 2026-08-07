/**
 * Better Auth 用户创建后的推广归因钩子测试。
 *
 * 归因是注册后的附加投影；测试确保其临时失败会记录日志但不回滚用户注册。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recordRegistrationIdentity: vi.fn(),
  markRegistrationIdentityDeleted: vi.fn(),
  ensureReferralProfile: vi.fn(),
  createReferralRelationshipFromCode: vi.fn(),
  readReferralCodeFromAuthContext: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  db: {},
  user: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
}));

vi.mock("../logger", () => ({ logError: mocks.logError }));
vi.mock("../referrals", () => ({
  createReferralRelationshipFromCode: mocks.createReferralRelationshipFromCode,
  ensureReferralProfile: mocks.ensureReferralProfile,
  readReferralCodeFromAuthContext: mocks.readReferralCodeFromAuthContext,
}));
vi.mock("./email-domain", () => ({
  getAllowedRegistrationEmailMessage: vi.fn(() => "invalid domain"),
  isAllowedRegistrationEmail: vi.fn(() => true),
  normalizeEmail: vi.fn((value: string) => value.toLowerCase()),
}));
vi.mock("./registration-identity", () => ({
  isRegistrationEmailTaken: vi.fn(async () => false),
  markRegistrationIdentityDeleted: mocks.markRegistrationIdentityDeleted,
  recordRegistrationIdentity: mocks.recordRegistrationIdentity,
}));
vi.mock("./registration-verification", () => ({
  verifyRegistrationCode: vi.fn(async () => true),
}));
vi.mock("./self-use-mode", () => ({
  isSelfUseModeEnabled: vi.fn(async () => false),
}));

import { registrationVerificationPlugin } from "./registration-verification-plugin";

type UserCreateAfter = (
  user: { id: string; email: string },
  context: unknown
) => Promise<void>;

/** 取得插件声明的用户创建后置钩子，避免测试依赖 Better Auth 内部实现。 */
function getUserCreateAfterHook() {
  const plugin = registrationVerificationPlugin() as unknown as {
    init: () => {
      options?: {
        databaseHooks?: {
          user?: { create?: { after?: UserCreateAfter } };
        };
      };
    };
  };
  return plugin.init().options?.databaseHooks?.user?.create
    ?.after as UserCreateAfter;
}

describe("registration referral attribution hook", () => {
  beforeEach(() => {
    mocks.recordRegistrationIdentity.mockReset();
    mocks.markRegistrationIdentityDeleted.mockReset();
    mocks.ensureReferralProfile.mockReset();
    mocks.createReferralRelationshipFromCode.mockReset();
    mocks.readReferralCodeFromAuthContext.mockReset();
    mocks.logError.mockReset();
    mocks.ensureReferralProfile.mockResolvedValue(undefined);
    mocks.createReferralRelationshipFromCode.mockResolvedValue({
      linked: true,
    });
    mocks.readReferralCodeFromAuthContext.mockReturnValue("ABC123");
  });

  it("keeps registration successful when referral attribution fails", async () => {
    mocks.createReferralRelationshipFromCode.mockRejectedValueOnce(
      new Error("temporary referral database outage")
    );

    await expect(
      getUserCreateAfterHook()(
        { id: "user-1", email: "user@example.com" },
        { path: "/sign-up/email" }
      )
    ).resolves.toBeUndefined();

    expect(mocks.recordRegistrationIdentity).toHaveBeenCalledWith(
      "user@example.com",
      "user-1"
    );
    expect(mocks.ensureReferralProfile).not.toHaveBeenCalled();
    expect(mocks.createReferralRelationshipFromCode).toHaveBeenCalledWith(
      "user-1",
      "ABC123"
    );
    expect(mocks.logError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        source: "referral-attribution",
        stage: "registration-after-hook",
        userId: "user-1",
      })
    );
  });

  it("records a referral relationship when the attribution projection succeeds", async () => {
    await getUserCreateAfterHook()(
      { id: "user-2", email: "user2@example.com" },
      { path: "/callback/google" }
    );

    expect(mocks.ensureReferralProfile).not.toHaveBeenCalled();
    expect(mocks.readReferralCodeFromAuthContext).toHaveBeenCalledWith({
      path: "/callback/google",
    });
    expect(mocks.createReferralRelationshipFromCode).toHaveBeenCalledWith(
      "user-2",
      "ABC123"
    );
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it("does not create attribution when no referral code is present", async () => {
    mocks.readReferralCodeFromAuthContext.mockReturnValueOnce(null);

    await getUserCreateAfterHook()(
      { id: "user-3", email: "user3@example.com" },
      { path: "/sign-up/email" }
    );

    expect(mocks.createReferralRelationshipFromCode).not.toHaveBeenCalled();
  });
});
