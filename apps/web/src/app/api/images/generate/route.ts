/** First party image generation tasks are persisted and authenticated by Go. */
import { proxyExternalApi } from "@/features/external-api/go-proxy";

export const POST = proxyExternalApi;
