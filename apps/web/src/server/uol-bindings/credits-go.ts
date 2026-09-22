/** All credit UOL requests use Go for identity, pagination and ledger updates. */
import { bindExecute, OperationError, type Principal } from "@repo/shared/uol";
import { GoBackendRequestError, requestGoJson, requestGoJsonForPrincipal } from "@/server/go-backend-client";
import { toCreditPackageCheckoutGoError } from "@repo/shared/credits/purchase-checkout-runtime";

type GoTransaction = { id: string; type: string; amount: number; sourceRef: string | null; createdAt: string };
type GoTransactions = { transactions: GoTransaction[]; totalCount: number };
type GoBatch = { id: string; sourceType: string; remaining: number; expiresAt: string | null; issuedAt: string };
type CreditInput = { userId: string; amount: number; sourceType?: string; sourceRef?: string; reason?: string; expiresAt?: string };
function user(p: Principal) {
  if (p.type !== "user" && p.type !== "apiKey") throw new OperationError("unauthenticated", "User authentication required");
  return p;
}
function admin(p: Principal, superAdmin = false) {
  if (p.type !== "user" || (superAdmin ? p.role !== "super_admin" : !["admin", "super_admin"].includes(p.role))) throw new OperationError("forbidden", "Administrator access required");
  return p;
}
async function go<T>(p: Principal, path: string, init?: RequestInit): Promise<T> {
  try {
    return p.type === "apiKey" ? await requestGoJsonForPrincipal<T>(p, path, init) : await requestGoJson<T>(path, init);
  } catch (e) {
    if (e instanceof GoBackendRequestError) {
      const code = e.code === "ACCOUNT_FROZEN" ? "account_frozen" : e.code === "INSUFFICIENT_CREDITS" ? "insufficient_credits" : e.code === "IDEMPOTENCY_CONFLICT" ? "idempotency_conflict" : e.status === 401 ? "unauthenticated" : e.status === 403 ? "forbidden" : e.status === 404 ? "not_found" : e.status === 400 ? "validation_error" : "internal_error";
      throw new OperationError(code, e.message, undefined, e.status);
    }
    throw e;
  }
}
async function internal<T>(principal: Principal, operation: string, input: object): Promise<T> {
  const headers: Record<string, string> = {};
  if (principal.type === "system" || principal.type === "cron") {
    const secret = process.env.CRON_SECRET?.trim();
    if (!secret) throw new OperationError("not_ready", "积分维护服务未配置");
    headers.authorization = `Bearer ${secret}`;
  }
  return go<T>(principal, "/api/internal/credits/operation", { method: "POST", headers, body: JSON.stringify({ ...input, operation }) });
}
const adminPath = (uid: string, resource: string) => `/api/admin/users/${encodeURIComponent(uid)}/credits/${resource}`;
function batches(raw: GoBatch[]) { return { batches: raw.map((b) => ({ id: b.id, sourceType: b.sourceType, remaining: b.remaining, expiresAt: b.expiresAt, createdAt: b.issuedAt })) }; }
function transactions(raw: GoTransactions) { return { transactions: raw.transactions.map((t) => ({ id: t.id, type: t.type, amount: t.amount, sourceRef: t.sourceRef, createdAt: t.createdAt })), total: raw.totalCount }; }
function pagination(input: { limit?: number; offset?: number }) { return new URLSearchParams({ limit: String(input.limit ?? 20), offset: String(input.offset ?? 0) }); }

