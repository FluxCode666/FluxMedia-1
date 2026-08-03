"use server";

/**
 * Adobe 凭据通知设置 Server Actions。
 *
 * 职责：校验浏览器增量输入、初始化 Web late binding、从真实超管会话构造 Principal
 * 并调用专用 human-only UOL operation。持久化、DNS 与渠道完整性不在传输层实现。
 */
import { ActionUserError, superAdminAction } from "@repo/shared/safe-action";
import type { AdobeCredentialNotificationSettings } from "@repo/shared/system-settings/adobe-credential-notification-contract";
import { adobeCredentialNotificationSettingsUpdateSchema } from "@repo/shared/system-settings/adobe-credential-notification-contract";
import { invokeOperation, OperationError } from "@repo/shared/uol";

import { ensureUolInitialized } from "@/server/uol-init";

/** 将 UOL 失败转换为不含 DNS、URL 路径或底层异常的管理员反馈。 */
function throwNotificationSettingsActionError(error: unknown): never {
  if (!(error instanceof OperationError)) throw error;
  if (error.code === "validation_error") {
    throw new ActionUserError(error.message);
  }
  if (error.code === "forbidden" || error.code === "unauthenticated") {
    throw new ActionUserError("只有超级管理员可以管理 Adobe 凭据通知");
  }
  throw new ActionUserError("Adobe 凭据通知设置暂时不可用，请稍后重试");
}

/** 读取通知渠道配置和脱敏投递摘要。 */
export const getAdobeCredentialNotificationSettingsAction = superAdminAction
  .metadata({ action: "system-settings.adobe-credential-notifications.get" })
  .action(async ({ ctx }): Promise<AdobeCredentialNotificationSettings> => {
    await ensureUolInitialized();
    try {
      return await invokeOperation<AdobeCredentialNotificationSettings>(
        "settings.getAdobeCredentialNotifications",
        {},
        { type: "user", userId: ctx.userId, role: ctx.role }
      );
    } catch (error) {
      throwNotificationSettingsActionError(error);
    }
  });

/** 增量保存收件人或 Webhook；缺失字段保持现有值，空值明确停用对应渠道。 */
export const setAdobeCredentialNotificationSettingsAction = superAdminAction
  .metadata({ action: "system-settings.adobe-credential-notifications.set" })
  .schema(adobeCredentialNotificationSettingsUpdateSchema)
  .action(
    async ({
      parsedInput,
      ctx,
    }): Promise<AdobeCredentialNotificationSettings> => {
      await ensureUolInitialized();
      try {
        return await invokeOperation<AdobeCredentialNotificationSettings>(
          "settings.setAdobeCredentialNotifications",
          parsedInput,
          { type: "user", userId: ctx.userId, role: ctx.role }
        );
      } catch (error) {
        throwNotificationSettingsActionError(error);
      }
    }
  );
