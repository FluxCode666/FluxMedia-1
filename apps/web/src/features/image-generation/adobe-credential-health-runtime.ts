/**
 * Adobe direct 凭据健康评估运行时。
 *
 * 职责：认领到期成员、在事务外调用 Adobe 双 Profile 健康检查，并在事务内以
 * claim/revision CAS 写入摘要和评估历史。使用方是内部调度器与管理员立即检查；
 * Cookie 只在本模块的短生命周期内读取，永不进入返回值、日志或通知 payload。
 */

import { randomUUID } from "node:crypto";
import { db } from "@repo/database";
import type { FireflyTransport } from "@repo/shared/adobe/firefly-direct";
import { ProxyFireflyTransport } from "@repo/shared/adobe/firefly-direct";
import { logError, logWarn } from "@repo/shared/logger";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { extractExecuteRows } from "@/server/database-result";
import {
  type AdobeCredentialEvaluationSubmission,
  runClaimedAdobeCredentialHealthEvaluation,
} from "./adobe-credential-health";
import {
  type AdobeCredentialClaimCasResult,
  type AdobeCredentialEvaluationSource,
  type AdobeCredentialHealthState,
  acceptAdobeCredentialClaim,
} from "./adobe-credential-health-policy";
import {
  bestEffortDrainAdobeCredentialNotifications,
  openAdobeCredentialIncident,
  resolveAdobeCredentialNotificationTargets,
} from "./adobe-credential-notifications";

const CLAIM_TTL_MS = 10 * 60_000;
const PLATFORM_RETRY_DELAY_MS = 5 * 60_000;
const DEFAULT_BATCH_SIZE = 25;
const MAX_BATCH_SIZE = 100;
const WORKER_COUNT = 4;

const healthRowSchema = z.object({
  member_id: z.string().min(1).max(128),
  member_name: z.string().min(1).max(512),
  member_is_enabled: z.boolean(),
  member_type: z.string().min(1).max(32),
  adobe_mode: z.string().min(1).max(32).nullable(),
  cookie: z.string().min(1).max(64_000).nullable(),
  scope: z.string().nullable(),
  account_user_id: z.string().nullable(),
  status: z.enum(["pending", "healthy", "degraded", "isolated", "overdue"]),
  credential_revision: z.coerce.number().int().positive(),
  member_enable_revision: z.coerce.number().int().positive(),
  consecutive_failures: z.coerce.number().int().nonnegative(),
  failure_profiles: z.unknown(),
  claim_token: z.string().nullable(),
  claim_expires_at: z.coerce.date().nullable(),
  next_check_at: z.coerce.date(),
  evaluation_deadline_at: z.coerce.date().nullable(),
  last_check_at: z.coerce.date().nullable(),
  last_success_at: z.coerce.date().nullable(),
  first_failure_at: z.coerce.date().nullable(),
  last_failure_at: z.coerce.date().nullable(),
  isolated_at: z.coerce.date().nullable(),
  diagnostic: z.unknown().nullable(),
});

type HealthRow = z.infer<typeof healthRowSchema>;

type AdobeHealthClaim = {
  evaluationId: string;
  claimToken: string;
  claimExpiresAt: Date;
  memberId: string;
  memberName: string;
  source: AdobeCredentialEvaluationSource;
  credentialRevision: number;
  memberEnableRevision: number;
  credential: {
    cookie: string;
    scope: string | null;
    expectedAccountUserId: string | null;
  };
  state: AdobeCredentialHealthState;
};

type AdobeHealthEvaluationResult = {
  evaluationId: string;
  disposition: "accepted" | "stale" | "discarded";
  health: ReturnType<typeof toHealthSummary>;
  notificationCreated: boolean;
};

/** 将外部批量上限收敛到单轮可控范围。 */
function normalizeBatchSize(value: number | undefined): number {
  return Math.min(
    MAX_BATCH_SIZE,
    Math.max(1, Math.trunc(value ?? DEFAULT_BATCH_SIZE))
  );
}

