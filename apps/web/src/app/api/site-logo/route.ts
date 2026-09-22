/** 网站 Logo 传输路由；品牌配置、回退策略与重定向由 Go 后端处理。 */
import { proxyExternalApi } from "@/features/external-api/go-proxy";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const GET = proxyExternalApi;
