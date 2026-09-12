import { proxyExternalApi } from "@/features/external-api/go-proxy";

/** 处理 Epay GET 同步回跳。 */
export const GET = proxyExternalApi;

/** 处理部分 Epay 网关使用的 POST 同步回跳。 */
export const POST = proxyExternalApi;
