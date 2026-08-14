/**
 * Epay webhook 薄适配路由测试。
 *
 * 使用方：Vitest；验证配置、验签和事件过滤留在传输层，成功履约只经 UOL 调用。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isRuntimeEpayConfigured: vi.fn(),
  parseEpayRequestParams: vi.fn(),
  verifyRuntimeEpayParams: vi.fn(),
  invokeOperation: vi.fn(),
  ensureUolInitialized: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@repo/shared/api-logger", () => ({
  withApiLogging: <T>(handler: T): T => handler,
}));
vi.mock("@repo/shared/payment/epay", () => ({
  EPAY_TRADE_SUCCESS: "TRADE_SUCCESS",
  isRuntimeEpayConfigured: mocks.isRuntimeEpayConfigured,
  parseEpayRequestParams: mocks.parseEpayRequestParams,
  verifyRuntimeEpayParams: mocks.verifyRuntimeEpayParams,
}));
vi.mock("@repo/shared/uol", () => ({
  invokeOperation: mocks.invokeOperation,
}));
vi.mock("@repo/shared/logger", () => ({
  logger: { info: mocks.loggerInfo, warn: mocks.loggerWarn },
  logError: mocks.logError,
}));
vi.mock("@/server/uol-init", () => ({
  ensureUolInitialized: mocks.ensureUolInitialized,
}));

import { POST } from "./route";

const verifyInfo = {
  verifyStatus: true,
  type: "alipay",
  tradeNo: "gateway-1",
  outTradeNo: "order-1",
  name: "credits",
  money: "20.00",
  tradeStatus: "TRADE_SUCCESS",
  param: "signed-metadata",
  raw: { sign: "secret" },
};

/** 创建 Epay webhook POST 请求。 */
function request(): Request {
  return new Request("https://media.example.test/api/webhooks/epay", {
    method: "POST",
    body: "signed-payload",
  });
}

describe("POST /api/webhooks/epay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isRuntimeEpayConfigured.mockResolvedValue(true);
    mocks.parseEpayRequestParams.mockResolvedValue({ sign: "secret" });
    mocks.verifyRuntimeEpayParams.mockResolvedValue(verifyInfo);
    mocks.invokeOperation.mockResolvedValue({
      metadataType: "credit_purchase",
    });
  });

  it("成功通知只把规范化字段交给匹配 provider 的 UOL operation", async () => {
    const response = await POST(request());

    expect(await response.text()).toBe("success");
    expect(mocks.ensureUolInitialized).toHaveBeenCalledTimes(1);
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      "credits.fulfillEpayTopUp",
      {
        type: "alipay",
        tradeNo: "gateway-1",
        outTradeNo: "order-1",
        name: "credits",
        money: "20.00",
        tradeStatus: "TRADE_SUCCESS",
        param: "signed-metadata",
      },
      { type: "webhook", provider: "epay" }
    );
  });

  it("非法签名和非成功事件不会初始化或调用 UOL", async () => {
    mocks.verifyRuntimeEpayParams.mockResolvedValueOnce({
      ...verifyInfo,
      verifyStatus: false,
    });
    expect(await (await POST(request())).text()).toBe("fail");

    mocks.verifyRuntimeEpayParams.mockResolvedValueOnce({
      ...verifyInfo,
      tradeStatus: "WAIT_BUYER_PAY",
    });
    expect(await (await POST(request())).text()).toBe("success");

    expect(mocks.ensureUolInitialized).not.toHaveBeenCalled();
    expect(mocks.invokeOperation).not.toHaveBeenCalled();
  });

  it("UOL 履约失败返回 fail 以便网关重试", async () => {
    mocks.invokeOperation.mockRejectedValueOnce(new Error("fulfill failed"));

    const response = await POST(request());

    expect(await response.text()).toBe("fail");
    expect(mocks.logError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        source: "epay-webhook",
        outTradeNo: "order-1",
      })
    );
  });
});
