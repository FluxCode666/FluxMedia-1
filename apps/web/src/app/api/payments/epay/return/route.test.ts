/**
 * Epay 同步回跳路由测试。
 *
 * 证明历史订阅回钱包、按量充值回订单结果页，并锁定本路由只读取状态而不履约。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  decodeEpayMetadata: vi.fn(),
  getBaseUrl: vi.fn(),
  getEpayOrderMetadata: vi.fn(),
  getEpayOrderStatus: vi.fn(),
  isRuntimeEpayConfigured: vi.fn(),
  parseEpayRequestParams: vi.fn(),
  verifyRuntimeEpayParams: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@repo/shared/config/payment", () => ({
  getBaseUrl: mocks.getBaseUrl,
}));
vi.mock("@repo/shared/logger", () => ({
  logger: { warn: mocks.warn },
}));
vi.mock("@repo/shared/payment/epay", () => ({
  decodeEpayMetadata: mocks.decodeEpayMetadata,
  EPAY_TRADE_SUCCESS: "TRADE_SUCCESS",
  getEpayOrderMetadata: mocks.getEpayOrderMetadata,
  getEpayOrderStatus: mocks.getEpayOrderStatus,
  isRuntimeEpayConfigured: mocks.isRuntimeEpayConfigured,
  parseEpayRequestParams: mocks.parseEpayRequestParams,
  verifyRuntimeEpayParams: mocks.verifyRuntimeEpayParams,
}));

import { GET, POST } from "./route";

/** 创建不携带真实支付参数的测试请求。 */
function createRequest(method: "GET" | "POST" = "GET"): Request {
  return new Request("https://app.example/api/payments/epay/return", {
    method,
  });
}

describe("Epay return route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getBaseUrl.mockReturnValue("https://app.example");
    mocks.isRuntimeEpayConfigured.mockResolvedValue(true);
    mocks.parseEpayRequestParams.mockResolvedValue({ sign: "signed" });
    mocks.verifyRuntimeEpayParams.mockResolvedValue({
      outTradeNo: "historical-subscription-order",
      param: null,
      tradeStatus: "TRADE_SUCCESS",
      verifyStatus: true,
    });
    mocks.decodeEpayMetadata.mockReturnValue({ type: "subscription" });
    mocks.getEpayOrderStatus.mockResolvedValue("success");
  });

  it("历史订阅支付完成后回钱包并展示成功状态", async () => {
    const response = await GET(createRequest());

    expect(response.headers.get("location")).toBe(
      "https://app.example/dashboard/wallet?pay=success"
    );
    expect(mocks.getEpayOrderStatus).toHaveBeenCalledWith(
      "historical-subscription-order"
    );
  });

  it("按量充值保留语言与订单结果页", async () => {
    mocks.decodeEpayMetadata.mockReturnValue({
      locale: "zh",
      paymentOrderId: "order/with spaces",
      type: "credit_purchase",
    });
    mocks.getEpayOrderStatus.mockResolvedValue("fulfilling");

    const response = await POST(createRequest("POST"));

    expect(response.headers.get("location")).toBe(
      "https://app.example/zh/dashboard/credits/payment/order%2Fwith%20spaces?pay=processing"
    );
  });

  it("渠道关闭时直接回钱包失败提示且不读取订单", async () => {
    mocks.isRuntimeEpayConfigured.mockResolvedValue(false);

    const response = await GET(createRequest());

    expect(response.headers.get("location")).toBe(
      "https://app.example/dashboard/wallet?pay=fail"
    );
    expect(mocks.parseEpayRequestParams).not.toHaveBeenCalled();
    expect(mocks.getEpayOrderStatus).not.toHaveBeenCalled();
  });

  it("签名无效时只回钱包失败提示且不读取订单", async () => {
    mocks.verifyRuntimeEpayParams.mockResolvedValue({
      outTradeNo: "forged-order",
      param: null,
      tradeStatus: "TRADE_SUCCESS",
      verifyStatus: false,
    });

    const response = await GET(createRequest());

    expect(response.headers.get("location")).toBe(
      "https://app.example/dashboard/wallet?pay=fail"
    );
    expect(mocks.decodeEpayMetadata).not.toHaveBeenCalled();
    expect(mocks.getEpayOrderMetadata).not.toHaveBeenCalled();
    expect(mocks.getEpayOrderStatus).not.toHaveBeenCalled();
  });
});
