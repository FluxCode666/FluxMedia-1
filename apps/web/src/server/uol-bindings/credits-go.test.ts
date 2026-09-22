import { beforeEach, expect, it, vi } from "vitest";

const go = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/server/go-backend-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/go-backend-client")>()),
  requestGoJson: go.request,
}));

import { invokeOperation } from "@repo/shared/uol";
import "@repo/shared/uol/operations";
import "./credits-go";
import { GoBackendRequestError } from "@/server/go-backend-client";

const input = { packageId: "starter", clientRequestId: "6b7d1204-3f43-4da7-b2b5-b7540927e462", locale: "zh", quantity: 2 } as const;
const principal = { type: "user", userId: "session-user", role: "user" } as const;
beforeEach(() => { go.request.mockReset(); });

it("executes credit package checkout through Go instead of a local retired response", async () => {
  const checkout = { url: "https://epay.example/submit.php", params: { sign: "signed" }, method: "POST", orderId: "order-1" };
  go.request.mockResolvedValue(checkout);
  await expect(invokeOperation("credits.createPurchaseCheckout", input, principal)).resolves.toEqual(checkout);
  expect(go.request).toHaveBeenCalledWith("/api/credits/purchase-checkout", { method: "POST", body: JSON.stringify(input) });
});

it("rejects body-selected identity before requesting a checkout", async () => {
  await expect(invokeOperation("credits.createPurchaseCheckout", { ...input, userId: "another-user" }, principal)).rejects.toMatchObject({ code: "validation_error" });
  expect(go.request).not.toHaveBeenCalled();
});

it.each([
  [409, "IDEMPOTENCY_CONFLICT", "idempotency_conflict"],
  [400, "QUANTITY_EXCEEDED", "validation_error"],
  [503, "PAYMENT_DISABLED", "not_ready"],
])("retains Go %s %s as %s", async (status, code, expected) => {
  go.request.mockRejectedValue(new GoBackendRequestError("safe failure", Number(status), String(code)));
  await expect(invokeOperation("credits.createPurchaseCheckout", input, principal)).rejects.toMatchObject({ code: expected, httpStatus: status, details: { userSafe: true, reason: String(code).toLowerCase() } });
});
