/**
 * Adobe 凭据健康事件与持久通知 outbox。
 *
 * 职责：在隔离/恢复事务中创建单一事件和按渠道唯一的不可变投递，认领到期
 * 投递、执行邮件/Webhook、以有限退避写回结果，并提供 90 天终态历史清理。
 * 使用方是健康评估提交边界、内部任务调度器和管理员恢复流程；数据库事务内
 * 只执行数据库操作，所有外部网络投递都发生在事务之外。
 */
import { createHash, randomUUID } from "node:crypto";
import { logWarn } from "@repo/shared/logger";
import type { EmailDeliveryConfigurationSnapshot } from "@repo/shared/mail/client";
import { and, eq, type SQL, sql } from "drizzle-orm";
import { createElement } from "react";
import { z } from "zod";

import {
  assertPublicCallbackUrl,
  SafeImageFetchError,
} from "../external-api/safe-image-fetch";
import type {
  AdobeCredentialDiagnostic,
  AdobeCredentialFailureCategory,
  AdobeCredentialProfile,
} from "./adobe-credential-health-policy";
import {
  AdobeCredentialWebhookError,
  adobeCredentialWebhookSecretFingerprint,
  deliverAdobeCredentialWebhook,
} from "./adobe-credential-webhook";

export type AdobeCredentialNotificationChannel = "email" | "webhook";
export type AdobeCredentialNotificationEventType = "failure" | "recovery";

const NOTIFICATION_CLAIM_TTL_MS = 2 * 60_000;
const NOTIFICATION_BATCH_LIMIT = 25;
const NOTIFICATION_WORKER_COUNT = 4;
const NOTIFICATION_MAX_ATTEMPTS = 8;
const NOTIFICATION_RETRY_BASE_MS = 30_000;
const NOTIFICATION_RETRY_CAP_MS = 15 * 60_000;
const NOTIFICATION_RETENTION_MS = 90 * 24 * 60 * 60_000;

const emailRecipientsSchema = z
  .array(z.string().trim().email().max(320))
  .max(50);
const notificationPayloadSchema = z
  .object({
    version: z.literal(1),
    eventType: z.enum(["failure", "recovery"]),
    incidentId: z.string().min(1).max(128),
    member: z.object({
      id: z.string().min(1).max(128),
      name: z.string().max(512),
    }),
    status: z.enum(["isolated", "healthy"]),
    consecutiveFailures: z.number().int().nonnegative(),
    failureProfiles: z.array(z.enum(["express", "firefly"])).max(2),
    failureCategory: z.string().min(1).max(64).optional(),
    diagnostic: z
      .object({
        statusCode: z.number().int().min(100).max(599).optional(),
        adobeErrorCode: z.string().min(1).max(128).optional(),
        requestId: z.string().min(1).max(256).optional(),
      })
      .strict()
      .nullable(),
    occurredAt: z.string().datetime({ offset: true }),
  })
  .strict();

type AdobeCredentialNotificationPayload = z.infer<
  typeof notificationPayloadSchema
>;

type EmailTarget = {
  channel: "email";
  targetEnvelope: { recipients: string[] };
  configRevision: string;
  email: EmailDeliveryConfigurationSnapshot;
};

type WebhookTarget = {
  channel: "webhook";
  targetEnvelope: { url: string; secretFingerprint: string };
  configRevision: string;
  url: string;
  secret: string;
  secretFingerprint: string;
};

export type AdobeCredentialNotificationTarget = EmailTarget | WebhookTarget;

type SqlExecutor = {
  execute(query: SQL): Promise<unknown>;
};

async function loadNotificationDatabase() {
  const [{ db }, { adobeCredentialNotificationDelivery }] = await Promise.all([
    import("@repo/database"),
    import("@repo/database/schema"),
  ]);
  return { db, adobeCredentialNotificationDelivery };
}

