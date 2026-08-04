/**
 * Adobe 凭据通知设置服务。
 *
 * 职责：读取渠道完整性与脱敏投递摘要，在事务外校验新 Webhook 的公网 DNS，
 * 并在单个事务中更新专用设置和安全审计。使用方为通知设置 UOL late binding。
 * 关键边界：完整 Webhook URL 只写不读，HMAC 仅从部署环境读取且不落库或审计。
 */
import { randomUUID } from "node:crypto";
import { db } from "@repo/database";
import { adminAuditLog, systemSetting } from "@repo/database/schema";
import {
  getRuntimeSettingJson,
  getRuntimeSettingString,
  invalidateSystemSettingsCache,
} from "@repo/shared/system-settings";
import type {
  AdobeCredentialNotificationSettings,
  AdobeCredentialNotificationSettingsUpdate,
} from "@repo/shared/system-settings/adobe-credential-notification-contract";
import {
  adobeCredentialAlertEmailRecipientsSchema,
  adobeCredentialAlertWebhookUrlSchema,
  adobeCredentialNotificationSettingsOutputSchema,
  adobeCredentialNotificationSettingsUpdateSchema,
} from "@repo/shared/system-settings/adobe-credential-notification-contract";
import { eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { assertPublicCallbackUrl } from "@/features/external-api/safe-image-fetch";

const EMAIL_RECIPIENTS_KEY = "ADOBE_CREDENTIAL_ALERT_EMAIL_RECIPIENTS";
const WEBHOOK_URL_KEY = "ADOBE_CREDENTIAL_ALERT_WEBHOOK_URL";
const HMAC_SECRET_ENV_KEY = "ADOBE_CREDENTIAL_WEBHOOK_HMAC_SECRET";
const NOTIFICATION_SETTING_KEYS = [
  EMAIL_RECIPIENTS_KEY,
  WEBHOOK_URL_KEY,
] as const;

const deliverySummaryRowSchema = z.object({
  channel: z.enum(["email", "webhook"]),
  pending: z.coerce.number().int().nonnegative(),
  retrying: z.coerce.number().int().nonnegative(),
  failed: z.coerce.number().int().nonnegative(),
  last_delivered_at: z.union([z.date(), z.string(), z.null()]),
});

const EMPTY_DELIVERY_SUMMARY = {
  pending: 0,
  retrying: 0,
  failed: 0,
  lastDeliveredAt: null,
} as const;

/** 可稳定映射为 UOL 的通知设置错误。 */
export class AdobeCredentialNotificationSettingsError extends Error {
  /** 创建不携带 URL、DNS 地址或底层异常的领域错误。 */
  constructor(
    readonly code: "validation_error" | "internal_error",
    message: string
  ) {
    super(message);
    this.name = "AdobeCredentialNotificationSettingsError";
  }
}

/** 归一化、去重并限制收件人，避免同一地址重复投递。 */
export function normalizeAdobeCredentialEmailRecipients(
  value: unknown
): string[] {
  const parsed = adobeCredentialAlertEmailRecipientsSchema.safeParse(value);
  if (!parsed.success) return [];
  return Array.from(
    new Set(parsed.data.map((address) => address.trim().toLowerCase()))
  );
}

/** 只提取 Webhook 主机，完整路径和潜在不透明标识不得返回管理 DTO。 */
export function getAdobeCredentialWebhookHost(
  value: string | undefined
): string | null {
  if (!value) return null;
  const parsed = adobeCredentialAlertWebhookUrlSchema.safeParse(value);
  if (!parsed.success || !parsed.data) return null;
  try {
    return new URL(parsed.data).hostname || null;
  } catch {
    return null;
  }
}

/**
 * 把数据库聚合时间转换为严格的 ISO 时间戳。
 *
 * @throws 数据库返回非法时间时抛出不携带原始行的安全内部错误。
 */
function toIsoTimestamp(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AdobeCredentialNotificationSettingsError(
      "internal_error",
      "通知投递状态暂时不可用"
    );
  }
  return date.toISOString();
}

/** 读取邮件供应商是否完整配置，不返回供应商密钥或连接详情。 */
async function getEmailConfigured(): Promise<boolean> {
  const { getEmailConfigurationSnapshot } = await import(
    "@repo/shared/mail/client"
  );
  return (await getEmailConfigurationSnapshot()).configured;
}

/** 读取两渠道的待处理、重试、最终失败和最近成功时间。 */
async function loadDeliveryStatus(): Promise<
  AdobeCredentialNotificationSettings["deliveryStatus"]
