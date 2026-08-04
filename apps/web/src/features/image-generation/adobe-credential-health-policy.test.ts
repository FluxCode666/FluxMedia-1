/**
 * Adobe direct 成员健康策略的 DB-free 回归测试。
 *
 * 职责：锁定失败分类、5/15 分钟复检、第三次隔离、严格诊断 allowlist 和
 * claim/CAS 版本保护；测试不执行 Adobe 网络请求或数据库写入。
 */
import { QuotaExhaustedError } from "@repo/shared/adobe/firefly-direct";
import { describe, expect, it } from "vitest";

import {
  type AdobeCredentialHealthState,
  acceptAdobeCredentialClaim,
  claimAdobeCredentialHealth,
  classifyAdobeCredentialFailure,
  reduceAdobeCredentialHealth,
  sanitizeAdobeCredentialDiagnostic,
} from "./adobe-credential-health-policy";

const now = new Date("2026-08-04T00:00:00.000Z");

function state(
  overrides: Partial<AdobeCredentialHealthState> = {}
): AdobeCredentialHealthState {
  return {
    status: "healthy",
    consecutiveFailures: 0,
    failureProfiles: [],
    nextCheckAt: now,
    lastCheckAt: null,
    lastSuccessAt: null,
    firstFailureAt: null,
    lastFailureAt: null,
    isolatedAt: null,
    diagnostic: null,
    ...overrides,
  };
}

describe("Adobe 凭据健康状态机", () => {
  it("双 Profile 成功只产生一次成功并安排 45 分钟检查", () => {
    const result = reduceAdobeCredentialHealth({
      state: state(),
      now,
      outcome: {
        kind: "success",
        failureProfiles: [],
        diagnostic: null,
      },
    });

    expect(result).toMatchObject({
      status: "healthy",
      consecutiveFailures: 0,
      failureProfiles: [],
      nextCheckAt: new Date("2026-08-04T00:45:00.000Z"),
    });
  });

  it("第一次、第二次、第三次成员失败分别安排 5 分钟、15 分钟和隔离", () => {
    const first = reduceAdobeCredentialHealth({
      state: state(),
      now,
      outcome: {
        kind: "member_failure",
        failureProfiles: ["express"],
        diagnostic: { statusCode: 401, adobeErrorCode: "invalid_token" },
      },
    });
    expect(first).toMatchObject({
      status: "degraded",
      consecutiveFailures: 1,
      nextCheckAt: new Date("2026-08-04T00:05:00.000Z"),
    });

    const second = reduceAdobeCredentialHealth({
      state: first,
      now: new Date("2026-08-04T00:05:00.000Z"),
      outcome: {
        kind: "member_failure",
        failureProfiles: ["firefly"],
        diagnostic: { statusCode: 429 },
      },
    });
    expect(second).toMatchObject({
      status: "degraded",
      consecutiveFailures: 2,
      nextCheckAt: new Date("2026-08-04T00:20:00.000Z"),
    });

    const third = reduceAdobeCredentialHealth({
      state: second,
      now: new Date("2026-08-04T00:20:00.000Z"),
      outcome: {
        kind: "member_failure",
        failureProfiles: ["express", "firefly"],
        diagnostic: { statusCode: 503 },
      },
    });
    expect(third).toMatchObject({
      status: "isolated",
      consecutiveFailures: 3,
      isolatedAt: new Date("2026-08-04T00:20:00.000Z"),
      nextCheckAt: new Date("2026-08-04T01:05:00.000Z"),
    });
  });

  it("隔离后的普通成功只更新诊断和下次检查，不自动恢复", () => {
    const isolatedAt = new Date("2026-08-03T23:00:00.000Z");
    const result = reduceAdobeCredentialHealth({
      state: state({
        status: "isolated",
        consecutiveFailures: 3,
        isolatedAt,
      }),
      now,
      outcome: { kind: "success", failureProfiles: [], diagnostic: null },
    });
    expect(result).toMatchObject({
      status: "isolated",
      consecutiveFailures: 3,
      isolatedAt,
      nextCheckAt: new Date("2026-08-04T00:45:00.000Z"),
    });
  });

  it("平台故障不推进成员失败计数", () => {
    const result = reduceAdobeCredentialHealth({
      state: state(),
      now,
      outcome: {
        kind: "platform_failure",
        failureProfiles: [],
        diagnostic: null,
      },
    });
    expect(result).toEqual(state());
  });
});

