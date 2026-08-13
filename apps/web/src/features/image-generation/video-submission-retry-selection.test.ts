/**
 * 视频创建重试账号选择策略测试。
 *
 * 使用方：Vitest；锁定同账号重试粘性与切号后容量等待恢复时的账号排除，不连接
 * 数据库、账号池或供应商。
 */
import { describe, expect, it } from "vitest";

import { resolveVideoSubmissionRetryAccountSelection } from "./video-submission-retry-selection";

describe("video submission retry account selection", () => {
  it("首次提交不注入账号重试约束", () => {
    expect(
      resolveVideoSubmissionRetryAccountSelection({
        isSubmissionRetry: false,
        backendMemberId: null,
        apiAdapterMemberId: null,
        apiAdapterVersionId: null,
        attemptedMemberIds: ["member-a"],
      })
    ).toEqual({});
  });

  it("已绑定账号的重试固定使用该账号", () => {
    expect(
      resolveVideoSubmissionRetryAccountSelection({
        isSubmissionRetry: true,
        backendMemberId: "member-b",
        apiAdapterMemberId: "member-b",
        apiAdapterVersionId: "version-b",
        attemptedMemberIds: ["member-a", "member-b"],
      })
    ).toEqual({
      requiredMemberId: "member-b",
      requiredMemberType: "api",
      requiredApiAdapterMemberId: "member-b",
      requiredApiAdapterVersionId: "version-b",
    });
  });

  it("同账号重试缺少固定适配版本时拒绝继续外呼", () => {
    expect(() =>
      resolveVideoSubmissionRetryAccountSelection({
        isSubmissionRetry: true,
        backendMemberId: "member-b",
        apiAdapterMemberId: "member-b",
        apiAdapterVersionId: null,
        attemptedMemberIds: ["member-b"],
      })
    ).toThrow("API 视频同账号重试缺少固定适配版本");
  });

  it("切号后容量等待恢复时排除已实际外呼的账号", () => {
    expect(
      resolveVideoSubmissionRetryAccountSelection({
        isSubmissionRetry: true,
        backendMemberId: null,
        apiAdapterMemberId: null,
        apiAdapterVersionId: null,
        attemptedMemberIds: ["member-a", "member-a"],
      })
    ).toEqual({
      excludedMemberIds: ["member-a"],
      requiredMemberType: "api",
    });
  });
});