> {
  const result = await db.execute(sql`
    SELECT channel,
      count(*) FILTER (WHERE status = 'pending')::integer AS pending,
      count(*) FILTER (
        WHERE status IN ('retry', 'delivering')
      )::integer AS retrying,
      count(*) FILTER (WHERE status = 'dead')::integer AS failed,
      max(delivered_at) FILTER (
        WHERE status = 'delivered'
      ) AS last_delivered_at
    FROM adobe_credential_notification_delivery
    WHERE channel IN ('email', 'webhook')
    GROUP BY channel
  `);
  const rows: unknown = Array.isArray(result)
    ? result
    : result && typeof result === "object" && "rows" in result
      ? (result as { rows?: unknown }).rows
      : result;
  let parsedRows: z.infer<typeof deliverySummaryRowSchema>[];
  try {
    parsedRows = z.array(deliverySummaryRowSchema).parse(rows);
  } catch {
    // WHY：数据库脏值必须显式失败，但 Zod issues 可能携带原始字段，不能穿透 UOL。
    throw new AdobeCredentialNotificationSettingsError(
      "internal_error",
      "通知投递状态暂时不可用"
    );
  }
  const byChannel = new Map(
    parsedRows.map((row) => [
      row.channel,
      {
        pending: row.pending,
        retrying: row.retrying,
        failed: row.failed,
        lastDeliveredAt: toIsoTimestamp(row.last_delivered_at),
      },
    ])
  );
  return {
    email: byChannel.get("email") ?? { ...EMPTY_DELIVERY_SUMMARY },
    webhook: byChannel.get("webhook") ?? { ...EMPTY_DELIVERY_SUMMARY },
  };
}

/**
 * 读取超级管理员可见的通知设置状态。
 *
 * @returns 收件人、脱敏主机、渠道完整性和脱敏投递摘要。
 * @sideEffects 读取系统设置、邮件配置、DNS 与数据库聚合，不发送通知。
 */
export async function getAdobeCredentialNotificationSettings(): Promise<AdobeCredentialNotificationSettings> {
  const [recipientsRaw, webhookUrl, emailProviderConfigured, deliveryStatus] =
    await Promise.all([
      getRuntimeSettingJson(EMAIL_RECIPIENTS_KEY),
      getRuntimeSettingString(WEBHOOK_URL_KEY),
      getEmailConfigured(),
      loadDeliveryStatus(),
    ]);
  const emailRecipients =
    normalizeAdobeCredentialEmailRecipients(recipientsRaw);
  const webhookHost = getAdobeCredentialWebhookHost(webhookUrl);
  const hmacSecret = process.env[HMAC_SECRET_ENV_KEY]?.trim();
  const webhookHmacConfigured = Boolean(
    hmacSecret && Buffer.byteLength(hmacSecret, "utf8") >= 32
  );
  let webhookPublic = false;
  if (webhookUrl && webhookHost) {
    webhookPublic = await assertPublicCallbackUrl(webhookUrl)
      .then(() => true)
      .catch(() => false);
  }
  return adobeCredentialNotificationSettingsOutputSchema.parse({
    emailRecipients,
    emailConfigured: emailRecipients.length > 0 && emailProviderConfigured,
    webhookHost,
    webhookConfigured: webhookPublic && webhookHmacConfigured,
    webhookHmacConfigured,
    deliveryStatus,
  });
}

/** 读取事务内旧值，并只生成不含地址明细的审计投影。 */
function buildAuditProjection(
  rows: Array<{ key: string; value: unknown }>
): Record<string, unknown> {
  const values = new Map(rows.map((row) => [row.key, row.value]));
  const recipients = normalizeAdobeCredentialEmailRecipients(
    values.get(EMAIL_RECIPIENTS_KEY)
  );
  const webhookValue = values.get(WEBHOOK_URL_KEY);
  const webhookUrl =
    typeof webhookValue === "string" ? webhookValue.trim() : undefined;
  return {
    emailRecipientCount: recipients.length,
    webhookHost: getAdobeCredentialWebhookHost(webhookUrl),
    webhookStored: Boolean(webhookUrl),
  };
}

/**
 * 原子持久化指定通知字段和安全审计。
 *
 * @param input 已归一化的增量更新；缺失字段保持，空值删除。
 * @param actorUserId 真实超级管理员 ID。
 * @sideEffects 写入 system_setting 与 admin_audit_log；不接触 HMAC 密钥。
 */