async function loadNotificationMail() {
  const [{ getEmailConfigurationSnapshot }, { sendEmail }] = await Promise.all([
    import("@repo/shared/mail/client"),
    import("@repo/shared/mail/utils"),
  ]);
  return { getEmailConfigurationSnapshot, sendEmail };
}

async function loadNotificationSettings() {
  const { getRuntimeSettingJson, getRuntimeSettingString } = await import(
    "@repo/shared/system-settings"
  );
  return { getRuntimeSettingJson, getRuntimeSettingString };
}

function firstSqlRow(value: unknown): unknown {
  if (Array.isArray(value)) return value[0];
  if (value && typeof value === "object" && "rows" in value) {
    const rows = (value as { rows?: unknown }).rows;
    return Array.isArray(rows) ? rows[0] : undefined;
  }
  return undefined;
}

const deliveryRowSchema = z.object({
  id: z.string().min(1),
  incident_id: z.string().min(1),
  event_type: z.enum(["failure", "recovery"]),
  channel: z.enum(["email", "webhook"]),
  status: z.enum([
    "pending",
    "delivering",
    "retry",
    "delivered",
    "dead",
    "configuration_superseded",
    "cancelled",
  ]),
  target_envelope: z.record(z.string(), z.unknown()),
  payload: z.record(z.string(), z.unknown()),
  config_revision: z.string().min(1),
  attempt_count: z.number().int().nonnegative().max(NOTIFICATION_MAX_ATTEMPTS),
});

function jsonValue(value: unknown): string {
  return JSON.stringify(value);
}

function hashValue(value: unknown): string {
  return createHash("sha256").update(jsonValue(value), "utf8").digest("hex");
}

/**
 * 构造不含 Adobe 原始错误正文的通知 payload。
 *
 * @param input 事件类型、稳定成员快照和脱敏诊断。
 * @returns 严格 schema 约束的不可变 payload；message 字段永不进入通知。
 */
export function buildAdobeCredentialNotificationPayload(input: {
  eventType: AdobeCredentialNotificationEventType;
  incidentId: string;
  memberId: string;
  memberName: string;
  status: "isolated" | "healthy";
  consecutiveFailures: number;
  failureProfiles: readonly AdobeCredentialProfile[];
  failureCategory?: AdobeCredentialFailureCategory;
  diagnostic: AdobeCredentialDiagnostic | null;
  occurredAt: Date;
}): AdobeCredentialNotificationPayload {
  const safeDiagnostic = input.diagnostic
    ? {
        ...(input.diagnostic.statusCode !== undefined
          ? { statusCode: input.diagnostic.statusCode }
          : {}),
        ...(input.diagnostic.adobeErrorCode
          ? { adobeErrorCode: input.diagnostic.adobeErrorCode }
          : {}),
        ...(input.diagnostic.requestId
          ? { requestId: input.diagnostic.requestId }
          : {}),
      }
    : null;
  return notificationPayloadSchema.parse({
    version: 1,
    eventType: input.eventType,
    incidentId: input.incidentId,
    member: {
      id: input.memberId,
      name: input.memberName.slice(0, 512),
    },
    status: input.status,
    consecutiveFailures: input.consecutiveFailures,
    failureProfiles: [...new Set(input.failureProfiles)],
    ...(input.failureCategory
      ? { failureCategory: input.failureCategory }
      : {}),
    diagnostic: safeDiagnostic,
    occurredAt: input.occurredAt.toISOString(),
  });
}

/** 计算单渠道 target 与 payload 的稳定配置 revision。 */
export function buildAdobeCredentialNotificationConfigRevision(input: {
  channel: AdobeCredentialNotificationChannel;
  targetEnvelope: Record<string, unknown>;
  providerFingerprint?: string;
}): string {
  return hashValue({
    version: 1,
    channel: input.channel,
    targetEnvelope: input.targetEnvelope,
    ...(input.providerFingerprint
      ? { providerFingerprint: input.providerFingerprint }
      : {}),
  });
}

