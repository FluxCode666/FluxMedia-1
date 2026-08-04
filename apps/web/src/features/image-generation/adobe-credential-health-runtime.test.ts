/**
 * Adobe 凭据健康运行时的 DB-free 回归测试。
 *
 * 职责：验证 claim 后才在事务外评估、缺少代理属于平台失败且不会推进成员失败计数，
 * 并确认提交 SQL 只携带安全摘要而不包含 Cookie。
 */

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  transactionResponses: [] as Array<unknown | ((query: unknown) => unknown)>,
  queries: [] as SQL[],
  claimToken: "",
  resolveTargets: vi.fn(async () => []),
  openIncident: vi.fn(async () => ({
    incidentId: "incident-1",
    created: true,
  })),
  drain: vi.fn(async () => undefined),
}));

const database = vi.hoisted(() => ({
  execute: vi.fn(async () => []),
  transaction: vi.fn(
    async (
      work: (transaction: {
        execute(query: SQL): Promise<unknown>;
      }) => Promise<unknown>
    ) =>
      work({
        async execute(query) {
          runtime.queries.push(query);
          const response = runtime.transactionResponses.shift();
          return typeof response === "function"
            ? response(query)
            : (response ?? []);
        },
      })
  ),
}));

vi.mock("@repo/database", () => ({ db: database }));

vi.mock("./adobe-credential-notifications", () => ({
  resolveAdobeCredentialNotificationTargets: runtime.resolveTargets,
  openAdobeCredentialIncident: runtime.openIncident,
  bestEffortDrainAdobeCredentialNotifications: runtime.drain,
}));

import {
  checkAdobeCredentialHealthPassively,
  runAdobeCredentialHealthScan,
} from "./adobe-credential-health-runtime";

const NOW = new Date("2026-08-04T00:00:00.000Z");

/** 构造 claim 或提交查询返回的完整数据库行。 */
function healthRow(overrides: Record<string, unknown> = {}) {
  return {
    member_id: "member-1",
    member_name: "Adobe A",
    member_is_enabled: true,
    member_type: "adobe",
    adobe_mode: "direct",
    cookie: "aux_sid=secret-cookie",
    scope: null,
    account_user_id: "adobe-user-1",
    status: "healthy",
    credential_revision: 3,
    member_enable_revision: 4,
    consecutive_failures: 0,
    failure_profiles: [],
    claim_token: "claim-token",
    claim_expires_at: new Date(NOW.getTime() + 10 * 60_000),
    next_check_at: NOW,
    evaluation_deadline_at: new Date(NOW.getTime() + 10 * 60_000),
    last_check_at: NOW,
    last_success_at: NOW,
    first_failure_at: null,
    last_failure_at: null,
    isolated_at: null,
    diagnostic: null,
    ...overrides,
  };
}

describe("Adobe 凭据健康运行时", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv("ADOBE_DIRECT_PROXY_URL", "");
    vi.stubEnv("ADOBE_DIRECT_PROXY_SECRET", "");
    runtime.transactionResponses.length = 0;
    runtime.queries.length = 0;
    runtime.claimToken = "";
    runtime.resolveTargets.mockClear();
    runtime.openIncident.mockClear();
    runtime.drain.mockClear();
    database.execute.mockClear();
    database.transaction.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("代理未配置时记录平台失败并延后五分钟，不推进成员失败计数", async () => {
    runtime.transactionResponses.push(
      (query: unknown) => {
        const compiled = new PgDialect().sqlToQuery(query as SQL);
        runtime.claimToken =
          compiled.params.find(
            (value): value is string =>
              typeof value === "string" &&
              /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value)
          ) ?? "";
        return [healthRow({ claim_token: runtime.claimToken })];
      },
      () => [healthRow({ claim_token: runtime.claimToken })],
      [],
      []
    );

    await expect(
      runAdobeCredentialHealthScan({ batchSize: 1 })
    ).resolves.toEqual({ claimed: 1, completed: 1, failed: 0 });

    expect(database.execute).toHaveBeenCalledTimes(1);
    expect(database.transaction).toHaveBeenCalledTimes(2);
    expect(runtime.resolveTargets).toHaveBeenCalledOnce();
    expect(runtime.openIncident).not.toHaveBeenCalled();
    expect(runtime.drain).not.toHaveBeenCalled();

    const compiled = runtime.queries.map((query) =>
      new PgDialect().sqlToQuery(query)
    );
    const evaluationInsert = compiled.find((query) =>
      query.sql.includes("INSERT INTO adobe_credential_evaluation")
    );
    expect(evaluationInsert?.params).toContain("platform_failure");
    const healthUpdate = compiled.find((query) =>
      query.sql.includes("SET status =")
    );
    expect(
      healthUpdate?.params.some(
        (value) =>
          value instanceof Date &&
          value.getTime() === new Date("2026-08-04T00:05:00.000Z").getTime()
      )
    ).toBe(true);
    expect(JSON.stringify(compiled)).not.toContain("secret-cookie");
  });

  it("真实调用触发的评估以 passive 来源写入同一健康状态机", async () => {
    runtime.transactionResponses.push(
      (query: unknown) => {
        const compiled = new PgDialect().sqlToQuery(query as SQL);
        runtime.claimToken =
          compiled.params.find(
            (value): value is string =>
              typeof value === "string" &&
              /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value)
          ) ?? "";
        return [healthRow({ claim_token: runtime.claimToken })];
      },
      () => [healthRow({ claim_token: runtime.claimToken })],
      [],
      []
    );

    await expect(
      checkAdobeCredentialHealthPassively("member-1")
    ).resolves.toMatchObject({ disposition: "accepted" });

    const compiled = runtime.queries.map((query) =>
      new PgDialect().sqlToQuery(query)
    );
    const evaluationInsert = compiled.find((query) =>
      query.sql.includes("INSERT INTO adobe_credential_evaluation")
    );
    expect(evaluationInsert?.params).toContain("passive");
  });
});
