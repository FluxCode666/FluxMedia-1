/** All Better Auth compatible operations are served by the Go auth gateway. */
import { proxyExternalApi } from "@/features/external-api/go-proxy";

export const GET = proxyExternalApi;
export const POST = proxyExternalApi;
