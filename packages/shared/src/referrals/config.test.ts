import { describe, expect, it } from "vitest";
import {
  calculateReferralReward,
  DEFAULT_REFERRAL_REWARD_CONFIG,
  normalizeReferralRewardConfig,
} from "./config";

describe("referral reward config", () => {
  it("calculates percentage and fixed rewards with two decimals", () => {
    expect(
      calculateReferralReward({ mode: "percentage", value: 12.5 }, 80)
    ).toBe(10);
    expect(calculateReferralReward({ mode: "fixed", value: 7.777 }, 80)).toBe(
      7.77
    );
  });

  it("normalizes malformed runtime values to safe defaults", () => {
    expect(normalizeReferralRewardConfig(null)).toEqual(
      DEFAULT_REFERRAL_REWARD_CONFIG
    );
    expect(
      normalizeReferralRewardConfig({
        enabled: true,
        inviter: { mode: "unknown", value: -1 },
        invitee: { mode: "fixed", value: 5 },
      })
    ).toEqual({
      enabled: true,
      inviter: { mode: "percentage", value: 10 },
      invitee: { mode: "fixed", value: 5 },
    });
  });

  it("returns no reward for an invalid first payment amount", () => {
    expect(calculateReferralReward({ mode: "percentage", value: 10 }, 0)).toBe(
      0
    );
  });

  it("keeps zero rewards and clamps each mode to its configured maximum", () => {
    expect(
      normalizeReferralRewardConfig({
        enabled: true,
        inviter: { mode: "percentage", value: 0 },
        invitee: { mode: "fixed", value: 2_000_000 },
      })
    ).toEqual({
      enabled: true,
      inviter: { mode: "percentage", value: 0 },
      invitee: { mode: "fixed", value: 1_000_000 },
    });
  });
});