/** 为参数化 SQL 的 json 列生成稳定字符串。 */
function jsonValue(value: unknown): string {
  return JSON.stringify(value);
}

/** 从数据库 JSON 中只保留两个受支持的 Profile。 */
function parseFailureProfiles(value: unknown): Array<"express" | "firefly"> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is "express" | "firefly" =>
      item === "express" || item === "firefly"
  );
}

/** 把数据库诊断重新投影为有限字段，不遍历任何嵌套原文。 */
function parseDiagnostic(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.statusCode === "number"
      ? { statusCode: record.statusCode }
      : {}),
    ...(typeof record.adobeErrorCode === "string"
      ? { adobeErrorCode: record.adobeErrorCode }
      : {}),
    ...(typeof record.message === "string" ? { message: record.message } : {}),
    ...(typeof record.requestId === "string"
      ? { requestId: record.requestId }
      : {}),
  };
}

/** 将锁内数据库行转换为纯状态机输入。 */
function toHealthState(row: HealthRow): AdobeCredentialHealthState {
  return {
    status: row.status,
    consecutiveFailures: row.consecutive_failures,
    failureProfiles: parseFailureProfiles(row.failure_profiles),
    nextCheckAt: row.next_check_at,
    lastCheckAt: row.last_check_at,
    lastSuccessAt: row.last_success_at,
    firstFailureAt: row.first_failure_at,
    lastFailureAt: row.last_failure_at,
    isolatedAt: row.isolated_at,
    diagnostic: parseDiagnostic(row.diagnostic),
  };
}

/** 构造不含凭据字段的 UOL 健康摘要。 */
function toHealthSummary(
  memberId: string,
  row: HealthRow | Record<string, unknown>
) {
  const parsed = healthRowSchema.parse({
    ...row,
    member_id: memberId,
    member_name:
      typeof row.member_name === "string" ? row.member_name : "Adobe",
    member_is_enabled:
      typeof row.member_is_enabled === "boolean" ? row.member_is_enabled : true,
    member_type:
      typeof row.member_type === "string" ? row.member_type : "adobe",
    adobe_mode: typeof row.adobe_mode === "string" ? row.adobe_mode : null,
    cookie: typeof row.cookie === "string" ? row.cookie : null,
    scope: typeof row.scope === "string" ? row.scope : null,
    account_user_id:
      typeof row.account_user_id === "string" ? row.account_user_id : null,
  });
  return {
    memberId,
    status: parsed.status,
    consecutiveFailures: parsed.consecutive_failures,
    failureProfiles: parseFailureProfiles(parsed.failure_profiles),
    lastCheckedAt: parsed.last_check_at?.toISOString() ?? null,
    lastSuccessAt: parsed.last_success_at?.toISOString() ?? null,
    nextCheckAt: parsed.next_check_at?.toISOString() ?? null,
    evaluationDeadlineAt: parsed.evaluation_deadline_at?.toISOString() ?? null,
    isolatedAt: parsed.isolated_at?.toISOString() ?? null,
    diagnostic: parseDiagnostic(parsed.diagnostic),
  };
}

/** 构造缺少专用代理时的显式平台失败 transport。 */
function buildUnavailableTransport(): FireflyTransport {
  return {
    async request() {
      throw new Error("Adobe direct proxy is not configured");
    },
  };
}

/** 从部署环境构造 Adobe 健康检查 transport，不暴露代理密钥。 */
function createHealthTransport(): {
  transport: FireflyTransport;
  proxyConfigured: boolean;
} {
  const proxyUrl = process.env.ADOBE_DIRECT_PROXY_URL?.trim().replace(
    /\/+$/,
    ""
  );
  const secret = process.env.ADOBE_DIRECT_PROXY_SECRET?.trim();
  if (!proxyUrl || !secret) {
    return { transport: buildUnavailableTransport(), proxyConfigured: false };
  }
  return {
    transport: new ProxyFireflyTransport({ proxyUrl, secret }),
    proxyConfigured: true,
  };
}

