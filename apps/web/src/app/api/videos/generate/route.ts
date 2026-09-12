import { proxyExternalApi } from "@/features/external-api/go-proxy";

/**
 * First-party video generation proxy. Go owns validation, persistence,
 * billing, and task admission; this route contains no Next.js UOL/DB path.
 */
export const POST = proxyExternalApi;
