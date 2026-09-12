"use server";
import { cookies } from "next/headers";
import { z } from "zod";
import { protectedAction } from "../safe-action";
async function go<T>(path: string, init: RequestInit = {}): Promise<T> {
  const base = (process.env.GO_BACKEND_URL || "http://127.0.0.1:8080").replace(/\/$/u, "");
  const cookie = (await cookies()).getAll().map(c => `${c.name}=${c.value}`).join("; ");
  const headers = new Headers(init.headers); if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json"); if (cookie) headers.set("cookie", cookie);
  const res = await fetch(`${base}${path}`, { ...init, headers, cache: "no-store" });
  const payload = await res.json().catch(() => null) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(payload?.error?.message || `请求失败 (${res.status})`); return payload;
}
const withCredits = (name: string) => protectedAction.metadata({ action: `credits.${name}` });
export const grantRegistrationBonus = withCredits("grantRegistrationBonus").schema(z.object({})).action(async () => ({ success: true, alreadyGranted: false }));
export const getMyCreditsBalance = withCredits("getMyCreditsBalance").action(async () => { const b = await go<any>("/api/credits/balance"); return { balance: b.balance, totalEarned: b.totalEarned, totalSpent: b.totalSpent, status: b.status }; });
export const getMyActiveBatches = withCredits("getMyActiveBatches").action(async () => go<any[]>("/api/credits/active-batches"));
export const getMyTransactions = withCredits("getMyTransactions").schema(z.object({ limit: z.number().min(1).max(100).optional(), offset: z.number().min(0).optional() }).optional()).action(async ({ parsedInput }) => { const q = new URLSearchParams(); if (parsedInput?.limit) q.set("limit", String(parsedInput.limit)); if (parsedInput?.offset !== undefined) q.set("offset", String(parsedInput.offset)); return go<any>(`/api/credits/transactions?${q}`); });
export const useCredits = withCredits("useCredits").schema(z.object({ amount: z.number().positive(), serviceName: z.string().min(1), description: z.string().optional(), metadata: z.record(z.string(), z.unknown()).optional() })).action(async ({ parsedInput }) => go<any>("/api/credits/use", { method: "POST", body: JSON.stringify(parsedInput) }));
export const checkCreditsAvailable = withCredits("checkCreditsAvailable").schema(z.object({ amount: z.number().positive() })).action(async ({ parsedInput }) => go<any>("/api/credits/check", { method: "POST", body: JSON.stringify(parsedInput) }));
export const createCreditsPurchaseCheckout = withCredits("createCreditsPurchaseCheckout").schema(z.record(z.string(), z.unknown())).action(async ({ parsedInput }) => go<any>("/api/credits/purchase-checkout", { method: "POST", body: JSON.stringify(parsedInput) }));
export const getCreditPackages = withCredits("getCreditPackages").action(async () => go<any>("/api/credits/top-up/options"));
