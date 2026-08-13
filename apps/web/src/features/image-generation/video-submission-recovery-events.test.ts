/** 视频提交自动恢复日志事件的 DB-free 契约测试。 */

import { describe, expect, it } from "vitest";

import { createVideoSubmissionRecoveryEvent } from "./video-submission-recovery-events";

describe("video submission recovery events", () => {
  it("returns a stable safe event payload", () => {
    expect(
      createVideoSubmissionRecoveryEvent({
        event: "video_submission_attempt_failed",
        videoTaskId: "video-1",
        supplierId: "supplier-1",
        supplierName: "Primary supplier",
        memberId: "member-1",
        model: "veo31",
        protocol: "api",
        requestId: "server-request-1",
        attemptNumber: 1,
        memberAttemptNumber: 1,
        configuredRetryCount: 2,
        maxAttemptsSnapshot: 3,
        httpTimeoutSeconds: 30,
        failureReason: "生成服务请求超时，请稍后重试",
        operationsReason: "上游视频创建请求超时",
        failureCode: "submission_timeout",
      })
    ).toEqual({
      event: "video_submission_attempt_failed",
      videoTaskId: "video-1",
      supplierId: "supplier-1",
      supplierName: "Primary supplier",
      memberId: "member-1",
      model: "veo31",
      protocol: "api",
      requestId: "server-request-1",
      attemptNumber: 1,
      memberAttemptNumber: 1,
      configuredRetryCount: 2,
      maxAttemptsSnapshot: 3,
      httpTimeoutSeconds: 30,
      failureReason: "生成服务请求超时，请稍后重试",
      operationsReason: "上游视频创建请求超时",
      failureCode: "submission_timeout",
    });
  });

  it("rejects missing supplier identity and unknown failure codes", () => {
    expect(() =>
      createVideoSubmissionRecoveryEvent({
        event: "video_submission_attempt_failed",
        videoTaskId: "video-1",
        supplierName: " ",
        requestId: "request-1",
      })
    ).toThrow("供应商名称");
    expect(() =>
      createVideoSubmissionRecoveryEvent({
        event: "video_submission_attempt_failed",
        videoTaskId: "video-1",
        supplierName: "Primary supplier",
        requestId: "request-1",
        failureCode: "unsafe_code" as never,
      })
    ).toThrow("失败代码");
  });

  it("rejects unsafe correlation fields and invalid counters", () => {
    expect(() =>
      createVideoSubmissionRecoveryEvent({
        event: "video_submission_attempt_failed",
        videoTaskId: "video-1",
        supplierName: "Primary supplier",
        requestId: "request-1\nforged",
      })
    ).toThrow("请求标识");
    expect(() =>
      createVideoSubmissionRecoveryEvent({
        event: "video_refund_retry_exhausted",
        videoTaskId: "video-1",
        supplierName: "Primary supplier",
        requestId: "request-1",
        refundAttemptCount: 4,
      })
    ).toThrow("退款尝试次数");
    expect(() =>
      createVideoSubmissionRecoveryEvent({
        event: "video_submission_attempt_failed",
        videoTaskId: "video-1",
        supplierName: "Primary supplier",
        requestId: "request-1",
        configuredRetryCount: 2,
        maxAttemptsSnapshot: 2,
      })
    ).toThrow("重试快照");
  });

  it("rejects URLs and credentials in failure summaries", () => {
    expect(() =>
      createVideoSubmissionRecoveryEvent({
        event: "video_submission_attempt_failed",
        videoTaskId: "video-1",
        supplierName: "Primary supplier",
        requestId: "request-1",
        failureReason: "upstream https://example.test failed",
      })
    ).toThrow("敏感内容");
    expect(() =>
      createVideoSubmissionRecoveryEvent({
        event: "video_submission_attempt_failed",
        videoTaskId: "video-1",
        supplierName: "Primary supplier",
        requestId: "request-1",
        operationsReason: "Authorization=secret",
      })
    ).toThrow("敏感内容");
  });
});
