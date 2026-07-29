/**
 * 网站动态 Logo 公共路由测试。
 *
 * 职责：验证路由只通过 UOL 读取配置、正确解析站内/HTTPS 地址并在失败时回退。
 * 使用方：Web Vitest；所有系统设置、UOL 与日志依赖均使用桩。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureUolInitialized: vi.fn(),
  invokeOperation: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@repo/shared/logger", () => ({ logError: mocks.logError }));
vi.mock("@repo/shared/uol", () => ({
  invokeOperation: mocks.invokeOperation,
}));
vi.mock("@/server/uol-init", () => ({
  ensureUolInitialized: mocks.ensureUolInitialized,
}));

import { GET } from "./route";

/**
 * 构造固定第一方来源的 Logo 请求。
 *
 * @returns 不访问网络的标准 Request 测试对象。
 * @sideEffects 无。
 */
function createRequest(): Request {
  return new Request("https://media.example.com/api/site-logo");
}

describe("GET /api/site-logo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureUolInitialized.mockResolvedValue(undefined);
    mocks.invokeOperation.mockResolvedValue({
      logoUrl: "/assets/icon.svg",
    });
  });

  it("通过 system-only UOL 保留站内 Logo 相对路径", async () => {
    const response = await GET(createRequest());

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/assets/icon.svg");
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      "settings.getSiteBranding",
      {},
      { type: "system", reason: "public-site-logo" },
      { requestId: expect.any(String) }
    );
  });

  it("站内 Logo 重定向不泄露反向代理内部来源", async () => {
    const response = await GET(
      new Request("https://0.0.0.0:3000/api/site-logo", {
        headers: {
          "x-forwarded-host": "media.example.com",
          "x-forwarded-proto": "https",
        },
      })
    );

    expect(response.headers.get("location")).toBe("/assets/icon.svg");
  });

  it("编码站内 Logo 路径中的非 ASCII 字符并保持相对地址", async () => {
    mocks.invokeOperation.mockResolvedValue({
      logoUrl: "/assets/品牌 标识.svg?v=中文#片段",
    });

    const response = await GET(createRequest());

    expect(response.headers.get("location")).toBe(
      "/assets/%E5%93%81%E7%89%8C%20%E6%A0%87%E8%AF%86.svg?v=%E4%B8%AD%E6%96%87#%E7%89%87%E6%AE%B5"
    );
  });

  it("保留管理员配置的 HTTPS Logo 地址", async () => {
    mocks.invokeOperation.mockResolvedValue({
      logoUrl: "https://cdn.example.com/brand/logo.webp",
    });

    const response = await GET(createRequest());

    expect(response.headers.get("location")).toBe(
      "https://cdn.example.com/brand/logo.webp"
    );
  });

  it("UOL 初始化或读取失败时记录异常并回退内置 Logo", async () => {
    const error = new Error("database unavailable");
    mocks.invokeOperation.mockRejectedValue(error);

    const response = await GET(createRequest());

    expect(response.headers.get("location")).toBe("/assets/icon.svg");
    expect(mocks.logError).toHaveBeenCalledWith(error, {
      source: "site-logo-route",
    });
  });
});
