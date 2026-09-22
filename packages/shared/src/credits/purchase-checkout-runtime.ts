/** Credit package checkout is implemented by Go, with identity from the forwarded session. */
import { requestGoBackendJson } from "../http/go-backend";
import { OperationError } from "../uol/errors";
import type { CreditPackagePurchaseCheckoutInput, CreditPackagePurchaseCheckoutOutput } from "./purchase-checkout-service";

export async function createRuntimeCreditPackagePurchaseCheckout(
  input: CreditPackagePurchaseCheckoutInput
): Promise<CreditPackagePurchaseCheckoutOutput> {
  try {
    return await requestGoBackendJson<CreditPackagePurchaseCheckoutOutput>("/api/credits/purchase-checkout", {
      method: "POST",
      body: JSON.stringify({
        packageId: input.packageId,
        clientRequestId: input.clientRequestId,
        locale: input.locale,
        ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
      }),
    });
  } catch (error) {
    throw toCreditPackageCheckoutGoError(error);
  }
}

/** Both shared and app Go clients expose this HTTP error shape. Preserve the UOL vocabulary. */
export function toCreditPackageCheckoutGoError(error: unknown): unknown {
  if (!(error instanceof Error) || !("status" in error) || typeof error.status !== "number") return error;
  const reason = "code" in error && typeof error.code === "string" ? error.code.toLowerCase() : "";
  const notReady = ["payment_disabled", "provider_not_configured", "unsupported_provider", "not_ready"].includes(reason);
  const code = reason === "idempotency_conflict" || error.status === 409 ? "idempotency_conflict"
    : notReady || error.status === 503 ? "not_ready"
    : error.status === 400 ? "validation_error"
    : error.status === 401 ? "unauthenticated"
    : error.status === 403 ? "forbidden"
    : error.status === 429 ? "rate_limited"
    : error.status === 408 || error.status === 504 ? "timeout"
    : error.status === 502 ? "upstream_error" : "internal_error";
  const userSafe = code === "validation_error" || code === "not_ready" || code === "idempotency_conflict";
  return new OperationError(
    code,
    code === "internal_error" ? "积分包结账暂时不可用" : error.message,
    userSafe ? { userSafe: true, reason: reason || code } : undefined,
    error.status
  );
}
