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

  constructor(
    message: string,
    opts?: { statusCode?: number; errorType?: string; userMessage?: string }
  ) {
    super(message);
    this.name = "AdobeRequestError";
    this.statusCode = opts?.statusCode;
    this.errorType = String(opts?.errorType || "")
      .trim()
      .toLowerCase();
    this.userMessage =
      String(opts?.userMessage || "").trim() || String(message || "").trim();
  }
}

/** Adobe 账号配额耗尽（x-access-error: taste_exhausted）。 */
export class QuotaExhaustedError extends AdobeRequestError {
  constructor(message: string, opts?: { statusCode?: number }) {
    super(message, { ...opts, errorType: "status" });
    this.name = "QuotaExhaustedError";
  }
}

/** token 失效/过期（401/403）。 */
export class AuthError extends AdobeRequestError {
  constructor(message: string, opts?: { statusCode?: number }) {
    super(message, opts);
    this.name = "AuthError";
  }
}

/** 上游临时错误（429/451/5xx 或网络层），可重试。 */
export class UpstreamTemporaryError extends AdobeRequestError {
  constructor(
    message: string,
    opts?: { statusCode?: number; errorType?: string }
  ) {
    super(message, opts);
    this.name = "UpstreamTemporaryError";
  }
}

/**
 * Adobe 已接受视频任务后的轮询、下载或超时错误。
 *
 * WHY：这类错误发生时上游任务可能仍在执行，不能按普通可轮换错误
 * 换 token 或换成员重新提交，否则会生成重复视频并重复消耗上游额度。
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
 * 这类错误不得换 token 或成员重投；后台只能保留诊断状态，等待人工或供应商侧核对。
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

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 451 || status >= 500;
}

/**
 * 是否属于"换 token/账号重试"类错误：429/451/5xx 上游临时错误、账号配额耗尽、token
 * 鉴权失效。这些都是账号/凭据级问题——同一 Adobe 后端（伪账号）下换一个账号可能成功，
 * 故 Adobe 直连应在后端内轮换所有可用账号后才上抛。非此类（请求本身 4xx、内容拒绝、
 * 模型不支持等）换号也无用，直接上抛。
 */
export function isAdobeRotatableError(error: unknown): boolean {
  return (
    error instanceof UpstreamTemporaryError ||
    error instanceof QuotaExhaustedError ||
    error instanceof AuthError
  );
}