/**
 * 读取并验证当前通知目标；未完整配置的渠道不会生成 outbox 行。
 *
 * @param validateWebhookDns 是否在读取时执行公网 DNS/SSRF 校验；保存配置和
 * 事件提交前应为 true，单纯读取管理状态可传 false。
 * @returns 邮件和 Webhook 的完整目标快照；不返回 HMAC 密钥给调用方边界之外。
 */
export async function resolveAdobeCredentialNotificationTargets(
  input: { validateWebhookDns?: boolean } = {}
): Promise<AdobeCredentialNotificationTarget[]> {
  const targets: AdobeCredentialNotificationTarget[] = [];
  const { getRuntimeSettingJson, getRuntimeSettingString } =
    await loadNotificationSettings();
  const [{ getEmailConfigurationSnapshot }, emailRecipientsRaw, webhookUrl] =
    await Promise.all([
      loadNotificationMail(),
      getRuntimeSettingJson("ADOBE_CREDENTIAL_ALERT_EMAIL_RECIPIENTS").catch(
        () => undefined
      ),
      getRuntimeSettingString("ADOBE_CREDENTIAL_ALERT_WEBHOOK_URL"),
    ]);
  const email = await getEmailConfigurationSnapshot();
  const emailRecipients = emailRecipientsSchema.safeParse(emailRecipientsRaw);
  if (
    email.configured &&
    emailRecipients.success &&
    emailRecipients.data.length > 0
  ) {
    const targetEnvelope = { recipients: [...new Set(emailRecipients.data)] };
    targets.push({
      channel: "email",
      targetEnvelope,
      configRevision: buildAdobeCredentialNotificationConfigRevision({
        channel: "email",
        targetEnvelope,
        providerFingerprint: email.configurationFingerprint,
      }),
      email,
    });
  }

  const secret = process.env.ADOBE_CREDENTIAL_WEBHOOK_HMAC_SECRET?.trim();
  if (!webhookUrl || !secret || Buffer.byteLength(secret, "utf8") < 32) {
    return targets;
  }
  let parsed: URL;
  try {
    parsed = new URL(webhookUrl);
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      return targets;
    }
    if (input.validateWebhookDns) await assertPublicCallbackUrl(parsed.href);
  } catch (error) {
    if (error instanceof SafeImageFetchError) return targets;
    return targets;
  }
  const secretFingerprint = adobeCredentialWebhookSecretFingerprint(secret);
  const targetEnvelope = { url: parsed.href, secretFingerprint };
  targets.push({
    channel: "webhook",
    targetEnvelope,
    configRevision: buildAdobeCredentialNotificationConfigRevision({
      channel: "webhook",
      targetEnvelope,
      providerFingerprint: secretFingerprint,
    }),
    url: parsed.href,
    secret,
    secretFingerprint,
  });
  return targets;
}

/**
 * 在评估提交事务中创建/更新一个开放 incident，并只在首次打开时创建通知行。
 *
 * @param executor 当前数据库或事务 executor。
 * @param input 隔离成员快照和事件 payload。
 * @param targets 已在事务外验证过的渠道配置。
 * @returns 稳定 incident ID 与本次是否新建事件。
 */
