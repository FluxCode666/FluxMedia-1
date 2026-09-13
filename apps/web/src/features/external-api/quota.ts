import { createHmac } from "node:crypto";

import {
  ExternalApiKeyQuotaExceededError,
  roundQuotaCredits,
} from "./quota-math";

export {
  ExternalApiKeyQuotaExceededError,
  getExternalApiKeyQuotaRemaining,
  isExternalApiKeyQuotaExceededError,
  normalizeExternalApiKeyCreditLimit,
} from "./quota-math";

type QuotaSnapshot = {
  id: string;
  name: string;
  keyPrefix: string;
  lastFour: string;
  isActive: boolean;
  creditLimit: number | null;
  creditsUsed: number;
  lastUsedAt: string | null;
  createdAt: string;
  creditsRemaining: number | null;
};

async function requestGoQuota<T>(input: {
  action: "get" | "reserve" | "refund";
  userId: string;
  apiKeyId: string;
  amount?: number;
}): Promise<T> {
  const base = (process.env.GO_BACKEND_URL || "http://127.0.0.1:8080").replace(/\/$/u, "");
  const body = JSON.stringify(input);
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret?.trim()) throw new Error("BETTER_AUTH_SECRET is required for Go quota bridge");
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  const response = await fetch(`${base}/api/internal/external-api/quota`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-go-internal-signature": signature },
    body,
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
  if (!response.ok) throw new Error(payload?.error?.message || `Go quota request failed (${response.status})`);
  return payload as T;
}

export async function getExternalApiKeyQuota(params: { apiKeyId: string; userId: string }) {
  return requestGoQuota<QuotaSnapshot>({ action: "get", ...params });
}

export async function reserveExternalApiKeyCredits(params: { apiKeyId?: string; userId: string; amount: number }) {
  if (!params.apiKeyId) return;
  const amount = roundQuotaCredits(params.amount);
  if (amount <= 0) return;
  try {
    return await requestGoQuota({ action: "reserve", userId: params.userId, apiKeyId: params.apiKeyId, amount });
  } catch (_error) {
    const quota = await getExternalApiKeyQuota({ apiKeyId: params.apiKeyId, userId: params.userId });
    const remaining = quota.creditsRemaining ?? Number.POSITIVE_INFINITY;
    throw new ExternalApiKeyQuotaExceededError(amount, Number.isFinite(remaining) ? remaining : amount, quota.creditLimit, quota.creditsUsed);
  }
}

export async function refundExternalApiKeyCredits(params: { apiKeyId?: string; userId: string; amount: number }) {
  if (!params.apiKeyId) return;
  const amount = roundQuotaCredits(params.amount);
  if (amount <= 0) return;
  await requestGoQuota({ action: "refund", userId: params.userId, apiKeyId: params.apiKeyId, amount });
}
