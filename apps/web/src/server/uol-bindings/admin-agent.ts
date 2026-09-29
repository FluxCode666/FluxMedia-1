/**
 * 管理员 agent 令牌 UOL late binding。
 *
 * 使用方：UOL 启动聚合器。令牌签发、列表和撤销全部委托 Go 后端
 * /api/admin/agent-tokens*，Web 进程不接触令牌哈希；本模块只负责把 Go 错误
 * 映射为 UOL 稳定错误码。
 */
import {
  bindOperationExecute,
  OperationError,
  type OperationErrorCode,
} from "@repo/shared/uol";
import {
  createAdminAgentToken,
  listAdminAgentTokens,
  revokeAdminAgentToken,
} from "@repo/shared/uol/operations/admin-agent";
import {
  GoBackendRequestError,
  requestGoJson,
} from "@/server/go-backend-client";

/**
 * 按 Go 错误码和 HTTP 状态选择 UOL 错误码。
 *
 * @param error Go 后端返回的请求错误。
 * @returns 对应的 UOL 错误码；无法识别时归为 internal_error。
 */
function goAdminAgentErrorCode(
  error: GoBackendRequestError
): OperationErrorCode {
  if (error.code === "INVALID_REQUEST") return "validation_error";
  if (error.status === 403) return "forbidden";
  if (error.status === 404) return "not_found";
  if (error.status === 409) return "conflict";
  if (error.status === 429) return "rate_limited";
  return "internal_error";
}

/**
 * 调用 Go 令牌管理接口，并把 HTTP 错误转换为 OperationError。
 *
 * @param path Go 路由路径。
 * @param method HTTP 方法。
 * @param body 可选 JSON 请求体。
 * @returns Go 返回的 JSON。
 * @throws OperationError Go 返回业务错误时抛出。
 */
async function requestAdminAgent<T>(
  path: string,
  method = "GET",
  body?: unknown
): Promise<T> {
  try {
    return await requestGoJson<T>(path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    if (error instanceof GoBackendRequestError) {
      throw new OperationError(goAdminAgentErrorCode(error), error.message);
    }
    throw error;
  }
}

bindOperationExecute(listAdminAgentTokens, async () =>
  requestAdminAgent("/api/admin/agent-tokens")
);

bindOperationExecute(createAdminAgentToken, async (input) =>
  requestAdminAgent("/api/admin/agent-tokens", "POST", input)
);

bindOperationExecute(revokeAdminAgentToken, async (input) =>
  requestAdminAgent(
    `/api/admin/agent-tokens/${encodeURIComponent(input.id)}/revoke`,
    "POST",
    {}
  )
);
