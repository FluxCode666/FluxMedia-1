/**
 * Adobe 凭据通知设置 operation 的 Web late binding。
 *
 * 职责：把 shared 中的 human-only 超管契约绑定到公网 DNS 校验、原子设置写入
 * 与安全状态读取服务。使用方为 UOL 初始化入口。
 * 关键边界：只接受真实 user Principal，不向错误或 DTO 透传 URL 路径和 HMAC。
 */
import type { AdobeCredentialNotificationSettingsUpdate } from "@repo/shared/system-settings/adobe-credential-notification-contract";
import { bindExecute, OperationError, type Principal } from "@repo/shared/uol";

import {
  AdobeCredentialNotificationSettingsError,
  getAdobeCredentialNotificationSettings,
  setAdobeCredentialNotificationSettings,
} from "@/features/system-settings/adobe-credential-notification-settings-service";

/** 把通知设置领域错误映射为稳定且不泄露目标地址的 UOL 错误。 */
function throwNotificationSettingsOperationError(error: unknown): never {
  if (error instanceof AdobeCredentialNotificationSettingsError) {
    throw new OperationError(error.code, error.message);
  }
  throw error;
}

/** 注册通知设置读写 operation 的运行时执行体。 */
export function bindAdobeCredentialNotificationSettingsOperations(): void {
  bindExecute(
    "settings.getAdobeCredentialNotifications",
    async (_input: Record<string, never>, principal: Principal) => {
      if (principal.type !== "user") {
        throw new OperationError("forbidden", "超级管理员用户身份必需");
      }
      try {
        return await getAdobeCredentialNotificationSettings();
      } catch (error) {
        throwNotificationSettingsOperationError(error);
      }
    }
  );
  bindExecute(
    "settings.setAdobeCredentialNotifications",
    async (
      input: AdobeCredentialNotificationSettingsUpdate,
      principal: Principal
    ) => {
      if (principal.type !== "user") {
        throw new OperationError("forbidden", "超级管理员用户身份必需");
      }
      try {
        return await setAdobeCredentialNotificationSettings(
          input,
          principal.userId
        );
      } catch (error) {
        throwNotificationSettingsOperationError(error);
      }
    }
  );
}

bindAdobeCredentialNotificationSettingsOperations();
