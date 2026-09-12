/** First party image editing, multipart staging and task persistence are handled by Go. */
import { proxyExternalApi } from "@/features/external-api/go-proxy";

export const POST = proxyExternalApi;
