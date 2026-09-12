/**
 * 网站动态 Logo 公共路由。
 *
 * 职责：通过 system-only UOL 读取当前品牌配置，并以无缓存重定向返回实际资源。
 * 使用方：全站 SiteLogo 组件与 SEO 结构化数据。
 * 关键边界：本路由不代理第三方字节；读取失败时记录异常并回退内置矢量 Logo。
 */
import { proxyExternalApi } from "@/features/external-api/go-proxy";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * 返回当前 Logo 资源重定向。
 *
 * @param _request - 当前 GET 请求；重定向目标不依赖反向代理重写后的来源。
 * @returns 307 重定向；站内路径保持相对，依赖失败时指向内置 SVG。
 * @sideEffects 首次调用初始化 UOL，并读取系统设置缓存；失败时写入脱敏错误日志。
 */
export async function GET(request: Request): Promise<Response> {
  return proxyExternalApi(request);
}
