import { proxyExternalApi } from "@/features/external-api/go-proxy";

/** First-party video task status proxy; authorization is enforced by Go. */
export const GET = proxyExternalApi;
