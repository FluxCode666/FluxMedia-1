/**
 * 文档 Base URL 的浏览器地址适配器。
 *
 * 使用方：公开接入文档、控制台接入文档与管理员系统/API 文档页面。SPA 与 Go 同源
 * 部署，浏览器地址栏的 origin 即公网来源；纯解析和输入校验委托给
 * documentation-base-url.ts。
 */
import { resolveDocumentationBaseUrl } from "./documentation-base-url";

/**
 * 返回文档示例应使用的公网 origin。
 *
 * @returns 当前页面对应的 HTTP(S) Base URL，不带尾斜杠。
 * @failure 站点回退配置非法时透传 TypeError；非法地址会安全回退。
 */
export async function getCurrentDocumentationBaseUrl(): Promise<string> {
  const { host, protocol } = window.location;
  const values: Record<string, string> = {
    host,
    "x-forwarded-proto": protocol.replace(/:$/u, ""),
  };
  return resolveDocumentationBaseUrl({
    get: (name) => values[name.toLowerCase()] ?? null,
  });
}
