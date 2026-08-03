/**
 * Adobe 凭据通知设置的传输无关契约。
 *
 * 职责：约束邮件收件人、Webhook 更新意图和仅含配置状态的管理 DTO。
 * 使用方：UOL operation、Web late binding、Server Action 与系统设置卡片。
 * 关键边界：Webhook 完整 URL 只允许写入，不从读取 DTO 回显；HMAC 明文不进入契约。
 */
import { z } from "zod";

/** 告警收件人列表；服务端会进一步归一化和去重。 */
export const adobeCredentialAlertEmailRecipientsSchema = z
  .array(z.string().trim().email().max(320))
  .max(50);

/**
 * 校验可持久化 Webhook 的非机密 URL 结构。
 *
 * DNS、公网 IP 与私网阻断依赖 Web 运行时，只在 late binding 服务中执行。
 */
export const adobeCredentialAlertWebhookUrlSchema = z
  .string()
  .trim()
  .max(2_048)
  .superRefine((value, ctx) => {
    if (value === "") return;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "Webhook 地址格式无效" });
      return;
    }
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.hostname === ""
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Webhook 必须是不含凭据、query 和 fragment 的 HTTPS 地址",
      });
    }
  });

/**
 * 通知设置增量更新。
 *
 * 字段缺失表示保持现状；空 Webhook 字符串表示清空。这样页面无需读取已保存的
 * 完整 URL，也能单独修改收件人或明确停用 Webhook。
 */
export const adobeCredentialNotificationSettingsUpdateSchema = z
  .object({
    emailRecipients: adobeCredentialAlertEmailRecipientsSchema.optional(),
    webhookUrl: adobeCredentialAlertWebhookUrlSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.emailRecipients === undefined && value.webhookUrl === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "至少提交一项通知设置",
      });
    }
  });

/** 单一通知渠道的脱敏投递摘要。 */
export const adobeCredentialNotificationDeliverySummarySchema = z
  .object({
    pending: z.number().int().nonnegative(),
    retrying: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    lastDeliveredAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();

/** 超级管理员读取的通知配置状态；不含完整 Webhook URL 或任何密钥。 */
export const adobeCredentialNotificationSettingsOutputSchema = z
  .object({
    emailRecipients: adobeCredentialAlertEmailRecipientsSchema,
    emailConfigured: z.boolean(),
    webhookHost: z.string().nullable(),
    webhookConfigured: z.boolean(),
    webhookHmacConfigured: z.boolean(),
    deliveryStatus: z
      .object({
        email: adobeCredentialNotificationDeliverySummarySchema,
        webhook: adobeCredentialNotificationDeliverySummarySchema,
      })
      .strict(),
  })
  .strict();

export type AdobeCredentialNotificationSettingsUpdate = z.infer<
  typeof adobeCredentialNotificationSettingsUpdateSchema
>;

export type AdobeCredentialNotificationSettings = z.infer<
  typeof adobeCredentialNotificationSettingsOutputSchema
>;