export async function openAdobeCredentialIncident(
  executor: SqlExecutor,
  input: {
    incidentId?: string;
    memberId: string;
    memberName: string;
    consecutiveFailures: number;
    failureProfiles: readonly AdobeCredentialProfile[];
    diagnostic: AdobeCredentialDiagnostic | null;
    occurredAt: Date;
    failureCategory?: AdobeCredentialFailureCategory;
  },
  targets: readonly AdobeCredentialNotificationTarget[]
): Promise<{ incidentId: string; created: boolean }> {
  const incidentId = input.incidentId ?? randomUUID();
  const payloadBase = {
    incidentId,
    memberId: input.memberId,
    memberName: input.memberName,
    status: "isolated" as const,
    consecutiveFailures: input.consecutiveFailures,
    failureProfiles: input.failureProfiles,
    diagnostic: input.diagnostic,
    occurredAt: input.occurredAt,
    ...(input.failureCategory
      ? { failureCategory: input.failureCategory }
      : {}),
  };
  const result = await executor.execute(sql`
    WITH inserted AS (
      INSERT INTO adobe_credential_incident (
        id, member_id_snapshot, member_name_snapshot, status,
        consecutive_failures, failure_profiles, diagnostic,
        opened_at, last_failure_at, created_at, updated_at
      ) VALUES (
        ${incidentId}, ${input.memberId}, ${input.memberName}, 'open',
        ${input.consecutiveFailures}, ${jsonValue(input.failureProfiles)}::json,
        ${input.diagnostic ? jsonValue(input.diagnostic) : null}::json,
        ${input.occurredAt}, ${input.occurredAt}, ${input.occurredAt}, ${input.occurredAt}
      )
      ON CONFLICT (member_id_snapshot) WHERE status = 'open' DO NOTHING
      RETURNING id, true AS created
    )
    SELECT id, created FROM inserted
    UNION ALL
    SELECT id, false AS created
    FROM adobe_credential_incident
    WHERE member_id_snapshot = ${input.memberId}
      AND status = 'open'
      AND NOT EXISTS (SELECT 1 FROM inserted)
    LIMIT 1
  `);
  const row = z
    .object({ id: z.string().min(1), created: z.boolean() })
    .parse(firstSqlRow(result) ?? null);
  const openIncidentId = row.id;
  if (!row.created) {
    await executor.execute(sql`
      UPDATE adobe_credential_incident
      SET consecutive_failures = ${input.consecutiveFailures},
          failure_profiles = ${jsonValue(input.failureProfiles)}::json,
          diagnostic = ${input.diagnostic ? jsonValue(input.diagnostic) : null}::json,
          last_failure_at = ${input.occurredAt},
          updated_at = ${input.occurredAt}
      WHERE id = ${openIncidentId} AND status = 'open'
    `);
  }
  if (row.created) {
    const payload = buildAdobeCredentialNotificationPayload({
      eventType: "failure",
      ...payloadBase,
    });
    await insertAdobeCredentialNotificationDeliveries(executor, {
      incidentId: openIncidentId,
      eventType: "failure",
      payload,
      targets,
      occurredAt: input.occurredAt,
    });
  }
  return { incidentId: openIncidentId, created: row.created };
}

/** 关闭开放 incident 并为恢复事件建立一次性投递。 */
export async function closeAdobeCredentialIncident(
  executor: SqlExecutor,
  input: {
    memberId: string;
    memberName: string;
    occurredAt: Date;
    consecutiveFailures: number;
    failureProfiles: readonly AdobeCredentialProfile[];
    diagnostic: AdobeCredentialDiagnostic | null;
    closeReason: "reauthorized" | "deleted";
  },
  targets: readonly AdobeCredentialNotificationTarget[]
): Promise<{ incidentId: string; closed: boolean } | null> {
  const result = await executor.execute(sql`
    SELECT id, consecutive_failures
    FROM adobe_credential_incident
    WHERE member_id_snapshot = ${input.memberId} AND status = 'open'
    FOR UPDATE
  `);
  const row = z
    .object({
      id: z.string().min(1),
      consecutive_failures: z.number().int().positive(),
    })
    .safeParse(firstSqlRow(result) ?? null);
  if (!row.success) return null;
  const incidentId = row.data.id;
  await executor.execute(sql`
    UPDATE adobe_credential_incident
    SET status = 'closed', closed_at = ${input.occurredAt},
        close_reason = ${input.closeReason}, updated_at = ${input.occurredAt}
    WHERE id = ${incidentId} AND status = 'open'
  `);
  if (input.closeReason === "reauthorized") {
    const payload = buildAdobeCredentialNotificationPayload({
      eventType: "recovery",
      incidentId,
      memberId: input.memberId,
      memberName: input.memberName,
      status: "healthy",
      consecutiveFailures: input.consecutiveFailures,
      failureProfiles: input.failureProfiles,
      diagnostic: input.diagnostic,
      occurredAt: input.occurredAt,
    });
    await insertAdobeCredentialNotificationDeliveries(executor, {
      incidentId,
      eventType: "recovery",
      payload,
      targets,
      occurredAt: input.occurredAt,
    });
  }
  return { incidentId, closed: true };
}