/** 为迁移后新增或旧数据缺失的 direct 成员幂等补齐摘要行。 */
async function ensureAdobeHealthRows(): Promise<void> {
  await db.execute(sql`
    INSERT INTO adobe_credential_health (
      member_id, status, credential_revision, member_enable_revision,
      consecutive_failures, failure_profiles, next_check_at
    )
    SELECT member.id, 'pending', 1, 1, 0, '[]'::json, now()
    FROM image_backend_member AS member
    INNER JOIN image_backend_member_adobe_config AS config
      ON config.member_id = member.id
    WHERE member.type = 'adobe' AND config.mode = 'direct'
    ON CONFLICT (member_id) DO NOTHING
  `);
}

/** 构造单成员原子认领 SQL；批量和手动入口共享同一 claim 互斥。 */
function claimRowQuery(
  now: Date,
  memberId: string | undefined,
  requireDue: boolean
) {
  const token = randomUUID();
  const evaluationId = randomUUID();
  const claimExpiresAt = new Date(now.getTime() + CLAIM_TTL_MS);
  const memberFilter = memberId ? sql`AND member.id = ${memberId}` : sql``;
  const dueFilter = requireDue
    ? sql`AND health.next_check_at <= ${now}`
    : sql``;
  return {
    token,
    evaluationId,
    claimExpiresAt,
    query: sql`
      WITH candidate AS (
        SELECT health.member_id
        FROM adobe_credential_health AS health
        INNER JOIN image_backend_member AS member ON member.id = health.member_id
        INNER JOIN image_backend_member_adobe_config AS config
          ON config.member_id = health.member_id
        WHERE member.type = 'adobe'
          AND member.is_enabled = true
          AND config.mode = 'direct'
          AND config.cookie IS NOT NULL
          ${memberFilter}
          ${dueFilter}
          AND (health.claim_token IS NULL OR health.claim_expires_at <= ${now})
        ORDER BY health.next_check_at, health.member_id
        LIMIT 1
        FOR UPDATE OF health SKIP LOCKED
      ), updated AS (
      UPDATE adobe_credential_health AS health
      SET claim_token = ${token},
          claim_expires_at = ${claimExpiresAt},
          evaluation_deadline_at = ${claimExpiresAt},
          updated_at = ${now}
      FROM candidate
      WHERE health.member_id = candidate.member_id
      RETURNING health.member_id
    )
      SELECT health.member_id,
        health.claim_token, health.claim_expires_at,
        health.credential_revision, health.member_enable_revision,
        health.status, health.consecutive_failures, health.failure_profiles,
        health.next_check_at, health.evaluation_deadline_at,
        health.last_check_at, health.last_success_at, health.first_failure_at,
        health.last_failure_at, health.isolated_at, health.diagnostic,
        member.name AS member_name, member.is_enabled AS member_is_enabled,
        member.type AS member_type, config.mode AS adobe_mode,
        config.cookie, config.scope, config.account_user_id
      FROM updated
      INNER JOIN adobe_credential_health AS health
        ON health.member_id = updated.member_id
      INNER JOIN image_backend_member AS member
        ON member.id = health.member_id
      INNER JOIN image_backend_member_adobe_config AS config
        ON config.member_id = health.member_id
    `,
  };
}

/** 原子认领一个成员并把仅本轮可见的 Cookie 快照带到事务外。 */
async function claimAdobeHealth(
  source: AdobeCredentialEvaluationSource,
  options: { memberId?: string; requireDue: boolean; now?: Date }
): Promise<AdobeHealthClaim | null> {
  const now = options.now ?? new Date();
  return db.transaction(async (transaction) => {
    const candidate = claimRowQuery(now, options.memberId, options.requireDue);
    const rows = extractExecuteRows(await transaction.execute(candidate.query));
    const raw = rows[0];
    if (!raw) return null;
    const row = healthRowSchema.parse(raw);
    if (!row.cookie) return null;
    return {
      evaluationId: candidate.evaluationId,
      claimToken: candidate.token,
      claimExpiresAt: candidate.claimExpiresAt,
      memberId: row.member_id,
      memberName: row.member_name,
      source,
      credentialRevision: row.credential_revision,
      memberEnableRevision: row.member_enable_revision,
      credential: {
        cookie: row.cookie,
        scope: row.scope,
        expectedAccountUserId: row.account_user_id,
      },
      state: toHealthState(row),
    };
  });
}

