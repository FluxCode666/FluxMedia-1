import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logError: vi.fn(),
}));

vi.mock("@repo/shared/logger", () => ({
  logError: mocks.logError,
}));

import {
  isInternalDatabaseError,
  isSensitiveUpstreamError,
  toClientErrorMessage,
} from "./error-sanitize";

beforeEach(() => {
  mocks.logError.mockReset();
});

// Drizzle 池查询失败的真实形态（issue #35）：message 以 "Failed query:" 开头。
function drizzleError(): Error {
  return new Error(
    'Failed query: select "media_backend_member"."credential" ' +
      'from "media_backend_member" ... params: true,true,active'
  );
}

// node-postgres 原始错误：带 5 位 SQLSTATE code（42703=undefined_column）。
function pgError(code = "42703"): Error {
  const e = new Error("column does not exist");
  (e as Error & { code: string }).code = code;
  return e;
}

describe("isInternalDatabaseError", () => {
  it("识别 Drizzle Failed query 与 Postgres SQLSTATE/severity", () => {
    expect(isInternalDatabaseError(drizzleError())).toBe(true);
    expect(isInternalDatabaseError(pgError("42703"))).toBe(true);
    expect(isInternalDatabaseError(pgError("57P01"))).toBe(true);
    const sev = new Error("db down");
    (sev as Error & { severity: string }).severity = "FATAL";
    expect(isInternalDatabaseError(sev)).toBe(true);
  });

  it("放行已知用户级错误与非 DB 错误", () => {
    expect(isInternalDatabaseError(new Error("Insufficient credits"))).toBe(
      false
    );
    expect(isInternalDatabaseError(new Error("分组无可用后端"))).toBe(false);
    // Node 系统错误码（非 5 位 SQLSTATE）不应误判。
    const enoent = new Error("ENOENT");
    (enoent as Error & { code: string }).code = "ENOENT";
    expect(isInternalDatabaseError(enoent)).toBe(false);
    expect(isInternalDatabaseError("plain string")).toBe(false);
    expect(isInternalDatabaseError(null)).toBe(false);
  });

  it("识别可能回显供应商或凭据细节的上游错误", () => {
    expect(
      isSensitiveUpstreamError(
        new Error(
          "Upstream Images API returned HTTP 401: invalid API key sk-secret"
        )
      )
    ).toBe(true);
    expect(
      isSensitiveUpstreamError(
        "Upstream Images API failed: https://upstream.example.test/v1"
      )
    ).toBe(true);
    expect(isSensitiveUpstreamError("Insufficient credits")).toBe(false);
    expect(isSensitiveUpstreamError("Invalid image size")).toBe(false);
  });
});

describe("toClientErrorMessage", () => {
  const ctx = { source: "test", generationId: "g1" };

  it("DB/内部错误回 fallback（不暴露裸 SQL）", () => {
    const msg = toClientErrorMessage(drizzleError(), ctx, "请稍后重试");
    expect(msg).toBe("请稍后重试");
    expect(msg).not.toContain("Failed query");
    expect(msg).not.toContain("api_key");
    expect(toClientErrorMessage(pgError(), ctx, "请稍后重试")).toBe(
      "请稍后重试"
    );
    const loggedError = mocks.logError.mock.calls[0]?.[0];
    expect(loggedError).toBeInstanceOf(Error);
    expect((loggedError as Error).message).toBe(
      "Image generation database failure redacted before client response"
    );
    expect((loggedError as Error).message).not.toContain("Failed query");
    expect((loggedError as Error).message).not.toContain("api_key");
  });

  it("用户级错误原样透传", () => {
    expect(
      toClientErrorMessage(new Error("Insufficient credits"), ctx, "fallback")
    ).toBe("Insufficient credits");
  });

  it("上游错误改为 fallback，不回显令牌或上游地址", () => {
    const msg = toClientErrorMessage(
      "Upstream Images API returned HTTP 401: Bearer sk-secret https://upstream.example.test/v1",
      ctx,
      "图片服务暂时不可用，请稍后重试"
    );

    expect(msg).toBe("图片服务暂时不可用，请稍后重试");
    expect(msg).not.toContain("sk-secret");
    expect(msg).not.toContain("upstream.example.test");
  });

  it("用户级字符串错误可从正常结果中透传", () => {
    expect(toClientErrorMessage("boom", ctx, "fallback")).toBe("boom");
  });

  it("既非 Error 也非字符串时回 fallback", () => {
    expect(toClientErrorMessage({ message: "boom" }, ctx, "fallback")).toBe(
      "fallback"
    );
  });
});