async function insertAdobeCredentialNotificationDeliveries(
  executor: SqlExecutor,
  input: {
    incidentId: string;
    eventType: AdobeCredentialNotificationEventType;
    payload: AdobeCredentialNotificationPayload;
    targets: readonly AdobeCredentialNotificationTarget[];
    occurredAt: Date;
  }
): Promise<void> {
  const payloadHash = hashValue(input.payload);
  for (const target of input.targets) {
    const id = randomUUID();
    await executor.execute(sql`
      INSERT INTO adobe_credential_notification_delivery (
        id, incident_id, event_type, channel, status, target_envelope,
        payload, payload_hash, config_revision, secret_fingerprint,
        attempt_count, next_attempt_at, created_at, updated_at
      ) VALUES (
        ${id}, ${input.incidentId}, ${input.eventType}, ${target.channel}, 'pending',
        ${jsonValue(target.targetEnvelope)}::json,
        ${jsonValue(input.payload)}::json, ${payloadHash}, ${target.configRevision},
        ${target.channel === "webhook" ? target.secretFingerprint : null}, 0,
        ${input.occurredAt}, ${input.occurredAt}, ${input.occurredAt}
      )
      ON CONFLICT (incident_id, event_type, channel) DO NOTHING
    `);
  }
}

/** 计算第 N 次失败的有限指数退避；attemptCount 已包含本次尝试。 */
export function getAdobeCredentialNotificationRetryAt(
  attemptCount: number,
  now: Date,
  retryAfterMs?: number
): Date | null {
  if (attemptCount >= NOTIFICATION_MAX_ATTEMPTS) return null;
  const exponential = Math.min(
    NOTIFICATION_RETRY_CAP_MS,
    NOTIFICATION_RETRY_BASE_MS * 2 ** Math.max(0, attemptCount - 1)
  );
  const delay = Math.min(
    NOTIFICATION_RETRY_CAP_MS,
    Math.max(exponential, retryAfterMs ?? 0)
  );
  return new Date(now.getTime() + delay);
}

/** 认领一条到期 outbox 投递；过期 delivering 可被补偿 worker 接管。 */
async function claimNextAdobeCredentialNotification(
  claimToken: string,
  now: Date
): Promise<string | null> {
  const { db } = await loadNotificationDatabase();
  const result = await db.execute(sql`
    WITH candidate AS (
      SELECT id
      FROM adobe_credential_notification_delivery
      WHERE status IN ('pending', 'retry', 'delivering')
        AND next_attempt_at <= ${now}
        AND (claim_expires_at IS NULL OR claim_expires_at <= ${now})
      ORDER BY next_attempt_at, created_at, id
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE adobe_credential_notification_delivery AS delivery
    SET status = 'delivering', attempt_count = delivery.attempt_count + 1,
        claim_token = ${claimToken},
        claim_expires_at = ${new Date(now.getTime() + NOTIFICATION_CLAIM_TTL_MS)},
        updated_at = ${now}
    FROM candidate
    WHERE delivery.id = candidate.id
    RETURNING delivery.id
  `);
  const row = z
    .object({ id: z.string().min(1) })
    .safeParse(firstSqlRow(result) ?? null);
  return row.success ? row.data.id : null;
}