describe("Adobe 凭据失败分类", () => {
  it("把 Adobe 拒绝、超时、限流和代理网络故障归为成员故障", () => {
    expect(classifyAdobeCredentialFailure(new Error("HTTP 401"))).toMatchObject(
      {
        kind: "member_failure",
        category: "auth_rejected",
      }
    );
    expect(
      classifyAdobeCredentialFailure(new Error("Adobe request timeout"))
    ).toMatchObject({ kind: "member_failure", category: "timeout" });
    expect(classifyAdobeCredentialFailure(new Error("HTTP 429"))).toMatchObject(
      {
        kind: "member_failure",
        category: "rate_limited",
      }
    );
    expect(
      classifyAdobeCredentialFailure(new Error("proxy connection reset"), {
        proxyConfigured: true,
      })
    ).toMatchObject({ kind: "member_failure", category: "proxy_network" });
  });

  it("未配置代理是平台故障，不推进成员失败", () => {
    expect(
      classifyAdobeCredentialFailure(new Error("proxy is not configured"), {
        proxyConfigured: false,
      })
    ).toMatchObject({
      kind: "platform_failure",
      category: "proxy_not_configured",
    });
  });

  it("额度耗尽不属于凭据故障，不推进连续失败计数", () => {
    const failure = classifyAdobeCredentialFailure(
      new QuotaExhaustedError("Adobe quota exhausted", {
        statusCode: 429,
        adobeErrorCode: "taste_exhausted",
      })
    );
    expect(failure).toMatchObject({
      kind: "platform_failure",
      category: "quota_exhausted",
    });
    expect(
      reduceAdobeCredentialHealth({
        state: state(),
        now,
        outcome: {
          kind: failure.kind,
          failureProfiles: [],
          diagnostic: failure.diagnostic,
        },
      })
    ).toEqual(state());
  });
});

describe("Adobe 诊断 allowlist 和 claim CAS", () => {
  it("只保留有限字段并移除疑似凭据内容", () => {
    expect(
      sanitizeAdobeCredentialDiagnostic({
        statusCode: 401,
        adobeErrorCode: "invalid_token",
        message: "Authorization: Bearer secret-token",
        requestId: "req-1",
        cookie: "aux_sid=secret-cookie",
        raw: { access_token: "secret-token" },
      })
    ).toEqual({
      statusCode: 401,
      adobeErrorCode: "invalid_token",
      requestId: "req-1",
    });
    expect(
      sanitizeAdobeCredentialDiagnostic({
        statusCode: 500,
        message: '{"nested":{"access_token":"secret-token"}}',
      })
    ).toEqual({ statusCode: 500 });
    expect(
      sanitizeAdobeCredentialDiagnostic({
        message: "YWNjZXNzX3Rva2VuPXNlY3JldA==",
      })
    ).toBeNull();
  });

  it("claim、credential revision 或启用 revision 不匹配时拒绝旧结果", () => {
    const base = {
      claimToken: "claim-a",
      credentialRevision: 3,
      memberEnableRevision: 4,
      isEnabled: true,
    };
    expect(
      acceptAdobeCredentialClaim({
        current: base,
        expected: {
          claimToken: "claim-b",
          credentialRevision: 3,
          memberEnableRevision: 4,
        },
      })
    ).toEqual({
      accepted: false,
      disposition: "stale",
      reason: "claim_mismatch",
    });
    expect(
      acceptAdobeCredentialClaim({
        current: base,
        expected: {
          claimToken: "claim-a",
          credentialRevision: 2,
          memberEnableRevision: 4,
        },
      })
    ).toEqual({
      accepted: false,
      disposition: "discarded",
      reason: "credential_revision_mismatch",
    });
    expect(
      acceptAdobeCredentialClaim({
        current: { ...base, claimToken: null, isEnabled: false },
        expected: {
          claimToken: "claim-a",
          credentialRevision: 3,
          memberEnableRevision: 4,
        },
      })
    ).toEqual({
      accepted: false,
      disposition: "discarded",
      reason: "member_disabled",
    });
    expect(
      acceptAdobeCredentialClaim({
        current: base,
        expected: {
          claimToken: "claim-a",
          credentialRevision: 3,
          memberEnableRevision: 4,
        },
      })
    ).toEqual({ accepted: true, disposition: "accepted" });
  });

  it("未过期 claim 互斥，超时后新 claim 可重领且旧结果变为 stale", () => {
    expect(
      claimAdobeCredentialHealth({
        current: {
          claimToken: "claim-a",
          claimExpiresAt: new Date("2026-08-04T00:01:00.000Z"),
          credentialRevision: 3,
          memberEnableRevision: 4,
          isEnabled: true,
          isDirect: true,
          nextCheckAt: now,
        },
        now,
        claimToken: "claim-b",
        claimTtlMs: 60_000,
      })
    ).toEqual({ claimed: false, reason: "already_claimed" });

    const reclaimed = claimAdobeCredentialHealth({
      current: {
        claimToken: "claim-a",
        claimExpiresAt: new Date("2026-08-03T23:59:59.000Z"),
        credentialRevision: 3,
        memberEnableRevision: 4,
        isEnabled: true,
        isDirect: true,
        nextCheckAt: now,
      },
      now,
      claimToken: "claim-b",
      claimTtlMs: 60_000,
    });
    expect(reclaimed).toEqual({
      claimed: true,
      claimToken: "claim-b",
      claimExpiresAt: new Date("2026-08-04T00:01:00.000Z"),
      credentialRevision: 3,
      memberEnableRevision: 4,
    });
    expect(
      acceptAdobeCredentialClaim({
        current: {
          claimToken: "claim-b",
          credentialRevision: 3,
          memberEnableRevision: 4,
          isEnabled: true,
        },
        expected: {
          claimToken: "claim-a",
          credentialRevision: 3,
          memberEnableRevision: 4,
        },
      })
    ).toMatchObject({
      accepted: false,
      disposition: "stale",
      reason: "claim_mismatch",
    });
  });
});
