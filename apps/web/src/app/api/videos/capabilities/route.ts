import { proxyExternalApi } from "@/features/external-api/go-proxy";

/** First-party video capabilities proxy; Go is the single capabilities source. */
export const GET = proxyExternalApi;
