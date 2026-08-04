/**
 * Firefly 直连错误类型（移植自 adobe2api core/adobe_client.py 的异常体系）。
 * 供错误分类映射（鉴权失效/配额耗尽/上游临时错误）使用。
 */

export type AdobeErrorType =
  | ""
  | "timeout"
  | "connection"
  | "proxy"
  | "network"
  | "status";

export class AdobeRequestError extends Error {
  statusCode: number | undefined;
  errorType: string;
  userMessage: string;
  requestId: string | undefined;
  adobeErrorCode: string | undefined;

  constructor(
    message: string,
    opts?: {
      statusCode?: number;
      errorType?: string;
      userMessage?: string;
      requestId?: string;
      adobeErrorCode?: string;
    }
  ) {
    super(message);
    this.name = "AdobeRequestError";
    this.statusCode = opts?.statusCode;
    this.errorType = String(opts?.errorType || "")
      .trim()
      .toLowerCase();
    this.userMessage =
      String(opts?.userMessage || "").trim() || String(message || "").trim();
    this.requestId = String(opts?.requestId || "").trim() || undefined;
    this.adobeErrorCode =
      String(opts?.adobeErrorCode || "").trim() || undefined;
  }
}

/** Adobe 账号配额耗尽（x-access-error: taste_exhausted）。 */
export class QuotaExhaustedError extends AdobeRequestError {
  constructor(
    message: string,
    opts?: { statusCode?: number; requestId?: string; adobeErrorCode?: string }
  ) {
    super(message, { ...opts, errorType: "status" });
    this.name = "QuotaExhaustedError";
  }
}

/** token 失效/过期（401/403）。 */
export class AuthError extends AdobeRequestError {
  constructor(
    message: string,
    opts?: { statusCode?: number; requestId?: string; adobeErrorCode?: string }
  ) {
    super(message, opts);
    this.name = "AuthError";
  }
}

/** 上游临时错误（408/429/451/5xx 或网络层），可重试。 */
export class UpstreamTemporaryError extends AdobeRequestError {
  constructor(
    message: string,
    opts?: {
      statusCode?: number;
      errorType?: string;
      requestId?: string;
      adobeErrorCode?: string;
    }
  ) {
    super(message, opts);
    this.name = "UpstreamTemporaryError";
  }
}

/**
 * Adobe 已接受视频任务后的轮询、下载或超时错误。
 *
 * WHY：这类错误发生时上游任务可能仍在执行，不能因凭据故障切换成员重新提交，
 * 否则会生成重复视频并重复消耗上游额度。
 */
export class AdobeAcceptedVideoError extends AdobeRequestError {
  constructor(
    message: string,
    opts?: { statusCode?: number; errorType?: string }
  ) {
    super(message, opts);
    this.name = "AdobeAcceptedVideoError";
  }
}

/**
 * Adobe 视频提交可能已被接受，但调用方没有取得可恢复任务标识。
 *
 * 这类错误不得切换成员重投；后台只能保留诊断状态，等待人工或供应商侧核对。
 */
export class AdobeVideoSubmissionUncertainError extends AdobeRequestError {
  constructor(
    message: string,
    opts?: { statusCode?: number; errorType?: string }
  ) {
    super(message, opts);
    this.name = "AdobeVideoSubmissionUncertainError";
  }
}

/**
 * 判断 Adobe 在任务尚未确认接受前返回的 HTTP 状态是否允许切换成员。
 *
 * @param status Adobe 上游 HTTP 状态码。
 * @returns 仅 408、429、451 与 5xx 返回 true；本函数无副作用。已接受视频任务
 * 必须继续通过 AdobeAcceptedVideoError 恢复原任务，不能据此切换成员重投。
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 451 || status >= 500;
}

/**
 * 是否属于可切换顶层成员的错误：408/429/451/5xx 上游临时错误、账号配额耗尽、token
 * 鉴权失效。统一调度可在提交尚未被接受时切换另一个 Adobe direct 成员；请求本身 4xx、
 * 内容拒绝和模型不支持等终态错误切换成员也无效。
 */
export function isAdobeMemberSwitchableError(error: unknown): boolean {
  return (
    error instanceof UpstreamTemporaryError ||
    error instanceof QuotaExhaustedError ||
    error instanceof AuthError
  );
}