/** 读取当前成员及健康摘要，供管理员详情和 claim 冲突映射使用。 */
async function loadCurrentHealth(memberId: string): Promise<HealthRow | null> {
  const rows = extractExecuteRows(
    await db.execute(sql`
    SELECT health.member_id,
      member.name AS member_name, member.is_enabled AS member_is_enabled,
      member.type AS member_type, config.mode AS adobe_mode,
      config.cookie, config.scope, config.account_user_id,
      health.status, health.credential_revision, health.member_enable_revision,
      health.consecutive_failures, health.failure_profiles, health.claim_token,
      health.claim_expires_at, health.next_check_at,
      health.evaluation_deadline_at, health.last_check_at,
      health.last_success_at, health.first_failure_at, health.last_failure_at,
      health.isolated_at, health.diagnostic
    FROM adobe_credential_health AS health
    INNER JOIN image_backend_member AS member ON member.id = health.member_id
    INNER JOIN image_backend_member_adobe_config AS config
      ON config.member_id = health.member_id
    WHERE health.member_id = ${memberId}
    LIMIT 1
  `)
  );
  const raw = rows[0];
  return raw ? healthRowSchema.parse(raw) : null;
}

/**
 * 在短事务中提交评估历史、CAS 摘要和可选隔离事件。
 *
 * 旧 claim 只写有限历史，永不覆盖更新后的凭据或启停状态。
 */