async function loadClaimedAdobeCredentialNotification(
  id: string,
  claimToken: string
): Promise<z.infer<typeof deliveryRowSchema> | null> {
  const { db } = await loadNotificationDatabase();
  const result = await db.execute(sql`
    SELECT id, incident_id, event_type, channel, status, target_envelope,
           payload, config_revision, attempt_count
    FROM adobe_credential_notification_delivery
    WHERE id = ${id} AND claim_token = ${claimToken} AND status = 'delivering'
    LIMIT 1
  `);
  const row = deliveryRowSchema.safeParse(firstSqlRow(result) ?? null);
  return row.success ? row.data : null;
}

async function markAdobeCredentialDelivery(
  id: string,
  claimToken: string,
  update: {
    status: "delivered" | "retry" | "dead" | "configuration_superseded";
    now: Date;
    nextAttemptAt?: Date;
    errorCode?: string;
    providerRequestId?: string;
  }
): Promise<void> {
  const { db, adobeCredentialNotificationDelivery } =
    await loadNotificationDatabase();
  await db
    .update(adobeCredentialNotificationDelivery)
    .set({
      status: update.status,
      ...(update.status === "delivered"
        ? { deliveredAt: update.now }
        : update.nextAttemptAt
          ? { nextAttemptAt: update.nextAttemptAt }
          : {}),
      claimToken: null,
      claimExpiresAt: null,
      ...(update.errorCode ? { lastErrorCode: update.errorCode } : {}),
      ...(update.providerRequestId
        ? { providerRequestId: update.providerRequestId }
        : {}),
      updatedAt: update.now,
    })
    .where(
      and(
        eq(adobeCredentialNotificationDelivery.id, id),
        eq(adobeCredentialNotificationDelivery.claimToken, claimToken),
        eq(adobeCredentialNotificationDelivery.status, "delivering")
      )
    );
}

/** 将 claim 已耗尽且进程崩溃的 delivering 行收敛为 dead，避免永远卡住。 */
async function finalizeExhaustedAdobeCredentialNotifications(
  now: Date
): Promise<void> {
  const { db } = await loadNotificationDatabase();
  await db.execute(sql`
    UPDATE adobe_credential_notification_delivery
    SET status = 'dead', claim_token = NULL, claim_expires_at = NULL,
        last_error_code = 'retry_exhausted', updated_at = ${now}
    WHERE status = 'delivering'
      AND attempt_count >= ${NOTIFICATION_MAX_ATTEMPTS}
      AND claim_expires_at IS NOT NULL
      AND claim_expires_at <= ${now}
  `);
}

function notificationEmailElement(payload: AdobeCredentialNotificationPayload) {
  const title =
    payload.eventType === "failure" ? "Adobe 凭据已隔离" : "Adobe 凭据已恢复";
  return createElement(
    "div",
    null,
    createElement("h2", null, title),
    createElement(
      "p",
      null,
      `成员：${payload.member.name}（${payload.member.id}）`
    ),
    createElement("p", null, `状态：${payload.status}`),
    createElement("p", null, `失败次数：${payload.consecutiveFailures}`),
    createElement(
      "p",
      null,
      `Profile：${payload.failureProfiles.join("、") || "无"}`
    ),
    payload.failureCategory
      ? createElement("p", null, `故障分类：${payload.failureCategory}`)
      : null,
    createElement("p", null, `事件 ID：${payload.incidentId}`)
  );
}

function classifyEmailFailure(message: string): {
  code: string;
  retryable: boolean;
} {
  const lower = message.toLowerCase();
  if (/429|rate.?limit|too many/.test(lower)) {
    return { code: "rate_limited", retryable: true };
  }
  if (/timeout|timed out|temporar|econn|socket|network|5\d\d/.test(lower)) {
    return { code: "provider_temporary", retryable: true };
  }
  return { code: "provider_rejected", retryable: false };
}

