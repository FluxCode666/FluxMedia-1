import { proxyExternalApi } from "@/features/external-api/go-proxy";

/**
 * First-party image task status is served by the Go gateway.
 * Ownership checks and the task response contract live in Go, so this route
 * cannot accidentally fall back to a Next.js database query.
 */
export const GET = proxyExternalApi;