async function commitAdobeHealthEvaluation(
  claim: AdobeHealthClaim,
  submission: AdobeCredentialEvaluationSubmission,
  targets: Awaited<ReturnType<typeof resolveAdobeCredentialNotificationTargets>>
): Promise<{
  disposition: "accepted" | "stale" | "discarded";
  notificationCreated: boolean;
  row: HealthRow;
}> {
  return db.transaction(async (transaction) => {
    const rows = extractExecuteRows(
      await transaction.execute(sql`
      SELECT health.member_id,
        member.name AS member_name, member.is_enabled AS member_is_enabled,
        member.type AS member_type, config.mode AS adobe_mode,
        config.cookie, config.scope, config.account_user_id,
        health.status, health.credential_revision, health.member_enable_revision,
        health.consecutive_failures, health.failure_profiles, health.claim_token,
        health.claim_expires_at, health.next_check_at,
        health.evaluation_deadline_at, health.last_check_at,
        health.last_success_at, health.first_failure_at, health.last_failure_at,
        health.isolated_at, health.diagnostic
      FROM adobe_credential_health AS health
      INNER JOIN image_backend_member AS member ON member.id = health.member_id
      LEFT JOIN image_backend_member_adobe_config AS config
        ON config.member_id = health.member_id
      WHERE health.member_id = ${claim.memberId}
      FOR UPDATE OF health
    `)
    );
    const current = rows[0] ? healthRowSchema.parse(rows[0]) : null;
    const cas: AdobeCredentialClaimCasResult = current
      ? acceptAdobeCredentialClaim({
          current: {
            claimToken: current.claim_token,
            claimExpiresAt: current.claim_expires_at,
            credentialRevision: current.credential_revision,
            memberEnableRevision: current.member_enable_revision,
            isEnabled: current.member_is_enabled,
            isDirect:
              current.member_type === "adobe" &&
              current.adobe_mode === "direct",
          },
          expected: submission.expected,
        })
      : {
          accepted: false,
          disposition: "discarded",
          reason: "not_direct",
        };
    const disposition = cas.disposition;
    const existingState = current ? toHealthState(current) : claim.state;
    const nextState = cas.accepted ? submission.nextState : existingState;
    const platformNextCheck =
      cas.accepted && submission.outcome.kind === "platform_failure"
        ? new Date(
            Math.max(
              nextState.nextCheckAt.getTime(),
              submission.expected.completedAt.getTime() +
                PLATFORM_RETRY_DELAY_MS
            )
          )
        : nextState.nextCheckAt;

    await transaction.execute(sql`
      INSERT INTO adobe_credential_evaluation (
        id, claim_token, member_id_snapshot, member_name_snapshot,
        credential_revision, member_enable_revision, source, disposition,
        outcome, failure_profiles, diagnostic, started_at, completed_at
      ) VALUES (
        ${submission.evaluationId}, ${submission.expected.claimToken},
        ${submission.memberId}, ${submission.memberName},
        ${submission.expected.credentialRevision},
        ${submission.expected.memberEnableRevision}, ${submission.source},
        ${disposition}, ${submission.outcome.kind},
        ${jsonValue(submission.outcome.failureProfiles)}::json,
        ${submission.outcome.diagnostic ? jsonValue(submission.outcome.diagnostic) : null}::json,
        ${submission.startedAt}, ${submission.expected.completedAt}
      )
      ON CONFLICT (claim_token) DO NOTHING
    `);

    let notificationCreated = false;
    if (cas.accepted && current) {
      const currentIncident =
        nextState.status === "isolated" &&
        submission.outcome.kind === "member_failure"
          ? await openAdobeCredentialIncident(
              transaction,
              {
                memberId: submission.memberId,
                memberName: submission.memberName,
                consecutiveFailures: nextState.consecutiveFailures,
                failureProfiles: nextState.failureProfiles,
                diagnostic: nextState.diagnostic,
                occurredAt: submission.expected.completedAt,
              },
              targets
            )
          : null;
      notificationCreated = Boolean(currentIncident?.created);
      await transaction.execute(sql`
        UPDATE adobe_credential_health
        SET status = ${nextState.status},
            consecutive_failures = ${nextState.consecutiveFailures},
            failure_profiles = ${jsonValue(nextState.failureProfiles)}::json,
            claim_token = NULL,
            claim_expires_at = NULL,
            evaluation_deadline_at = NULL,
            next_check_at = ${platformNextCheck},
            last_check_at = ${nextState.lastCheckAt},
            last_success_at = ${nextState.lastSuccessAt},
            first_failure_at = ${nextState.firstFailureAt},
            last_failure_at = ${nextState.lastFailureAt},
            isolated_at = ${nextState.isolatedAt},
            diagnostic = ${nextState.diagnostic ? jsonValue(nextState.diagnostic) : null}::json,
            updated_at = ${submission.expected.completedAt}
        WHERE member_id = ${submission.memberId}
          AND claim_token = ${submission.expected.claimToken}
      `);
    }
    const resultRow = current
      ? cas.accepted
        ? {
            ...current,
            ...healthRowFromState(current, nextState, platformNextCheck),
          }
        : current
      : {
          ...syntheticHealthRow(claim, nextState),
        };
    return { disposition, notificationCreated, row: resultRow };
  });
}

/** 把已接受状态映射回数据库行形态，供严格 DTO 返回使用。 */
function healthRowFromState(
  current: HealthRow,
  state: AdobeCredentialHealthState,
  nextCheckAt: Date
): Partial<HealthRow> {
  return {
    status: state.status,
    consecutive_failures: state.consecutiveFailures,
    failure_profiles: state.failureProfiles,
    claim_token: null,
    claim_expires_at: null,
    evaluation_deadline_at: null,
    next_check_at: nextCheckAt,
    last_check_at: state.lastCheckAt,
    last_success_at: state.lastSuccessAt,
    first_failure_at: state.firstFailureAt,
    last_failure_at: state.lastFailureAt,
    isolated_at: state.isolatedAt,
    diagnostic: state.diagnostic,
    member_name: current.member_name,
  };
}

