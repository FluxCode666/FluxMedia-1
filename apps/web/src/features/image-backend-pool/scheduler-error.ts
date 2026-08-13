/**
 * 统一媒体后端调度的稳定错误契约。
 *
 * 职责：隔离运行时分组、获租与上层错误映射共享的错误码，不承载候选选择或数据库
 * 编排。使用方：runtime-service 与 runtime-group-selection。
 */

/** 调度失败的稳定错误码。 */
export type BackendSchedulerErrorCode =
  | "no_eligible_member"
  | "capacity_rejected"
  | "infrastructure_unavailable";

/** 上层可稳定映射且不泄露数据库细节的调度错误。 */
export class BackendSchedulerError extends Error {
  /**
   * 创建调度错误。
   *
   * @param code 稳定错误码。
   * @param message 可安全暴露给上层的错误消息。
   * @param cause 原始异常，仅供受控日志记录，不得直接返回客户端。
   */
  constructor(
    readonly code: BackendSchedulerErrorCode,
    message: string,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BackendSchedulerError";
  }
}
