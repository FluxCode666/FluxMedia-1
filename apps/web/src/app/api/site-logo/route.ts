/**
 * 网站动态 Logo 公共路由。
 *
 * 职责：通过 system-only UOL 读取当前品牌配置，并以无缓存重定向返回实际资源。
 * 使用方：全站 SiteLogo 组件与 SEO 结构化数据。
 * 关键边界：本路由不代理第三方字节；读取失败时记录异常并回退内置矢量 Logo。
 */
import { logError } from "@repo/shared/logger";
import {
  DEFAULT_SITE_LOGO_URL,
  type SiteBranding,
} from "@repo/shared/system-settings/site-branding";
import { invokeOperation } from "@repo/shared/uol";

import { ensureUolInitialized } from "@/server/uol-init";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * 把已校验的 Logo 地址序列化为可安全写入响应头的 Location。
 *
 * @param logoUrl - 第一方根路径或外部 HTTPS 地址。
 * @returns 第一方地址保持相对路径，外部地址保持绝对 URL；非 ASCII 字符已编码。
 * @sideEffects 无。
 * @failure 输入违反站点品牌输出契约、无法解析为 URL 时抛出 TypeError。
 */
function serializeLogoLocation(logoUrl: string): string {
  const parsed = new URL(logoUrl, "https://site.invalid");

  // 相对 Location 由浏览器绑定当前公网来源，避免反向代理内部地址泄露到客户端。
  return logoUrl.startsWith("/")
    ? `${parsed.pathname}${parsed.search}${parsed.hash}`
    : parsed.toString();
}

/**
 * 构造禁止缓存固化重定向目标的响应。
 *
 * @param logoUrl - 已通过 UOL 输出契约校验的 Logo 地址。
 * @returns 带 307、原始安全 Location 和 no-store 的空响应。
 * @sideEffects 无。
 */
function createLogoRedirect(logoUrl: string): Response {
  return new Response(null, {
    status: 307,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      Location: serializeLogoLocation(logoUrl),
    },
  });
}

/**
 * 返回当前 Logo 资源重定向。
 *
 * @param _request - 当前 GET 请求；重定向目标不依赖反向代理重写后的来源。
 * @returns 307 重定向；站内路径保持相对，依赖失败时指向内置 SVG。
 * @sideEffects 首次调用初始化 UOL，并读取系统设置缓存；失败时写入脱敏错误日志。
 */
export async function GET(_request: Request): Promise<Response> {
  try {
    await ensureUolInitialized();
    const branding = await invokeOperation<SiteBranding>(
      "settings.getSiteBranding",
      {},
      { type: "system", reason: "public-site-logo" },
      { requestId: crypto.randomUUID() }
    );
    return createLogoRedirect(branding.logoUrl);
  } catch (error) {
    logError(error, { source: "site-logo-route" });
    return createLogoRedirect(DEFAULT_SITE_LOGO_URL);
  }
}
