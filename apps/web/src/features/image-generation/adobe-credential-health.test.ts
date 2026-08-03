/**
 * Adobe direct 双 Profile 健康评估器的 DB-free 回归测试。
 *
 * 职责：证明评估不发起媒体请求、不向提交边界泄露 Cookie/Token，并把一整轮
 * Express/Firefly 结果通过 claim 与 revision 快照提交一次。
 */

import type {
  FireflyTransport,
  FireflyTransportRequest,
  FireflyTransportResponse,
} from "@repo/shared/adobe/firefly-direct";
import { describe, expect, it, vi } from "vitest";
import {
  type AdobeCredentialEvaluationSubmission,
  evaluateAdobeCredentialProfiles,
  runClaimedAdobeCredentialHealthEvaluation,
} from "./adobe-credential-health";

function makeToken(payload: Record<string, unknown>): string {
  return `${Buffer.from("{}").toString("base64url")}.${Buffer.from(
    JSON.stringify(payload)
  ).toString("base64url")}.sig`;
}

function response(status: number, body: unknown): FireflyTransportResponse {
  const bytes = Buffer.from(JSON.stringify(body), "utf-8");
  return {
    status,
    headers: { "x-request-id": "req-safe" },
    bytes: async () => bytes,
    text: async () => bytes.toString("utf-8"),
    json: async () => body,
  };
}

class ProfileTransport implements FireflyTransport {
  readonly calls: FireflyTransportRequest[] = [];

  constructor(
    private readonly identities: {
      express: string;
      firefly: string;
    },
    private readonly failingProfile?: "express" | "firefly"
  ) {}

  async request(
    request: FireflyTransportRequest
  ): Promise<FireflyTransportResponse> {
    this.calls.push(request);
    if (request.url.includes("check/v6/token")) {
      const body = new URLSearchParams(String(request.body));
      const profile =
        body.get("client_id") === "projectx_webapp" ? "express" : "firefly";
      if (profile === this.failingProfile) {
        return response(401, {
          error: "invalid_token",
          access_token: "must-not-leak",
        });
      }
      const clientId =
        profile === "express" ? "projectx_webapp" : "clio-playground-web";
      return response(200, {
        access_token: makeToken({
          client_id: clientId,
          user_id: this.identities[profile],
          sub: this.identities[profile],
        }),
        expires_in: 3600,
      });
    }
    const authorization = request.headers.Authorization ?? "";
    const payload = authorization.split(".")[1];
    const claims = payload
      ? (JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as {
          client_id?: string;
        })
      : {};
    const profile =
      claims.client_id === "projectx_webapp" ? "express" : "firefly";
    return response(200, {
      userId: this.identities[profile],
      displayName: "Operator",
      email: "operator@example.com",
    });
  }
}

describe("Adobe 双 Profile 健康评估", () => {
  it("两个 Profile 都成功时只返回一次成员成功且不发起媒体请求", async () => {
    const transport = new ProfileTransport({
      express: "adobe-user-1",
      firefly: "adobe-user-1",
    });

    const result = await evaluateAdobeCredentialProfiles({
      transport,
      cookie: "aux_sid=secret-cookie",
      expectedAccountUserId: "adobe-user-1",
    });

    expect(result).toEqual({
      outcome: { kind: "success", failureProfiles: [], diagnostic: null },
      profiles: [
        { profile: "express", ok: true },
        { profile: "firefly", ok: true },
      ],
    });
    expect(transport.calls).toHaveLength(4);
    expect(
      transport.calls.every(
        (call) =>
          call.url.includes("/ims/check/v6/token") ||
          call.url.includes("/ims/profile/v1")
      )
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret-cookie");
    expect(JSON.stringify(result)).not.toContain("eyJ");
  });

  it("任一 Profile 失败时整轮只产生一次成员失败", async () => {
    const transport = new ProfileTransport(
      { express: "adobe-user-1", firefly: "adobe-user-1" },
      "express"
    );

    const result = await evaluateAdobeCredentialProfiles({
      transport,
      cookie: "aux_sid=secret-cookie",
      expectedAccountUserId: "adobe-user-1",
    });

    expect(result.outcome).toMatchObject({
      kind: "member_failure",
      failureProfiles: ["express"],
    });
    expect(result.profiles).toEqual([
      expect.objectContaining({
        profile: "express",
        ok: false,
        category: "auth_rejected",
      }),
      { profile: "firefly", ok: true },
    ]);
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });

  it("双 Profile 稳定账号不一致时 fail-closed", async () => {
    const transport = new ProfileTransport({
      express: "adobe-user-1",
      firefly: "adobe-user-2",
    });

    const result = await evaluateAdobeCredentialProfiles({
      transport,
      cookie: "aux_sid=secret-cookie",
      expectedAccountUserId: null,
    });

    expect(result.outcome).toMatchObject({
      kind: "member_failure",
      failureProfiles: ["express", "firefly"],
    });
    expect(result.profiles.every((profile) => !profile.ok)).toBe(true);
  });

  it("事务外完成网络评估后只向提交边界传递 claim/revision 和脱敏结果", async () => {
    const events: string[] = [];
    const submissions: AdobeCredentialEvaluationSubmission[] = [];
    const transport = new ProfileTransport({
      express: "adobe-user-1",
      firefly: "adobe-user-1",
    });
    const request = vi
      .spyOn(transport, "request")
      .mockImplementation(async (input) => {
        events.push("network");
        return ProfileTransport.prototype.request.call(transport, input);
      });
    const commit = vi.fn(
      async (submission: AdobeCredentialEvaluationSubmission) => {
        events.push("commit");
        submissions.push(submission);
        return { disposition: "accepted" as const };
      }
    );

    await runClaimedAdobeCredentialHealthEvaluation({
      claim: {
        evaluationId: "evaluation-1",
        claimToken: "claim-1",
        memberId: "member-1",
        memberName: "Adobe A",
        source: "manual",
        credentialRevision: 7,
        memberEnableRevision: 9,
      },
      credential: {
        cookie: "aux_sid=secret-cookie",
        scope: null,
        expectedAccountUserId: "adobe-user-1",
      },
      state: {
        status: "healthy",
        consecutiveFailures: 0,
        failureProfiles: [],
        nextCheckAt: new Date("2026-08-04T00:00:00.000Z"),
        lastCheckAt: null,
        lastSuccessAt: null,
        firstFailureAt: null,
        lastFailureAt: null,
        isolatedAt: null,
        diagnostic: null,
      },
      transport,
      now: () => new Date("2026-08-04T00:00:10.000Z"),
      commit,
    });

    expect(request).toHaveBeenCalled();
    expect(events.at(-1)).toBe("commit");
    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({
        expected: {
          claimToken: "claim-1",
          credentialRevision: 7,
          memberEnableRevision: 9,
          completedAt: new Date("2026-08-04T00:00:10.000Z"),
        },
        source: "manual",
        outcome: expect.objectContaining({ kind: "success" }),
      })
    );
    const serialized = JSON.stringify(submissions[0]);
    expect(serialized).not.toContain("secret-cookie");
    expect(serialized).not.toContain("access_token");
  });
});