/** 投递当前 claim 的一条邮件或 Webhook。 */
async function deliverClaimedAdobeCredentialNotification(
  delivery: z.infer<typeof deliveryRowSchema>,
  target: AdobeCredentialNotificationTarget
): Promise<{ providerRequestId?: string }> {
  const payload = notificationPayloadSchema.parse(delivery.payload);
  if (delivery.channel === "email" && target.channel === "email") {
    const { sendEmail } = await loadNotificationMail();
    const result = await sendEmail({
      to: target.targetEnvelope.recipients,
      subject:
        payload.eventType === "failure"
          ? "Adobe 凭据健康告警"
          : "Adobe 凭据恢复通知",
      react: notificationEmailElement(payload),
      idempotencyKey: `adobe-credential:${delivery.id}`,
    });
    if (!result.success) {
      const failure = classifyEmailFailure(
        result.error ?? "email delivery failed"
      );
      throw Object.assign(new Error("email delivery failed"), failure);
    }
    return result.id ? { providerRequestId: result.id } : {};
  }
  if (delivery.channel === "webhook" && target.channel === "webhook") {
    const result = await deliverAdobeCredentialWebhook({
      url: target.url,
      secret: target.secret,
      eventId: delivery.incident_id,
      deliveryId: delivery.id,
      payload,
    });
    return result.requestId ? { providerRequestId: result.requestId } : {};
  }
  throw new Error("notification channel mismatch");
}

/**
 * 补偿投递到期 outbox；投递失败只更新 outbox，不回滚健康事件。
 *
 * @param input 批量上限；默认最多并发认领 25 条、4 个 worker。
 * @returns 本轮认领、成功和失败统计；单条失败不会阻断其它渠道。
 */
export async function drainAdobeCredentialNotifications(
  input: { batchSize?: number } = {}
): Promise<{ claimed: number; completed: number; failed: number }> {
  const batchSize = Math.min(
    NOTIFICATION_BATCH_LIMIT,
    Math.max(1, Math.trunc(input.batchSize ?? NOTIFICATION_BATCH_LIMIT))
  );
  await finalizeExhaustedAdobeCredentialNotifications(new Date());
  let reservations = 0;
  let claimed = 0;
  let completed = 0;
  let failed = 0;
  const reserveSlot = (): boolean => {
    if (reservations >= batchSize) return false;
    reservations += 1;
    return true;
  };
  const worker = async (): Promise<void> => {
    while (reserveSlot()) {
      const claimToken = randomUUID();
      const now = new Date();
      const deliveryId = await claimNextAdobeCredentialNotification(
        claimToken,
        now
      );
      if (!deliveryId) return;
      claimed += 1;
      const delivery = await loadClaimedAdobeCredentialNotification(
        deliveryId,
        claimToken
      );
      if (!delivery) continue;
      const targets = await resolveAdobeCredentialNotificationTargets({
        validateWebhookDns: true,
      });
      const target = targets.find(
        (candidate) =>
          candidate.channel === delivery.channel &&
          candidate.configRevision === delivery.config_revision
      );
      if (!target) {
        await markAdobeCredentialDelivery(delivery.id, claimToken, {
          status: "configuration_superseded",
          now: new Date(),
          errorCode: "configuration_superseded",
        });
        continue;
      }
      try {
        const result = await deliverClaimedAdobeCredentialNotification(
          delivery,
          target
        );
        await markAdobeCredentialDelivery(delivery.id, claimToken, {
          status: "delivered",
          now: new Date(),
          ...(result.providerRequestId
            ? { providerRequestId: result.providerRequestId }
            : {}),
        });
        completed += 1;
      } catch (error) {
        failed += 1;
        const retryable =
          error instanceof AdobeCredentialWebhookError
            ? error.retryable
            : typeof error === "object" &&
                error !== null &&
                "retryable" in error
              ? (error as { retryable?: unknown }).retryable === true
              : false;
        const retryAfterMs =
          error instanceof AdobeCredentialWebhookError
            ? error.retryAfterMs
            : undefined;
        const errorCode =
          error instanceof AdobeCredentialWebhookError
            ? error.code
            : typeof error === "object" && error !== null && "code" in error
              ? String(
                  (error as { code?: unknown }).code ?? "provider_rejected"
                )
              : "provider_rejected";
        const retryAt = retryable
          ? getAdobeCredentialNotificationRetryAt(
              delivery.attempt_count,
              new Date(),
              retryAfterMs
            )
          : null;
        await markAdobeCredentialDelivery(delivery.id, claimToken, {
          status: retryAt ? "retry" : "dead",
          now: new Date(),
          ...(retryAt ? { nextAttemptAt: retryAt } : {}),
          errorCode: errorCode.slice(0, 128),
        });
      }
    }
  };
  await Promise.all(
    Array.from({ length: NOTIFICATION_WORKER_COUNT }, () => worker())
  );
  return { claimed, completed, failed };
}

