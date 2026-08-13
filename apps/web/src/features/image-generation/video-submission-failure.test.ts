/**
 * API 视频创建失败分类测试。
 *
 * 职责：锁定已接受事实、安全终止、账号切换和同账号重试的优先级；不访问网络、
 * 数据库或供应商正文。
 */
import { describe, expect, it } from "vitest";

import {
  classifyLegacyUncertainVideoSnapshot,
  classifyVideoSubmissionFailure,
  sanitizeVideoSubmissionFailureReason,
} from "./video-submission-failure";

describe("video submission failure", () => {
  it.each([
    408, 429, 500, 502, 503, 504,
  ])("HTTP %s 在没有接受事实时重试同一账号", (statusCode) => {
    expect(classifyVideoSubmissionFailure({ statusCode })).toMatchObject({
      action: "retry_same_member",
    });
  });

  it.each([
    [401, "authentication_failed"],
    [403, "permission_denied"],
  ] as const)("HTTP %s 只切换当前任务的账号并保留分类", (statusCode, failureCode) => {
    expect(classifyVideoSubmissionFailure({ statusCode })).toMatchObject({
      action: "switch_member",
      failureCode,
    });
  });

  it("HTTP 409 有任务 ID 时锁定已接受任务，无任务 ID 默认退款", () => {
    expect(
      classifyVideoSubmissionFailure({
        statusCode: 409,
        acceptedTaskId: "upstream-task-1",
      })
    ).toMatchObject({ action: "accepted" });
    expect(classifyVideoSubmissionFailure({ statusCode: 409 })).toMatchObject({
      action: "terminate_and_refund",
      failureCode: "submission_conflict",
    });
  });

  it("受控响应脚本只可把无任务 ID 的 409 改为同账号重试", () => {
    expect(
      classifyVideoSubmissionFailure({
        statusCode: 409,
        scriptedCategory: "upstream",
        scriptedRetryable: true,
      })
    ).toMatchObject({ action: "retry_same_member" });
    expect(
      classifyVideoSubmissionFailure({
        statusCode: 400,
        scriptedCategory: "moderation",
        scriptedRetryable: true,
      })
    ).toMatchObject({
      action: "terminate_and_refund",
      failureCode: "moderation_rejected",
    });
  });

  it.each([
    "invalid_request",
    "moderation",
  ] as const)("%s 明确业务错误直接退款", (scriptedCategory) => {
    expect(
      classifyVideoSubmissionFailure({
        statusCode: 400,
        scriptedCategory,
        scriptedRetryable: true,
      })
    ).toMatchObject({ action: "terminate_and_refund" });
  });

  it("响应读取、解析、缺少任务 ID、超时和网络错误重试同一账号", () => {
    for (const kind of [
      "timeout",
      "network",
      "response_read",
      "response_parse",
      "missing_task_id",
    ] as const) {
      expect(classifyVideoSubmissionFailure({ kind })).toMatchObject({
        action: "retry_same_member",
      });
    }
  });

  it("安全原因移除控制字符和凭据并限制长度", () => {
    const reason = sanitizeVideoSubmissionFailureReason(
      `上游失败\nAuthorization: Bearer secret sk-sensitive ${"x".repeat(2_000)}`
    );
    expect(reason).not.toContain("\n");
    expect(reason).not.toContain("secret");
    expect(reason).not.toContain("sk-sensitive");
    expect(reason.length).toBeLessThanOrEqual(1_000);
  });

  it("遗留不确定任务只有恢复事实完整时才允许自动重试", () => {
    expect(
      classifyLegacyUncertainVideoSnapshot({
        protocol: "api",
        hasBackendMember: true,
        hasAdapterIdentity: true,
        hasModelCapabilitySnapshot: true,
        hasValidInputManifest: true,
        hasStorageBucket: true,
        hasLedgerConsumption: true,
      })
    ).toBe("retrying");
    expect(
      classifyLegacyUncertainVideoSnapshot({
        protocol: "api",
        hasBackendMember: true,
        hasAdapterIdentity: false,
        hasModelCapabilitySnapshot: true,
        hasValidInputManifest: true,
        hasStorageBucket: true,
        hasLedgerConsumption: true,
      })
    ).toBe("refund_invalid_snapshot");
    expect(
      classifyLegacyUncertainVideoSnapshot({
        protocol: "adobe_direct",
        hasBackendMember: true,
        hasAdapterIdentity: false,
        hasModelCapabilitySnapshot: true,
        hasValidInputManifest: true,
        hasStorageBucket: true,
        hasLedgerConsumption: true,
      })
    ).toBe("not_applicable");
  });
});
