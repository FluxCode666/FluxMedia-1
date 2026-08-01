/**
 * API 上游脚本失败日志测试。
 *
 * 职责：验证事件只含稳定平台维度与随机请求标识，不携带脚本、正文、凭据、URL
 * 或上游任务 ID；不写真实标准输出。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock("@repo/shared/logger", () => ({
  logger: { error: mocks.error },
}));

import {
  createApiUpstreamRequestId,
  logApiUpstreamScriptFailure,
} from "./api-upstream-observability";

describe("API upstream observability", () => {
  beforeEach(() => {
    mocks.error.mockReset();
  });

  it("生成随机支持请求标识", () => {
    expect(createApiUpstreamRequestId()).toMatch(/^apiu_[a-f0-9]{32}$/);
  });

  it("只记录厂商无关的脱敏脚本失败维度", () => {
    logApiUpstreamScriptFailure({
      operation: "videos.query",
      stage: "response",
      code: "response_script_failed",
      requestSent: true,
      retryAction: "hold_accepted_task",
      requestId: "apiu_0123456789abcdef0123456789abcdef",
      platformModelId: "seedance2",
      taskSummary: "accepted_task",
      observability: { memberId: "member-1", groupId: "group-1" },
    });

    expect(mocks.error).toHaveBeenCalledTimes(1);
    const [context, message] = mocks.error.mock.calls[0] ?? [];
    expect(message).toBe("api_upstream_script_failed");
    expect(context).toEqual({
      event: "api_upstream_script_failed",
      operation: "videos.query",
      stage: "response",
      code: "response_script_failed",
      requestSent: true,
      retryAction: "hold_accepted_task",
      memberId: "member-1",
      groupId: "group-1",
      platformModelId: "seedance2",
      requestId: "apiu_0123456789abcdef0123456789abcdef",
      taskSummary: "accepted_task",
    });
    expect(Object.keys(context ?? {})).not.toEqual(
      expect.arrayContaining([
        "apiKey",
        "authorization",
        "scriptSource",
        "prompt",
        "body",
        "responseBody",
        "taskId",
        "url",
      ])
    );
  });
});
