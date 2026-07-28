/**
 * Adobe 上游接受请求前的鉴权单次重试策略。
 *
 * 使用方：视频图片上传与视频提交阶段。仅明确 AuthError 可以刷新同 Profile Token 后
 * 重试一次；网络错误、5xx 和结果不确定错误原样返回，防止重复生成。
 */

import { AuthError } from "@repo/shared/adobe/firefly-direct";

export type AdobeAuthRetryResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: unknown;
      rejectedToken: string;
      refreshFailed: boolean;
    };

/**
 * 使用现有 Token 执行，并在接受前明确鉴权失败时刷新后重试一次。
 *
 * @param input Token、执行函数、刷新函数及是否允许重试。
 * @returns 成功值，或最终错误、被拒 Token 与刷新是否失败。
 * @sideEffects 最多调用两次 run、一次 refresh；不会处理或记录错误。
 * @failure run/refresh 的异常均转为失败结果，调用方决定状态持久化与切号。
 */
export async function runAdobeBeforeAcceptanceWithAuthRetry<T>(input: {
  token: string;
  retryEnabled: boolean;
  signal?: AbortSignal;
  run: (token: string) => Promise<T>;
  refresh: () => Promise<string | null>;
}): Promise<AdobeAuthRetryResult<T>> {
  try {
    return { ok: true, value: await input.run(input.token) };
  } catch (firstError) {
    if (
      !input.retryEnabled ||
      !(firstError instanceof AuthError) ||
      input.signal?.aborted
    ) {
      return {
        ok: false,
        error: firstError,
        rejectedToken: input.token,
        refreshFailed: false,
      };
    }
    let refreshedToken: string | null;
    try {
      refreshedToken = await input.refresh();
    } catch {
      refreshedToken = null;
    }
    if (!refreshedToken) {
      return {
        ok: false,
        error: firstError,
        rejectedToken: input.token,
        refreshFailed: true,
      };
    }
    try {
      return { ok: true, value: await input.run(refreshedToken) };
    } catch (retryError) {
      return {
        ok: false,
        error: retryError,
        rejectedToken: refreshedToken,
        refreshFailed: false,
      };
    }
  }
}