async function persistNotificationSettings(
  input: AdobeCredentialNotificationSettingsUpdate,
  actorUserId: string
): Promise<void> {
  await db.transaction(async (transaction) => {
    const beforeRows = await transaction
      .select({ key: systemSetting.key, value: systemSetting.value })
      .from(systemSetting)
      .where(inArray(systemSetting.key, NOTIFICATION_SETTING_KEYS));
    const now = new Date();
    if (input.emailRecipients !== undefined) {
      if (input.emailRecipients.length === 0) {
        await transaction
          .delete(systemSetting)
          .where(eq(systemSetting.key, EMAIL_RECIPIENTS_KEY));
      } else {
        await transaction
          .insert(systemSetting)
          .values({
            key: EMAIL_RECIPIENTS_KEY,
            value: input.emailRecipients,
            isSecret: false,
            updatedBy: actorUserId,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: systemSetting.key,
            set: {
              value: input.emailRecipients,
              isSecret: false,
              updatedBy: actorUserId,
              updatedAt: now,
            },
          });
      }
    }
    if (input.webhookUrl !== undefined) {
      if (input.webhookUrl === "") {
        await transaction
          .delete(systemSetting)
          .where(eq(systemSetting.key, WEBHOOK_URL_KEY));
      } else {
        await transaction
          .insert(systemSetting)
          .values({
            key: WEBHOOK_URL_KEY,
            value: input.webhookUrl,
            isSecret: false,
            updatedBy: actorUserId,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: systemSetting.key,
            set: {
              value: input.webhookUrl,
              isSecret: false,
              updatedBy: actorUserId,
              updatedAt: now,
            },
          });
      }
    }
    const afterRows = beforeRows
      .filter(
        (row) =>
          (row.key !== EMAIL_RECIPIENTS_KEY ||
            input.emailRecipients === undefined) &&
          (row.key !== WEBHOOK_URL_KEY || input.webhookUrl === undefined)
      )
      .concat(
        input.emailRecipients && input.emailRecipients.length > 0
          ? [{ key: EMAIL_RECIPIENTS_KEY, value: input.emailRecipients }]
          : [],
        input.webhookUrl
          ? [{ key: WEBHOOK_URL_KEY, value: input.webhookUrl }]
          : []
      );
    await transaction.insert(adminAuditLog).values({
      id: randomUUID(),
      adminUserId: actorUserId,
      targetUserId: null,
      action: "settings.setAdobeCredentialNotifications",
      reason: "超级管理员更新 Adobe 凭据通知设置",
      before: buildAuditProjection(beforeRows),
      after: buildAuditProjection(afterRows),
      metadata: {
        changedEmailRecipients: input.emailRecipients !== undefined,
        changedWebhook: input.webhookUrl !== undefined,
      },
    });
  });
  await invalidateSystemSettingsCache();
}

/**
 * 保存通知设置并返回最新安全状态。
 *
 * @throws 非公网、非 HTTPS 或含隐式凭据的 URL 返回 validation_error；事务失败显式上抛。
 */
export async function setAdobeCredentialNotificationSettings(
  input: AdobeCredentialNotificationSettingsUpdate,
  actorUserId: string
): Promise<AdobeCredentialNotificationSettings> {
  const parsed =
    adobeCredentialNotificationSettingsUpdateSchema.safeParse(input);
  if (!parsed.success) {
    throw new AdobeCredentialNotificationSettingsError(
      "validation_error",
      parsed.error.issues[0]?.message ?? "通知设置无效"
    );
  }
  const normalized: AdobeCredentialNotificationSettingsUpdate = {
    ...(parsed.data.emailRecipients !== undefined
      ? {
          emailRecipients: normalizeAdobeCredentialEmailRecipients(
            parsed.data.emailRecipients
          ),
        }
      : {}),
    ...(parsed.data.webhookUrl !== undefined
      ? { webhookUrl: parsed.data.webhookUrl.trim() }
      : {}),
  };
  if (normalized.webhookUrl) {
    try {
      const parsedUrl = await assertPublicCallbackUrl(normalized.webhookUrl);
      normalized.webhookUrl = parsedUrl.href;
    } catch {
      throw new AdobeCredentialNotificationSettingsError(
        "validation_error",
        "Webhook 必须是可公开访问且不含凭据的 HTTPS 地址"
      );
    }
  }
  await persistNotificationSettings(normalized, actorUserId);
  return getAdobeCredentialNotificationSettings();
}
