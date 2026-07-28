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
 * 构造禁止缓存固化重定向目标的响应。
 *
 * @param request - 当前请求，用于把站内根路径解析为当前来源绝对地址。
 * @param logoUrl - 已通过 UOL 输出契约校验的 Logo 地址。
 * @returns 带 307、Location 和 no-store 的空响应。
 * @sideEffects 无。
 */
function createLogoRedirect(request: Request, logoUrl: string): Response {
  return new Response(null, {
    status: 307,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      Location: new URL(logoUrl, request.url).toString(),
    },
  });
}

/**
 * 返回当前 Logo 资源重定向。
 *
 * @param request - 当前同源 GET 请求，用于解析站内根路径。
 * @returns 307 重定向；成功指向动态配置，依赖失败指向内置 SVG。
 * @sideEffects 首次调用初始化 UOL，并读取系统设置缓存；失败时写入脱敏错误日志。
 */
export async function GET(request: Request): Promise<Response> {
  try {
    await ensureUolInitialized();
    const branding = await invokeOperation<SiteBranding>(
      "settings.getSiteBranding",
      {},
      { type: "system", reason: "public-site-logo" },
      { requestId: crypto.randomUUID() }
    );
    return createLogoRedirect(request, branding.logoUrl);
  } catch (error) {
    logError(error, { source: "site-logo-route" });
    return createLogoRedirect(request, DEFAULT_SITE_LOGO_URL);
  }
}
