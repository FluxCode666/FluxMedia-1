/**
 * 文档 Base URL 的 Next.js 服务端请求适配器。
 *
 * 使用方：公开接入文档、控制台接入文档与管理员系统/API 文档页面。关键依赖是
 * next/headers；纯解析和输入校验委托给 documentation-base-url.ts。
 */
import "server-only";

import { headers } from "next/headers";

import { resolveDocumentationBaseUrl } from "./documentation-base-url";

/**
 * 读取当前请求头并返回文档示例应使用的公网 origin。
 *
 * @returns 当前请求对应的 HTTP(S) Base URL，不带尾斜杠。
 * @sideEffects 调用 Next.js headers()，使调用页面按请求动态渲染。
 * @failure 站点回退配置非法时透传 TypeError；非法请求头会安全回退。
 */
export async function getCurrentDocumentationBaseUrl(): Promise<string> {
  return resolveDocumentationBaseUrl(await headers());
}
