/**
 * Next.js 请求代理契约测试。
 *
 * 覆盖根级推广短链必须绕过 next-intl 的行为，避免 `/r/:code` 被补上语言前缀后落到 404。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { intlMiddleware } = vi.hoisted(() => ({
  intlMiddleware: vi.fn(),
}));

vi.mock("@repo/shared/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  createRateLimitResponse: vi.fn(),
  getClientIp: vi.fn(),
  getRateLimitHeaders: vi.fn(),
}));

vi.mock("@/i18n/routing", () => ({
  routing: { locales: ["en", "zh"], defaultLocale: "en" },
}));

vi.mock("next-intl/middleware", () => ({
  default: vi.fn(() => intlMiddleware),
}));

import { NextRequest } from "next/server";
import { proxy } from "./proxy";

describe("proxy referral short links", () => {
  beforeEach(() => {
    intlMiddleware.mockReset();
  });

  it("lets /r/:code reach its root-level route handler without locale rewriting", async () => {
    const response = await proxy(
      new NextRequest("https://media.example.test/r/ABC123")
    );

    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(intlMiddleware).not.toHaveBeenCalled();
  });
});
