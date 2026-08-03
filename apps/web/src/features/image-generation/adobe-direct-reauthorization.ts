/**
 * Adobe direct 同账号重新授权服务。
 *
 * 职责：在事务外验证新 Cookie 的 Express/Firefly 身份，在事务内以成员锁、
 * credential revision 和稳定 clientRequestId 原子更新凭据、清除隔离、关闭 incident
 * 并创建恢复通知。使用方仅为 human-only 管理员 UOL operation。
 */

import { createHash, randomUUID } from "node:crypto";
import { db } from "@repo/database";
import { normalizeCookieString } from "@repo/shared/adobe/firefly-direct";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { extractExecuteRows } from "@/server/database-result";
import { evaluateAdobeCredentialProfiles } from "./adobe-credential-health";
import { getAdobeCredentialHealth } from "./adobe-credential-health-runtime";
import {
  bestEffortDrainAdobeCredentialNotifications,
  closeAdobeCredentialIncident,
  resolveAdobeCredentialNotificationTargets,
} from "./adobe-credential-notifications";
import {
  buildAdobeDirectApiTransport,
  prepareAdobeDirectCredential,
} from "./adobe-direct";

const NORMAL_CHECK_DELAY_MS = 45 * 60_000;

const memberSnapshotSchema = z.object({
  member_id: z.string().min(1).max(128),
  member_name: z.string().min(1).max(512),
  is_enabled: z.boolean(),
  mode: z.string().min(1).max(32),
  scope: z.string().nullable(),
  account_user_id: z.string().min(1).max(512).nullable(),
  credential_revision: z.coerce.number().int().positive(),
  member_enable_revision: z.coerce.number().int().positive(),
});

const priorEvaluationSchema = z.object({
  id: z.string().min(1).max(128),
  disposition: z.enum(["accepted", "stale", "discarded"]),
});

/** 可稳定映射到 UOL 的重新授权错误。 */
export class AdobeCredentialReauthorizationError extends Error {
  /** 创建不包含 Cookie、Token 或 Adobe 原始响应的领域错误。 */
  constructor(
    readonly code: "not_found" | "conflict" | "validation_error",
    message: string
  ) {
    super(message);
    this.name = "AdobeCredentialReauthorizationError";
  }
}

/** 从 clientRequestId 和管理员身份生成不可逆、成员内稳定的幂等 claim。 */
function buildReauthorizationClaimToken(input: {
  actorUserId: string;
  memberId: string;
  clientRequestId: string;
}): string {
  return `reauth:${createHash("sha256")
    .update(
      JSON.stringify([
        input.actorUserId,
        input.memberId,
        input.clientRequestId,
      ]),
      "utf8"
    )
    .digest("hex")}`;
}

/** 读取并锁定前使用的 direct 成员身份与 revision 快照。 */
async function loadMemberSnapshot(memberId: string) {
  const rows = extractExecuteRows(
    await db.execute(sql`
    SELECT member.id AS member_id, member.name AS member_name,
      member.is_enabled, config.mode, config.scope, config.account_user_id,
      health.credential_revision, health.member_enable_revision
    FROM image_backend_member AS member
    INNER JOIN image_backend_member_adobe_config AS config
      ON config.member_id = member.id
    INNER JOIN adobe_credential_health AS health
      ON health.member_id = member.id
    WHERE member.id = ${memberId} AND member.type = 'adobe'
    LIMIT 1
  `)
  );
  const row = rows[0];
  if (!row) {
    throw new AdobeCredentialReauthorizationError(
      "not_found",
      "Adobe direct 成员不存在"
    );
  }
  const snapshot = memberSnapshotSchema.parse(row);
  if (snapshot.mode !== "direct") {
    throw new AdobeCredentialReauthorizationError(
      "validation_error",
      "只有 Adobe direct 成员可以重新授权"
    );
  }
  if (!snapshot.account_user_id) {
    throw new AdobeCredentialReauthorizationError(
      "validation_error",
      "成员缺少可验证的稳定 Adobe 账号 ID，请新建成员或执行明确账号替换"
    );
  }
  return snapshot;
}

