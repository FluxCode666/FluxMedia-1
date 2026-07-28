/**
 * Adobe 接受前鉴权重试策略的 DB-free 回归测试。
 *
 * 锁定明确 401/403 只刷新并重试一次，且网络错误与刷新失败不会盲目重投。
 */

import { AuthError } from "@repo/shared/adobe/firefly-direct";
import { describe, expect, it, vi } from "vitest";

import { runAdobeBeforeAcceptanceWithAuthRetry } from "./adobe-auth-retry";

describe("Adobe 接受前鉴权重试", () => {
  it("明确鉴权失败后使用刷新 Token 重试一次", async () => {
    const run = vi
      .fn<(token: string) => Promise<string>>()
      .mockRejectedValueOnce(new AuthError("expired", { statusCode: 401 }))
      .mockResolvedValueOnce("accepted");
    const refresh = vi.fn(async () => "firefly-token-b");

    await expect(
      runAdobeBeforeAcceptanceWithAuthRetry({
        token: "firefly-token-a",
        retryEnabled: true,
        run,
        refresh,
      })
    ).resolves.toEqual({ ok: true, value: "accepted" });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls).toEqual([["firefly-token-a"], ["firefly-token-b"]]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("第二次鉴权失败后停止，不进行第三次请求", async () => {
    const secondError = new AuthError("still expired", { statusCode: 403 });
    const run = vi
      .fn<(token: string) => Promise<string>>()
      .mockRejectedValueOnce(new AuthError("expired", { statusCode: 401 }))
      .mockRejectedValueOnce(secondError);

    await expect(
      runAdobeBeforeAcceptanceWithAuthRetry({
        token: "token-a",
        retryEnabled: true,
        run,
        refresh: async () => "token-b",
      })
    ).resolves.toMatchObject({
      ok: false,
      error: secondError,
      rejectedToken: "token-b",
      refreshFailed: false,
    });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("网络错误不刷新也不重投", async () => {
    const run = vi.fn(async () => {
      throw new Error("network uncertain");
    });
    const refresh = vi.fn(async () => "token-b");

    await expect(
      runAdobeBeforeAcceptanceWithAuthRetry({
        token: "token-a",
        retryEnabled: true,
        run,
        refresh,
      })
    ).resolves.toMatchObject({ ok: false, refreshFailed: false });
    expect(run).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });
});
