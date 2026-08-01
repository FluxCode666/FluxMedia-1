/**
 * API 上游认证 Header 注入。
 *
 * 职责：在脚本和业务 Header 合并完成后，由宿主按账号认证模式最后写入凭据。
 * 使用方：通用 API 上游执行器；本模块不记录、不返回或向脚本暴露密钥。
 */
import type { ApiUpstreamAdapterDraft } from "@repo/shared/image-backend/api-upstream-adaptation";

/** 认证配置中实际占用的 Header 名；无认证返回 null。 */
export function getApiUpstreamAuthenticationHeaderName(
  authentication: ApiUpstreamAdapterDraft["authentication"]
): string | null {
  return authentication.mode === "none"
    ? null
    : authentication.mode === "custom_header"
      ? authentication.headerName
      : "Authorization";
}

/**
 * 根据当前凭据和固定版本认证形态创建宿主 Header。
 *
 * @throws 非 none 模式缺少凭据时失败关闭。
 */
export function createApiUpstreamAuthenticationHeaders(
  authentication: ApiUpstreamAdapterDraft["authentication"],
  apiKey: string | null
): Record<string, string> {
  if (authentication.mode === "none") return {};
  if (!apiKey?.trim()) throw new Error("API 上游认证缺少账号凭据");
  if (/\r|\n/u.test(apiKey)) {
    throw new Error("API 上游认证凭据包含非法换行符");
  }
  if (authentication.mode === "bearer") {
    return { Authorization: `Bearer ${apiKey}` };
  }
  if (authentication.mode === "raw_authorization") {
    return { Authorization: apiKey };
  }
  return { [authentication.headerName]: apiKey };
}