/** 查询已完成的同一重新授权请求，供网络前快速幂等返回。 */
async function loadPriorEvaluation(claimToken: string) {
  const rows = extractExecuteRows(
    await db.execute(sql`
    SELECT id, disposition
    FROM adobe_credential_evaluation
    WHERE claim_token = ${claimToken} AND source = 'reauthorization'
    LIMIT 1
  `)
  );
  const row = rows[0];
  return row ? priorEvaluationSchema.parse(row) : null;
}

/**
 * 验证新 Cookie 的双 Profile 和旧账号一致性。
 *
 * @returns 可持久化的 Express 凭据快照；Firefly 短期 Token 按需重新刷新。
 * @throws 任一 Profile、访客/client ID、稳定账号或代理校验失败时返回安全领域错误。
 */
async function verifyReplacementCookie(input: {
  cookie: string;
  scope: string | null;
  expectedAccountUserId: string;
}) {
  try {
    const transport = await buildAdobeDirectApiTransport();
    const evaluation = await evaluateAdobeCredentialProfiles({
      transport,
      cookie: input.cookie,
      expectedAccountUserId: input.expectedAccountUserId,
      scope: input.scope,
      proxyConfigured: true,
    });
    if (evaluation.outcome.kind !== "success") {
      throw new AdobeCredentialReauthorizationError(
        "validation_error",
        "新 Cookie 未通过 Express 与 Firefly 同账号验证"
      );
    }
    const prepared = await prepareAdobeDirectCredential(
      input.cookie,
      input.scope ?? undefined
    );
    if (prepared.accountUserId !== input.expectedAccountUserId) {
      throw new AdobeCredentialReauthorizationError(
        "validation_error",
        "新 Cookie 不属于当前 Adobe 账号，请新建成员或执行明确账号替换"
      );
    }
    return prepared;
  } catch (error) {
    if (error instanceof AdobeCredentialReauthorizationError) throw error;
    throw new AdobeCredentialReauthorizationError(
      "validation_error",
      "Adobe 重新授权验证失败，请确认 Cookie、专用代理和账号状态"
    );
  }
}

/**
 * 为现有 direct 成员执行同账号重新授权。
 *
 * @param input 管理员身份、成员、新 Cookie 和每管理员幂等请求 ID。
 * @returns 稳定 evaluation ID、accepted disposition 与恢复后的安全摘要。
 * @sideEffects 发起 Adobe 身份/余额请求；成功后更新数据库并 best-effort 投递恢复通知。
 */
