import { proxyExternalApi } from "@/features/external-api/go-proxy";

/** Export ownership, retention and streaming are handled by Go. */
export async function GET(request: Request, _context?: unknown) {
  return proxyExternalApi(request);
}
