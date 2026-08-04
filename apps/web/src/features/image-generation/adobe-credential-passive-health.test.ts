/**
 * Adobe direct 被动凭据健康触发器测试。
 *
 * 职责：确保真实调用发现鉴权异常时立即触发双 Profile 评估，同时证明额度耗尽不会
 * 被误判为凭据故障；测试通过注入端口运行，不访问 Adobe 或数据库。
 */
import { describe, expect, it, vi } from "vitest";

import { synchronizeAdobeCredentialHealthAfterRuntimeStatus } from "./adobe-credential-passive-health";

describe("Adobe 被动凭据健康触发", () => {
  it.each([
    "error",
    "invalid",
  ] as const)("%s 状态触发一次账号级双 Profile 评估", async (status) => {
    const evaluate = vi.fn(async () => undefined);

    await synchronizeAdobeCredentialHealthAfterRuntimeStatus(
      { memberId: "member-1", status },
      { evaluate, reportFailure: vi.fn() }
    );

    expect(evaluate).toHaveBeenCalledOnce();
    expect(evaluate).toHaveBeenCalledWith("member-1");
  });

  it("额度耗尽只属于可用额度状态，不触发凭据健康评估", async () => {
    const evaluate = vi.fn(async () => undefined);

    await synchronizeAdobeCredentialHealthAfterRuntimeStatus(
      { memberId: "member-1", status: "exhausted" },
      { evaluate, reportFailure: vi.fn() }
    );

    expect(evaluate).not.toHaveBeenCalled();
  });

  it("被动评估失败时记录错误但不覆盖原调用错误", async () => {
    const failure = new Error("health evaluation failed");
    const reportFailure = vi.fn();

    await expect(
      synchronizeAdobeCredentialHealthAfterRuntimeStatus(
        { memberId: "member-1", status: "invalid" },
        {
          evaluate: vi.fn(async () => {
            throw failure;
          }),
          reportFailure,
        }
      )
    ).resolves.toBeUndefined();
    expect(reportFailure).toHaveBeenCalledWith(failure, "member-1");
  });
});