export async function reauthorizeAdobeCredential(input: {
  actorUserId: string;
  memberId: string;
  cookie: string;
  clientRequestId: string;
}) {
  const normalizedCookie = normalizeCookieString(input.cookie);
  if (!normalizedCookie || normalizedCookie.length > 64_000) {
    throw new AdobeCredentialReauthorizationError(
      "validation_error",
      "Adobe Cookie 导入内容无效"
    );
  }
  await getAdobeCredentialHealth(input.memberId);
  const claimToken = buildReauthorizationClaimToken(input);
  const prior = await loadPriorEvaluation(claimToken);
  if (prior) {
    return {
      evaluationId: prior.id,
      disposition: prior.disposition,
      health: await getAdobeCredentialHealth(input.memberId),
    };
  }

  const snapshot = await loadMemberSnapshot(input.memberId);
  const startedAt = new Date();
  const prepared = await verifyReplacementCookie({
    cookie: normalizedCookie,
    scope: snapshot.scope,
    expectedAccountUserId: snapshot.account_user_id as string,
  });
  const completedAt = new Date();
  const targets = await resolveAdobeCredentialNotificationTargets({
    validateWebhookDns: true,
  }).catch(() => []);
  const evaluationId = randomUUID();
  const nextCheckAt = new Date(completedAt.getTime() + NORMAL_CHECK_DELAY_MS);

  const transactionResult = await db.transaction(async (transaction) => {
    const lockedRows = extractExecuteRows(
      await transaction.execute(sql`
      SELECT member.id AS member_id, member.name AS member_name,
        member.is_enabled, config.mode, config.scope, config.account_user_id,
        health.credential_revision, health.member_enable_revision
      FROM image_backend_member AS member
      INNER JOIN image_backend_member_adobe_config AS config
        ON config.member_id = member.id
      INNER JOIN adobe_credential_health AS health
        ON health.member_id = member.id
      WHERE member.id = ${input.memberId} AND member.type = 'adobe'
      FOR UPDATE OF member, config, health
    `)
    );
    const lockedRaw = lockedRows[0];
    if (!lockedRaw) {
      throw new AdobeCredentialReauthorizationError(
        "not_found",
        "Adobe direct 成员不存在"
      );
    }
    const locked = memberSnapshotSchema.parse(lockedRaw);
    const existingRows = extractExecuteRows(
      await transaction.execute(sql`
      SELECT id, disposition
      FROM adobe_credential_evaluation
      WHERE claim_token = ${claimToken} AND source = 'reauthorization'
      LIMIT 1
    `)
    );
    if (existingRows[0]) {
      return {
        evaluation: priorEvaluationSchema.parse(existingRows[0]),
        notificationCreated: false,
      };
    }
    if (
      locked.mode !== "direct" ||
      locked.account_user_id !== snapshot.account_user_id ||
      locked.credential_revision !== snapshot.credential_revision
    ) {
      throw new AdobeCredentialReauthorizationError(
        "conflict",
        "成员凭据在验证期间已变化，请重新发起授权"
      );
    }

    await transaction.execute(sql`
      UPDATE image_backend_member_adobe_config
      SET cookie = ${normalizedCookie},
          access_token = ${prepared.accessToken},
          account_user_id = ${snapshot.account_user_id},
          display_name = ${prepared.displayName},
          email = ${prepared.email},
          credential_status = 'active',
          token_expires_at = ${prepared.expiresAt},
          token_fails = 0,
          last_refresh_at = ${completedAt},
          last_refresh_error = NULL,
          next_refresh_at = NULL,
          consecutive_failures = 0,
          firefly_access_token = NULL,
          firefly_token_expires_at = NULL,
          firefly_credential_status = NULL,
          firefly_token_fails = 0,
          firefly_last_refresh_at = NULL,
          firefly_last_refresh_error = NULL,
          firefly_next_refresh_at = NULL,
          firefly_consecutive_failures = 0,
          credits_total = ${prepared.creditsTotal},
          credits_used = ${prepared.creditsUsed},
          credits_available = ${prepared.creditsAvailable},
          credits_updated_at = ${prepared.creditsUpdatedAt},
          credits_error = ${prepared.creditsError},
          updated_at = ${completedAt}
      WHERE member_id = ${input.memberId} AND mode = 'direct'
    `);
    await transaction.execute(sql`
      UPDATE adobe_credential_health
      SET status = 'healthy',
          credential_revision = credential_revision + 1,
          consecutive_failures = 0,
          failure_profiles = '[]'::json,
          claim_token = NULL,
          claim_expires_at = NULL,
          evaluation_deadline_at = NULL,
          next_check_at = ${nextCheckAt},
          last_check_at = ${completedAt},
          last_success_at = ${completedAt},
          first_failure_at = NULL,
          last_failure_at = NULL,
          isolated_at = NULL,
          diagnostic = NULL,
          updated_at = ${completedAt}
      WHERE member_id = ${input.memberId}
        AND credential_revision = ${snapshot.credential_revision}
    `);
    await transaction.execute(sql`
      INSERT INTO adobe_credential_evaluation (
        id, claim_token, member_id_snapshot, member_name_snapshot,
        credential_revision, member_enable_revision, source, disposition,
        outcome, failure_profiles, diagnostic, started_at, completed_at
      ) VALUES (
        ${evaluationId}, ${claimToken}, ${input.memberId}, ${locked.member_name},
        ${snapshot.credential_revision + 1}, ${locked.member_enable_revision},
        'reauthorization', 'accepted', 'success', '[]'::json, NULL,
        ${startedAt}, ${completedAt}
      )
    `);
    const closed = await closeAdobeCredentialIncident(
      transaction,
      {
        memberId: input.memberId,
        memberName: locked.member_name,
        occurredAt: completedAt,
        consecutiveFailures: 0,
        failureProfiles: [],
        diagnostic: null,
        closeReason: "reauthorized",
      },
      targets
    );
    return {
      evaluation: {
        id: evaluationId,
        disposition: "accepted" as const,
      },
      notificationCreated: Boolean(closed?.closed),
    };
  });

  if (transactionResult.notificationCreated) {
    await bestEffortDrainAdobeCredentialNotifications();
  }
  return {
    evaluationId: transactionResult.evaluation.id,
    disposition: transactionResult.evaluation.disposition,
    health: await getAdobeCredentialHealth(input.memberId),
  };
}
