/** 视频人工核对入口由 Go 统一返回已下线语义，Next 只保留传输代理。 */
import { proxyExternalApi } from "@/features/external-api/go-proxy";

export const GET = proxyExternalApi;
export const POST = proxyExternalApi;
