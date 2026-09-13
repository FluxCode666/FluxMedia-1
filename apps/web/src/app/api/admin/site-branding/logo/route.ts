import { proxyExternalApi } from "@/features/external-api/go-proxy";

/** Site logo validation, storage and settings persistence are owned by Go. */
export async function POST(request: Request): Promise<Response> {
  return proxyExternalApi(request);
}
