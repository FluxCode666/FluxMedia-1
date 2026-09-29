/**
 * 页面加载函数与 Action 调用 Go backend 的入口。
 *
 * 使用方：原服务端 Action 与页面加载函数。路径使用 Go 原生路径（如 /api/admin/...），
 * 浏览器同源请求自动携带会话 Cookie。
 */
export {
  GoBackendHttpError as GoBackendRequestError,
  requestGoBackendJson as requestGoJson,
  requestGoBackendResponse as requestGoResponse,
} from "@repo/shared/http/go-backend";
