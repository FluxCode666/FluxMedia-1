/**
 * API 视频已接受任务的轻量错误类型。
 *
 * 职责：只承载恢复阶段的稳定重试分类，供协议适配器、持久状态机与 DB-free 策略
 * 共享；不得依赖网络、数据库或 Web 运行时模块。
 */

/** 已接受 API 视频任务的轮询或下载错误。 */
export class ApiAcceptedVideoError extends Error {
  /**
   * 构造带稳定重试分类的 API 视频恢复错误。
   *
   * @param message - 已脱敏且可持久化的错误消息。
   * @param retryable - 是否只保留原任务并稍后重试。
   * @param statusCode - 可选上游 HTTP 状态码。
   * @param countsTowardAdapterFailure - 是否计入连续适配执行失败阈值。
   * @param options - 保留内部 cause，错误消息仍不得包含供应商敏感数据。
   */
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly statusCode?: number,
    readonly countsTowardAdapterFailure = false,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ApiAcceptedVideoError";
  }
}
