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
  decodeEpayMetadata: vi.fn(),
  getEpayOrderMetadata: vi.fn(),
  dbSelect: vi.fn(),
  confirmPayment: vi.fn(),
  processFulfillment: vi.fn(),
}));

vi.mock("@repo/database", () => ({ db: { select: mocks.dbSelect } }));
vi.mock("@repo/database/schema", () => ({
  creditsBatch: {},
  subscription: {},
  epayOrder: {},
  paymentOrder: {},
}));
vi.mock("@/features/referrals/reward-fulfillment", () => ({
  invokeReferralFirstPayment: vi.fn(),
}));
vi.mock("@/features/payment/payment-lifecycle-service", () => ({
  confirmPaymentAndCreateFulfillmentWorkItem: mocks.confirmPayment,
}));
vi.mock("@/features/payment/payment-fulfillment-service", () => ({
  processPaymentFulfillmentOrder: mocks.processFulfillment,
}));
vi.mock("@repo/shared/payment/epay", async () => {
  const actual = await vi.importActual<
    typeof import("@repo/shared/payment/epay")
  >("@repo/shared/payment/epay");
  return {
    ...actual,
    decodeEpayMetadata: mocks.decodeEpayMetadata,
    getEpayOrderMetadata: mocks.getEpayOrderMetadata,
  };
});

import type { EpayVerifyResult } from "@repo/shared/payment/epay";

import {
  fulfillSuccessfulEpayPayment,
  isExpectedEpayAmount,
} from "./epay-fulfillment";

function verifyInfoWithMoney(
  money: string,
  outTradeNo = "T1",
  overrides: Partial<EpayVerifyResult> = {}
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
    ...overrides,
  };
}

/** 构造积分包 Epay metadata。 */
function creditMetadata(overrides: Record<string, unknown> = {}) {
  return {
    type: "credit_purchase" as const,
    userId: "user-1",
    outTradeNo: "T1",
    paymentOrderId: "order-1",
    packageId: "package-1",
    quantity: 2,
    ...overrides,
  };
}

