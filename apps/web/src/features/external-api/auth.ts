import { getBearerToken } from "./auth-token";

/**
 * Validate external API credentials in the Go gateway. The Next process no
 * longer reads `external_api_key` or `user` directly; Go updates last-used
 * timestamps and applies the banned/active predicates atomically.
 */
export async function authenticateExternalApiRequest(request: Request) {
  const token = getBearerToken(request);
  if (!token) return null;
  const base = (process.env.GO_BACKEND_URL || "http://127.0.0.1:8080").replace(/\/$/u, "");
  const response = await fetch(`${base}/api/internal/external-api/auth`, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!response.ok) return null;
  return (await response.json()) as { apiKeyId: string; userId: string };
}