/** 成员在网络调用期间被删除时构造仅用于 discarded 返回的安全摘要。 */
function syntheticHealthRow(
  claim: AdobeHealthClaim,
  state: AdobeCredentialHealthState
): HealthRow {
  return {
    member_id: claim.memberId,
    member_name: claim.memberName,
    member_is_enabled: true,
    member_type: "adobe",
    adobe_mode: "direct",
    cookie: null,
    scope: null,
    account_user_id: null,
    status: state.status,
    credential_revision: claim.credentialRevision,
    member_enable_revision: claim.memberEnableRevision,
    consecutive_failures: state.consecutiveFailures,
    failure_profiles: state.failureProfiles,
    claim_token: null,
    claim_expires_at: null,
    next_check_at: state.nextCheckAt,
    evaluation_deadline_at: null,
    last_check_at: state.lastCheckAt,
    last_success_at: state.lastSuccessAt,
    first_failure_at: state.firstFailureAt,
    last_failure_at: state.lastFailureAt,
    isolated_at: state.isolatedAt,
    diagnostic: state.diagnostic,
  };
}

/** 执行单个 claim 的事务外网络评估，并在提交后立即尝试投递通知。 */
async function evaluateClaim(
  claim: AdobeHealthClaim
): Promise<AdobeHealthEvaluationResult> {
  const targets = await resolveAdobeCredentialNotificationTargets({
    validateWebhookDns: true,
  }).catch(() => {
    logWarn("Adobe credential notification targets are unavailable");
    return [];
  });
  const { transport, proxyConfigured } = createHealthTransport();
  const result = await runClaimedAdobeCredentialHealthEvaluation({
    claim,
    credential: claim.credential,
    state: claim.state,
    transport,
    proxyConfigured,
    commit: async (submission) =>
      commitAdobeHealthEvaluation(claim, submission, targets),
  });
  if (result.commitResult.notificationCreated) {
    await bestEffortDrainAdobeCredentialNotifications();
  }
  return {
    evaluationId: claim.evaluationId,
    disposition: result.commitResult.disposition,
    health: toHealthSummary(claim.memberId, result.commitResult.row),
    notificationCreated: result.commitResult.notificationCreated,
  };
}

/** 认领并处理到期成员，单条失败不会阻断同批其它成员。 */
export async function runAdobeCredentialHealthScan(
  input: { batchSize?: number } = {}
) {
  await ensureAdobeHealthRows();
  const batchSize = normalizeBatchSize(input.batchSize);
  const claims: AdobeHealthClaim[] = [];
  for (let index = 0; index < batchSize; index += 1) {
    const claim = await claimAdobeHealth("scheduled", {
      requireDue: true,
    });
    if (!claim) break;
    claims.push(claim);
  }
  let completed = 0;
  let failed = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < claims.length) {
      const claim = claims[cursor];
      cursor += 1;
      if (!claim) return;
      try {
        await evaluateClaim(claim);
        completed += 1;
      } catch (error) {
        failed += 1;
        logError(error, {
          source: "adobe-credential-health-scan",
          memberId: claim.memberId,
        });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(WORKER_COUNT, claims.length || 1) }, worker)
  );
  return { claimed: claims.length, completed, failed };
}

/** 管理员立即检查指定成员；忽略 nextCheckAt 但仍遵守 claim/CAS。 */
export async function checkAdobeCredentialHealth(
  memberId: string
): Promise<AdobeHealthEvaluationResult> {
  await ensureAdobeHealthRows();
  const claim = await claimAdobeHealth("manual", {
    memberId,
    requireDue: false,
  });
  if (!claim) {
    const current = await loadCurrentHealth(memberId);
    if (!current) throw new Error("Adobe direct 成员不存在");
    if (!current.member_is_enabled) throw new Error("Adobe 成员已停用");
    throw new Error("Adobe 凭据正在检查中，请稍后重试");
  }
  return evaluateClaim(claim);
}

/** 读取管理员可见的健康摘要，不返回 Cookie、Token 或上游原文。 */
export async function getAdobeCredentialHealth(memberId: string) {
  await ensureAdobeHealthRows();
  const current = await loadCurrentHealth(memberId);
  if (!current) throw new Error("Adobe direct 成员不存在");
  return toHealthSummary(memberId, current);
}