/**
 * 清理超过 90 天的终态历史，先投递、再事件和评估，重复执行安全。
 *
 * @param input 批量上限。
 * @returns 各表实际删除行数；开放事件、未终态投递和当前摘要不删除。
 */
export async function cleanupAdobeCredentialHealthHistory(
  input: { limit?: number; now?: Date } = {}
): Promise<{
  deletedEvaluations: number;
  deletedIncidents: number;
  deletedDeliveries: number;
}> {
  const limit = Math.min(500, Math.max(1, Math.trunc(input.limit ?? 100)));
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - NOTIFICATION_RETENTION_MS);
  const { db } = await loadNotificationDatabase();
  return db.transaction(async (transaction) => {
    const deliveries = await transaction.execute(sql`
      WITH candidates AS (
        SELECT delivery.id
        FROM adobe_credential_notification_delivery AS delivery
        INNER JOIN adobe_credential_incident AS incident
          ON incident.id = delivery.incident_id
        WHERE incident.status = 'closed'
          AND incident.closed_at < ${cutoff}
          AND delivery.status IN ('delivered', 'dead', 'configuration_superseded', 'cancelled')
        ORDER BY delivery.created_at, delivery.id
        LIMIT ${limit}
      )
      DELETE FROM adobe_credential_notification_delivery AS delivery
      USING candidates
      WHERE delivery.id = candidates.id
      RETURNING delivery.id
    `);
    const incidents = await transaction.execute(sql`
      WITH candidates AS (
        SELECT incident.id
        FROM adobe_credential_incident AS incident
        WHERE incident.status = 'closed'
          AND incident.closed_at < ${cutoff}
          AND NOT EXISTS (
            SELECT 1 FROM adobe_credential_notification_delivery AS delivery
            WHERE delivery.incident_id = incident.id
          )
        ORDER BY incident.closed_at, incident.id
        LIMIT ${limit}
      )
      DELETE FROM adobe_credential_incident AS incident
      USING candidates
      WHERE incident.id = candidates.id
      RETURNING incident.id
    `);
    const evaluations = await transaction.execute(sql`
      WITH candidates AS (
        SELECT id
        FROM adobe_credential_evaluation
        WHERE completed_at < ${cutoff}
        ORDER BY completed_at, id
        LIMIT ${limit}
      )
      DELETE FROM adobe_credential_evaluation AS evaluation
      USING candidates
      WHERE evaluation.id = candidates.id
      RETURNING evaluation.id
    `);
    const count = (value: unknown): number =>
      Array.isArray(value)
        ? value.length
        : Array.isArray((value as { rows?: unknown[] }).rows)
          ? ((value as { rows: unknown[] }).rows.length ?? 0)
          : 0;
    return {
      deletedEvaluations: count(evaluations),
      deletedIncidents: count(incidents),
      deletedDeliveries: count(deliveries),
    };
  });
}

/** 提交后立即 drain 的非阻断包装；失败只保留持久 outbox 等待周期任务。 */
export async function bestEffortDrainAdobeCredentialNotifications(): Promise<void> {
  try {
    await drainAdobeCredentialNotifications();
  } catch {
    logWarn("Adobe credential notification immediate drain failed");
  }
}
