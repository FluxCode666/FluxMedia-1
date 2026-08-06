/**
 * `/v1/models` 外接 API 处理器的单元测试。
 *
 * 使用方：Vitest；验证传输层只构造 API Key Principal 并委托 UOL，保持模型列表
 * 的供应商可用性判断集中在统一接口层。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockOperationError extends Error {
    code: string;
    httpStatus: number;

    constructor(code: string, message: string, httpStatus: number) {
      super(message);
      this.name = "OperationError";
      this.code = code;
      this.httpStatus = httpStatus;
    }
  }

  return {
    MockOperationError,
    authenticateExternalApiRequest: vi.fn(),
    ensureUolInitialized: vi.fn(),
    invokeOperation: vi.fn(),
  };
});

vi.mock("@repo/shared/api-logger", () => ({
  withApiLogging: <T>(handler: T) => handler,
}));

vi.mock("@repo/shared/uol", () => ({
  invokeOperation: mocks.invokeOperation,
  OperationError: mocks.MockOperationError,
}));

vi.mock("@/features/external-api/auth", () => ({
  authenticateExternalApiRequest: mocks.authenticateExternalApiRequest,
}));

vi.mock("@/server/uol-init", () => ({
  ensureUolInitialized: mocks.ensureUolInitialized,
}));

/** 创建已携带 Bearer API Key 的模型列表请求。 */
function modelsRequest(): Request {
  return new Request("https://example.test/v1/models", {
    headers: { Authorization: "Bearer test-key" },
  });
}

describe("external models handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateExternalApiRequest.mockResolvedValue({
      userId: "user_1",
      apiKeyId: "key_1",
    });
    mocks.ensureUolInitialized.mockResolvedValue(undefined);
    mocks.invokeOperation.mockResolvedValue({
      object: "list",
      data: [
        {
          id: "grok-imagine-image",
          object: "model",
          created: 0,
          owned_by: "gpt2image",
        },
      ],
    });
  });

  it("通过 UOL 获取当前 API Key 可见的供应商模型", async () => {
    const { getExternalModels } = await import("./models");

    const response = await getExternalModels(modelsRequest() as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      object: "list",
      data: [
        {
          id: "grok-imagine-image",
          object: "model",
          created: 0,
          owned_by: "gpt2image",
        },
      ],
    });
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      "externalApi.getModels",
      {},
      {
        type: "apiKey",
        credentialKind: "external",
        userId: "user_1",
        apiKeyId: "key_1",
      }
    );
  });

  it("将 UOL 权限拒绝保持为 OpenAI 兼容的 403 响应", async () => {
    const { getExternalModels } = await import("./models");
    mocks.invokeOperation.mockRejectedValue(
      new mocks.MockOperationError(
        "forbidden",
        "External API model listing is forbidden.",
        403
      )
    );

    const response = await getExternalModels(modelsRequest() as never);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        message: "External API model listing is forbidden.",
        type: "invalid_request_error",
        code: "forbidden",
      },
    });
  });
});
