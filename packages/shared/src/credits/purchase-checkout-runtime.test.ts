import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: async () => new Headers({ cookie: "better-auth.session_token=real-session" }) }));
import { createRuntimeCreditPackagePurchaseCheckout } from "./purchase-checkout-runtime";

const fetchGo = vi.fn();
const input = { userId: "forged-body-user", packageId: "starter", clientRequestId: "6b7d1204-3f43-4da7-b2b5-b7540927e462", locale: "zh", quantity: 2 } as const;
beforeEach(() => { fetchGo.mockReset(); vi.stubGlobal("fetch", fetchGo); vi.stubEnv("GO_BACKEND_URL", "http://backend.test"); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it.each([
  { url: "https://checkout.example/session", orderId: "order-1" },
  { url: "https://epay.example/submit.php", orderId: "order-1", params: { sign: "signed" }, method: "POST" },
])("forwards the Go checkout union and authenticates with the cookie", async (output) => {
  fetchGo.mockResolvedValue(Response.json(output));
  await expect(createRuntimeCreditPackagePurchaseCheckout(input)).resolves.toEqual(output);
  const [url, init] = fetchGo.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("http://backend.test/api/credits/purchase-checkout");
  expect(init.method).toBe("POST");
  expect(init.cache).toBe("no-store");
  expect(new Headers(init.headers).get("cookie")).toBe("better-auth.session_token=real-session");
  expect(JSON.parse(String(init.body))).toEqual({ packageId: input.packageId, clientRequestId: input.clientRequestId, locale: "zh", quantity: 2 });
});

it.each([
  [409, "IDEMPOTENCY_CONFLICT", "idempotency_conflict"],
  [400, "INVALID_PACKAGE", "validation_error"],
  [503, "PROVIDER_NOT_CONFIGURED", "not_ready"],
  [401, "UNAUTHORIZED", "unauthenticated"],
])("preserves Go %s %s as %s", async (status, code, expected) => {
  fetchGo.mockResolvedValue(Response.json({ error: { code, message: "safe failure" } }, { status: Number(status) }));
  await expect(createRuntimeCreditPackagePurchaseCheckout(input)).rejects.toMatchObject({ code: expected, httpStatus: status, message: "safe failure" });
});

it("hides unexpected internal failures without claiming checkout success", async () => {
  fetchGo.mockResolvedValue(Response.json({ error: { code: "INTERNAL_SERVER_ERROR", message: "private provider data" } }, { status: 500 }));
  await expect(createRuntimeCreditPackagePurchaseCheckout(input)).rejects.toMatchObject({ code: "internal_error", message: "积分包结账暂时不可用" });
});
