/**
 * 账号删除视频输入生命周期测试。
 *
 * 职责：证明账号失效前必须先经 UOL 登记同一 per-user 幂等清理请求，登记失败时
 * 调用方会收到异常并停止后续删除流程。
 */
import { describe, expect, it, vi } from "vitest";

import { requestVideoInputCleanupBeforeAccountDeletion } from "./delete-account-lifecycle";

describe("delete account video input lifecycle", () => {
  it("初始化 UOL 后以当前 user Principal 登记稳定幂等请求", async () => {
    const ensureInitialized = vi.fn(async () => undefined);
    const getRole = vi.fn(async () => "user" as const);
    const invoke = vi.fn(async () => ({ status: "queued" }));

    await requestVideoInputCleanupBeforeAccountDeletion("user-1", {
      ensureInitialized,
      getRole,
      invoke,
    });

    expect(ensureInitialized).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith(
      "video.requestAccountInputCleanup",
      { clientRequestId: "delete-account-video-inputs-v1" },
      { type: "user", userId: "user-1", role: "user" }
    );
    expect(
      ensureInitialized.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
    ).toBeLessThan(
      invoke.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
    );
  });

  it("清理意图登记失败时原样抛出以阻止账号失效", async () => {
    const failure = new Error("cleanup unavailable");

    await expect(
      requestVideoInputCleanupBeforeAccountDeletion("user-1", {
        ensureInitialized: vi.fn(async () => undefined),
        getRole: vi.fn(async () => "user" as const),
        invoke: vi.fn(async () => {
          throw failure;
        }),
      })
    ).rejects.toBe(failure);
  });
});
