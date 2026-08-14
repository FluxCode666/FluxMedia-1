/**
 * 系统设置领域错误。
 *
 * 职责：让设置值语义校验失败与数据库、缓存等基础设施错误保持可区分，供 UOL
 * 映射为可安全展示的 validation_error，同时避免携带用户提交值或未知键名。
 */

/** 系统设置值未通过已注册定义的类型、范围或业务约束。 */
export class SystemSettingValidationError extends Error {
  readonly kind = "system_setting_validation" as const;
  readonly fieldLabel: string;
  readonly reason: string;

  /**
   * 创建一个不包含设置值的安全校验错误。
   *
   * @param fieldLabel - 来自服务端设置定义的静态中文字段名称。
   * @param reason - 由服务端固定逻辑生成的校验失败原因。
   */
  constructor(fieldLabel: string, reason: string) {
    super(`${fieldLabel}：${reason}`);
    this.name = "SystemSettingValidationError";
    this.fieldLabel = fieldLabel;
    this.reason = reason;
  }
}