/** 把 payment_order 查询链配置为返回冻结订单。 */
function mockPaymentOrder(overrides: Record<string, unknown> = {}) {
  const order = {
    id: "order-1",
    userId: "user-1",
    provider: "epay",
    purpose: "credit_package",
    currency: "CNY",
    amount: 20,
    amountMinor: 2000,
    creditsAmount: 300,
    pricingSnapshot: {
      packageId: "package-1",
      quantity: 2,
      currency: "CNY",
      amountMinor: 2000,
      creditsAmount: 300,
      creditsExpiresAt: null,
    },
    providerTradeNo: null,
    ...overrides,
  };
  const limit = vi.fn().mockResolvedValue([order]);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  mocks.dbSelect.mockReturnValue({ from });
  return order;
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
    mocks.decodeEpayMetadata.mockReset();
    mocks.getEpayOrderMetadata.mockReset();
    mocks.dbSelect.mockReset();
    mocks.confirmPayment.mockReset();
    mocks.processFulfillment.mockReset();
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

    expect(mocks.getEpayOrderMetadata).not.toHaveBeenCalled();
  });

  it.each([
    "created",
    "existing",
  ] as const)("确认结果为 %s 时使用真实交易号并处理持久工作项", async (confirmation) => {
    const metadata = creditMetadata();
    mocks.decodeEpayMetadata.mockReturnValue(metadata);
    mockPaymentOrder();
    mocks.confirmPayment.mockResolvedValue(confirmation);
    mocks.processFulfillment.mockResolvedValue({ status: "succeeded" });

    await expect(
      fulfillSuccessfulEpayPayment(
        verifyInfoWithMoney("20.00", "T1", { tradeNo: "gateway-1" }),
        "epay-webhook"
      )
    ).resolves.toEqual({ metadata });

    expect(mocks.confirmPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        providerTradeNo: "gateway-1",
        eventSourceRef: "epay:gateway-1",
        epayOutTradeNo: "T1",
        fulfillment: expect.objectContaining({
          creditSourceRef: "epay:T1",
        }),
      })
    );
    expect(mocks.processFulfillment).toHaveBeenCalledWith("order-1");
  });

  it("部署前订单缺少 creditsExpiresAt 时仍可按原冻结快照履约", async () => {
    const metadata = creditMetadata();
    mocks.decodeEpayMetadata.mockReturnValue(metadata);
    const order = mockPaymentOrder();
    delete (order.pricingSnapshot as Record<string, unknown>).creditsExpiresAt;
    mocks.confirmPayment.mockResolvedValue("created");
    mocks.processFulfillment.mockResolvedValue({ status: "succeeded" });

    await expect(
      fulfillSuccessfulEpayPayment(
        verifyInfoWithMoney("20.00", "T1", { tradeNo: "gateway-1" }),
        "epay-webhook"
      )
    ).resolves.toEqual({ metadata });

    expect(mocks.confirmPayment).toHaveBeenCalledTimes(1);
  });

  it("已完成订单只接受幂等通知且不重复处理工作项", async () => {
    const metadata = creditMetadata();
    mocks.decodeEpayMetadata.mockReturnValue(metadata);
    mockPaymentOrder();
    mocks.confirmPayment.mockResolvedValue("fulfilled");

    await fulfillSuccessfulEpayPayment(
      verifyInfoWithMoney("20.00"),
      "epay-webhook"
    );

    expect(mocks.processFulfillment).not.toHaveBeenCalled();
  });

  it.each([
    {
      title: "metadata 外部订单号",
      metadata: creditMetadata({ outTradeNo: "OTHER" }),
      verifyInfo: verifyInfoWithMoney("20.00"),
    },
    {
      title: "用户",
      metadata: creditMetadata({ userId: "user-2" }),
      verifyInfo: verifyInfoWithMoney("20.00"),
    },
    {
      title: "本地订单 ID",
      metadata: creditMetadata({ paymentOrderId: "order-2" }),
      verifyInfo: verifyInfoWithMoney("20.00"),
      order: { id: "order-1" },
    },
    {
      title: "积分包 metadata",
      metadata: creditMetadata({ packageId: "package-2" }),
      verifyInfo: verifyInfoWithMoney("20.00"),
    },
    {
      title: "数量 metadata",
      metadata: creditMetadata({ quantity: 1 }),
      verifyInfo: verifyInfoWithMoney("20.00"),
    },
    {
      title: "金额",
      metadata: creditMetadata(),
      verifyInfo: verifyInfoWithMoney("19.99"),
    },
    {
      title: "渠道交易号",
      metadata: creditMetadata(),
      verifyInfo: verifyInfoWithMoney("20.00", "T1", { tradeNo: "" }),
    },
    {
      title: "已绑定渠道交易号",
      metadata: creditMetadata(),
      verifyInfo: verifyInfoWithMoney("20.00", "T1", {
        tradeNo: "gateway-new",
      }),
      order: { providerTradeNo: "gateway-original" },
    },
  ])("$title 不匹配时 fail closed", async ({ metadata, verifyInfo, order }) => {
    mocks.decodeEpayMetadata.mockReturnValue(metadata);
    mockPaymentOrder(order);

    await expect(
      fulfillSuccessfulEpayPayment(verifyInfo, "epay-webhook")
    ).rejects.toThrow();

    expect(mocks.confirmPayment).not.toHaveBeenCalled();
    expect(mocks.processFulfillment).not.toHaveBeenCalled();
  });

  it("同一 outTradeNo 的进程内并发只执行一次确认和处理", async () => {
    const metadata = creditMetadata();
    mocks.decodeEpayMetadata.mockReturnValue(metadata);
    mockPaymentOrder();
    let releaseConfirmation: (() => void) | undefined;
    mocks.confirmPayment.mockImplementation(
      () =>
        new Promise<"created">((resolve) => {
          releaseConfirmation = () => resolve("created");
        })
    );
    mocks.processFulfillment.mockResolvedValue({ status: "succeeded" });
    const verifyInfo = verifyInfoWithMoney("20.00");

    const first = fulfillSuccessfulEpayPayment(verifyInfo, "epay-webhook");
    const second = fulfillSuccessfulEpayPayment(verifyInfo, "epay-webhook");
    await vi.waitFor(() =>
      expect(mocks.confirmPayment).toHaveBeenCalledTimes(1)
    );
    releaseConfirmation?.();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { metadata },
      { metadata },
    ]);
    expect(mocks.dbSelect).toHaveBeenCalledTimes(1);
    expect(mocks.processFulfillment).toHaveBeenCalledTimes(1);
  });
});