bindExecute("credits.getBalance", async (input: { userId: string }, principal) => {
  if (principal.type === "system") return internal<{ balance: number }>(principal, "getBalance", input);
  const p = user(principal);
  if (p.userId === input.userId) { const raw = await go<{ balance: number }>(p, "/api/credits/balance"); return { balance: raw.balance }; }
  admin(principal);
  const raw = await go<{ balance: number }>(principal, adminPath(input.userId, "balance")); return { balance: raw.balance };
});
bindExecute("credits.checkAvailable", async (input: { amount: number }, principal) => {
  user(principal);
  const raw = await go<{ available: boolean; currentBalance: number }>(principal, "/api/credits/check", { method: "POST", body: JSON.stringify(input) });
  return { available: raw.available, balance: raw.currentBalance };
});
bindExecute("credits.useCredits", async (input: { amount: number; reason?: string }, principal) => {
  user(principal);
  const raw = await go<{ success: boolean; remainingBalance: number }>(principal, "/api/credits/use", { method: "POST", body: JSON.stringify({ amount: input.amount, serviceName: "manual", description: input.reason }) });
  return { success: raw.success, balance: raw.remainingBalance };
});
bindExecute("credits.getMyActiveBatches", async (_input, principal) => { user(principal); return batches(await go<GoBatch[]>(principal, "/api/credits/active-batches")); });
bindExecute("credits.getMyTransactions", async (input: { limit: number; offset: number }, principal) => { user(principal); return transactions(await go<GoTransactions>(principal, `/api/credits/transactions?${pagination(input)}`)); });
bindExecute("credits.getUserActiveBatches", async (input: { userId: string }, principal) => { admin(principal); return batches(await go<GoBatch[]>(principal, adminPath(input.userId, "active-batches"))); });
bindExecute("credits.getUserTransactions", async (input: { userId: string; limit: number; offset: number }, principal) => { admin(principal); return transactions(await go<GoTransactions>(principal, `${adminPath(input.userId, "transactions")}?${pagination(input)}`)); });
bindExecute("credits.getUserTransactionCount", async (input: { userId: string }, principal) => { admin(principal); const raw = await go<GoTransactions>(principal, `${adminPath(input.userId, "transactions")}?limit=1`); return { count: raw.totalCount }; });
bindExecute("credits.adminGrant", async (input: CreditInput, principal) => {
  admin(principal);
  const raw = await go<{ batchId: string; balance: number }>(principal, adminPath(input.userId, "grant"), { method: "POST", body: JSON.stringify(input) });
  return { batchId: raw.batchId, balance: raw.balance };
});
bindExecute("credits.adminAdjust", async (input: { userId: string; mode: "set" | "deduct"; amount: number; reason?: string }, principal) => {
  admin(principal, true);
  const raw = await go<{ previousBalance: number; newBalance: number }>(principal, adminPath(input.userId, "adjust"), { method: "POST", body: JSON.stringify(input) });
  return { previousBalance: raw.previousBalance, newBalance: raw.newBalance };
});
async function status(input: { userId: string; status: "active" | "frozen" }, principal: Principal) { admin(principal); await go(principal, adminPath(input.userId, "status"), { method: "POST", body: JSON.stringify({ status: input.status }) }); return { success: true }; }
bindExecute("credits.setStatus", status);
bindExecute("credits.freeze", async (input: { userId: string }, principal) => status({ ...input, status: "frozen" }, principal));
bindExecute("credits.unfreeze", async (input: { userId: string }, principal) => status({ ...input, status: "active" }, principal));
bindExecute("credits.grant", async (input: CreditInput, principal) => { if (principal.type !== "system") admin(principal); return internal(principal, "grant", input); });
bindExecute("credits.consume", async (input: CreditInput & { type: string }, principal) => { if (principal.type !== "system" && user(principal).userId !== input.userId) throw new OperationError("forbidden", "Cannot consume another user's credits"); return internal(principal, "consume", input); });
bindExecute("credits.refund", async (input: object, principal) => { if (principal.type !== "system") throw new OperationError("forbidden", "System identity required"); return internal(principal, "refund", input); });
bindExecute("credits.processExpired", async (input: { userId: string }, principal) => { if (principal.type !== "system") throw new OperationError("forbidden", "System identity required"); return internal(principal, "processExpired", input); });
bindExecute("credits.runExpireJob", async (_input, principal) => {
  if (principal.type !== "cron" && principal.type !== "system") throw new OperationError("forbidden", "Cron identity required");
  const secret = process.env.CRON_SECRET?.trim(); if (!secret) throw new OperationError("not_ready", "积分维护服务未配置");
  const raw = await go<{ usersProcessed: number; batchesExpired: number }>(principal, "/api/jobs/credits/expire", { method: "POST", headers: { authorization: `Bearer ${secret}` } });
  return { usersProcessed: raw.usersProcessed, batchesExpired: raw.batchesExpired };
});
bindExecute("credits.createPurchaseCheckout", async (input: { packageId: string; clientRequestId: string; locale: "en" | "zh"; quantity?: number }, principal) => {
  if (principal.type !== "user") throw new OperationError("unauthenticated", "User session authentication required");
  try {
    return await requestGoJson("/api/credits/purchase-checkout", {
      method: "POST",
      body: JSON.stringify({ packageId: input.packageId, clientRequestId: input.clientRequestId, locale: input.locale, ...(input.quantity !== undefined ? { quantity: input.quantity } : {}) }),
    });
  } catch (error) {
    throw toCreditPackageCheckoutGoError(error);
  }
});
