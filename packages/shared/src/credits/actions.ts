import { z } from "zod";
import { protectedAction } from "../safe-action";
import { createPurchaseCheckoutInputSchema } from "./purchase-checkout-input";
import { createRuntimeCreditPackagePurchaseCheckout } from "./purchase-checkout-runtime";
import type { RuntimeCreditPackage } from "./packages";
import { requestGoBackendJson, type UntypedGoBackendJson } from "../http/go-backend";
const go = <T>(path: string, init: RequestInit = {}) => requestGoBackendJson<T>(path, init);
const withCredits = (name: string) => protectedAction.metadata({ action: `credits.${name}` });
export const grantRegistrationBonus = withCredits("grantRegistrationBonus").schema(z.object({})).action(async () => go<{ success: boolean; alreadyGranted: boolean; granted: boolean }>("/api/credits/registration-bonus", { method: "POST" }));
export const getMyCreditsBalance = withCredits("getMyCreditsBalance").action(async () => { const b = await go<UntypedGoBackendJson>("/api/credits/balance?registrationBonus=1"); return { balance: b.balance, totalEarned: b.totalEarned, totalSpent: b.totalSpent, status: b.status }; });
export const getMyActiveBatches = withCredits("getMyActiveBatches").action(async () => go<UntypedGoBackendJson[]>("/api/credits/active-batches"));
export const getMyTransactions = withCredits("getMyTransactions").schema(z.object({ limit: z.number().min(1).max(100).optional(), offset: z.number().min(0).optional() }).optional()).action(async ({ parsedInput }) => { const q = new URLSearchParams(); if (parsedInput?.limit) q.set("limit", String(parsedInput.limit)); if (parsedInput?.offset !== undefined) q.set("offset", String(parsedInput.offset)); return go<UntypedGoBackendJson>(`/api/credits/transactions?${q}`); });
export const useCredits = withCredits("useCredits").schema(z.object({ amount: z.number().positive(), serviceName: z.string().min(1), description: z.string().optional(), metadata: z.record(z.string(), z.unknown()).optional() })).action(async ({ parsedInput }) => go<UntypedGoBackendJson>("/api/credits/use", { method: "POST", body: JSON.stringify(parsedInput) }));
export const checkCreditsAvailable = withCredits("checkCreditsAvailable").schema(z.object({ amount: z.number().positive() })).action(async ({ parsedInput }) => go<UntypedGoBackendJson>("/api/credits/check", { method: "POST", body: JSON.stringify(parsedInput) }));
export const createCreditsPurchaseCheckout = withCredits("createCreditsPurchaseCheckout")
  .schema(createPurchaseCheckoutInputSchema)
  .action(async ({ parsedInput, ctx }) => {
    const { quantity, ...requiredInput } = parsedInput;
    return createRuntimeCreditPackagePurchaseCheckout({
      ...requiredInput,
      userId: ctx.userId,
      ...(quantity === undefined ? {} : { quantity }),
    });
  });
export const getCreditPackages = withCredits("getCreditPackages").action(async () => requestGoBackendJson<RuntimeCreditPackage[]>("/api/credits/packages"));
