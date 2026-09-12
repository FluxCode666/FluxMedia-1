/**
 * 管理员文档的全文搜索 API。
 *
 * 搜索索引包含 /docs 下的内部架构内容，因此在调用 Fumadocs 搜索处理器前执行与文档
 * 页面一致的真实角色校验，关闭绕过页面守卫直接枚举索引的旁路。
 */
import { proxyExternalApi } from "@/features/external-api/go-proxy";

export const GET = proxyExternalApi;
