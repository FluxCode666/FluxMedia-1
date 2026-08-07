/**
 * Epay 履约金额门闩（isExpectedEpayAmount）回归测试。
 *
 * isExpectedEpayAmount 把订单期望金额与网关回传金额都换算为分，要求实付不低于
 * 期望且不超出期望 10 分（容忍上游四舍五入/手续费的轻微多付）。它是阻止
 * 低价/篡改金额套取高额积分订单的反欺诈门闩，容忍区间或比较方向被误改会静默放行。
 *
 * 该模块顶层 import 了大量 DB 耦合依赖；被测纯函数与之无关，故 mock
 * @repo/database / @repo/database/schema 使模块在 DB-free vitest 下加载即可。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimEpayOrderForFulfillment: vi.fn(),
  decodeEpayMetadata: vi.fn(),
  getEpayOrderMetadata: vi.fn(),
  updateEpayOrderStatus: vi.fn(),
}));

vi.mock("@repo/database", () => ({ db: {} }));
vi.mock("@repo/database/schema", () => ({
  creditsBatch: {},
  subscription: {},
  epayOrder: {},
}));
vi.mock("@/features/referrals/reward-fulfillment", () => ({
  invokeReferralFirstPayment: vi.fn(),
}));
vi.mock("@repo/shared/payment/epay", async () => {
  const actual = await vi.importActual<
    typeof import("@repo/shared/payment/epay")
  >("@repo/shared/payment/epay");
  return {
    ...actual,
    claimEpayOrderForFulfillment: mocks.claimEpayOrderForFulfillment,
    decodeEpayMetadata: mocks.decodeEpayMetadata,
    getEpayOrderMetadata: mocks.getEpayOrderMetadata,
    updateEpayOrderStatus: mocks.updateEpayOrderStatus,
  };
});

import type { EpayVerifyResult } from "@repo/shared/payment/epay";

import {
  fulfillSuccessfulEpayPayment,
  isExpectedEpayAmount,
} from "./epay-fulfillment";

function verifyInfoWithMoney(
  money: string,
  outTradeNo = "T1"
): EpayVerifyResult {
  return {
    verifyStatus: true,
    type: "alipay",
    tradeNo: "G1",
    outTradeNo,
    name: "credits",
    money,
    tradeStatus: "TRADE_SUCCESS",
    raw: {},
  };
}

describe("isExpectedEpayAmount", () => {
  it("accepts an exact match", () => {
    expect(isExpectedEpayAmount(verifyInfoWithMoney("10.00"), 10)).toBe(true);
  });

  it("accepts overpayment within the 10-cent tolerance", () => {
    expect(isExpectedEpayAmount(verifyInfoWithMoney("10.10"), 10)).toBe(true);
    expect(isExpectedEpayAmount(verifyInfoWithMoney("10.01"), 10)).toBe(true);
  });

  it("rejects underpayment", () => {
    expect(isExpectedEpayAmount(verifyInfoWithMoney("9.99"), 10)).toBe(false);
  });

  it("rejects overpayment beyond the tolerance", () => {
    expect(isExpectedEpayAmount(verifyInfoWithMoney("10.11"), 10)).toBe(false);
  });

  it("rejects when the paid amount fails to parse", () => {
    expect(isExpectedEpayAmount(verifyInfoWithMoney("abc"), 10)).toBe(false);
    expect(isExpectedEpayAmount(verifyInfoWithMoney(""), 10)).toBe(false);
  });

  it("rejects when the expected amount fails to parse", () => {
    expect(isExpectedEpayAmount(verifyInfoWithMoney("10.00"), Number.NaN)).toBe(
      false
    );
  });
});

describe("fulfillSuccessfulEpayPayment", () => {
  beforeEach(() => {
    mocks.claimEpayOrderForFulfillment.mockReset();
    mocks.decodeEpayMetadata.mockReset();
    mocks.getEpayOrderMetadata.mockReset();
    mocks.updateEpayOrderStatus.mockReset();
  });

  it("忽略历史订阅 metadata 且不领取或更新订单", async () => {
    const metadata = {
      type: "subscription" as const,
      userId: "user-1",
      outTradeNo: "SUB-1",
      planId: "pro",
    };
    mocks.decodeEpayMetadata.mockReturnValue(metadata);

    await expect(
      fulfillSuccessfulEpayPayment(
        verifyInfoWithMoney("20.00", "SUB-1"),
        "epay-webhook"
      )
    ).resolves.toEqual({ metadata });

    expect(mocks.claimEpayOrderForFulfillment).not.toHaveBeenCalled();
    expect(mocks.getEpayOrderMetadata).not.toHaveBeenCalled();
    expect(mocks.updateEpayOrderStatus).not.toHaveBeenCalled();
  });
});
