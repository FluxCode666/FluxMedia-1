/**
 * 系统设置更新 Action 错误映射。
 *
 * 职责：把 UOL 稳定错误码转换为管理员可理解的中文提示，只允许显式标记的设置
 * 校验错误透传服务端固定文案，避免内部异常、数据库信息或用户输入值泄露。
 */
import { OperationError } from "../uol/errors";

const SYSTEM_SETTING_VALIDATION_KIND = "system_setting_validation";

/**
 * 获取系统设置更新失败时可安全展示的提示。
 *
 * @param error - Action 捕获的未知错误。
 * @returns OperationError 对应的安全提示；非 UOL 错误返回 undefined 供调用方上抛。
 * @sideEffects 无。
 */
export function getSystemSettingsUpdateUserMessage(
  error: unknown
): string | undefined {
  if (!(error instanceof OperationError)) return undefined;

  switch (error.code) {
    case "forbidden":
    case "unauthenticated":
      return "无权修改系统设置";
    case "validation_error": {
      const fieldLabel = error.details?.fieldLabel;
      const reason = error.details?.reason;
      if (
        error.details?.kind === SYSTEM_SETTING_VALIDATION_KIND &&
        typeof fieldLabel === "string" &&
        fieldLabel.trim() &&
        typeof reason === "string" &&
        reason.trim()
      ) {
        return `${fieldLabel}：${reason}`;
      }
      return "系统设置参数格式不正确，请检查后重试";
    }
    default:
      return undefined;
  }
}
