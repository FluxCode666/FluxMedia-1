import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ cookie: "better-auth.session_token=real-session" }),
  cookies: async () => ({ getAll: () => [{ name: "better-auth.session_token", value: "real-session" }] }),
}));
vi.mock("../safe-action", () => {
  function builder(schema?: { parse(input: unknown): unknown }) {
    return {
      schema: (value: { parse(input: unknown): unknown }) => builder(value),
      action: (handler: (context: { parsedInput: unknown; ctx: { userId: string } }) => unknown) => (input?: unknown) => handler({ parsedInput: schema ? schema.parse(input) : input, ctx: { userId: "session-user" } }),
    };
  }
  return { protectedAction: { metadata: () => builder() } };
});
import { createCreditsPurchaseCheckout, getCreditPackages } from "./actions";

const fetchGo = vi.fn();
const input = { packageId: "starter", clientRequestId: "6b7d1204-3f43-4da7-b2b5-b7540927e462", locale: "zh", quantity: 2 } as const;
beforeEach(() => { fetchGo.mockReset(); vi.stubGlobal("fetch", fetchGo); vi.stubEnv("GO_BACKEND_URL", "http://backend.test"); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const checkoutAction = createCreditsPurchaseCheckout as unknown as (input: unknown) => Promise<unknown>;
const packagesAction = getCreditPackages as unknown as () => Promise<unknown>;

it("restores the package checkout action with the existing input and Go endpoint", async () => {
  const output = { url: "https://checkout.example/session", orderId: "order-1" };
  fetchGo.mockResolvedValue(Response.json(output));
  await expect(checkoutAction(input)).resolves.toEqual(output);
  const [url, init] = fetchGo.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("http://backend.test/api/credits/purchase-checkout");
  expect(init.method).toBe("POST");
  expect(JSON.parse(String(init.body))).toEqual(input);
  expect(new Headers(init.headers).get("cookie")).toContain("real-session");
});

it("uses the package list endpoint and preserves its array response", async () => {
  const packages = [{ id: "starter", credits: 1000, price: 20, currency: "CNY" }];
  fetchGo.mockResolvedValue(Response.json(packages));
  await expect(packagesAction()).resolves.toEqual(packages);
  expect(fetchGo.mock.calls[0]?.[0]).toBe("http://backend.test/api/credits/packages");
});

it.each([{ ...input, userId: "forged" }, { ...input, quantity: 1000 }, { ...input, clientRequestId: "not-a-uuid" }])("rejects invalid checkout input before transport", async (value) => {
  expect(() => checkoutAction(value)).toThrow();
  expect(fetchGo).not.toHaveBeenCalled();
});

it("preserves an idempotency conflict from Go", async () => {
  fetchGo.mockResolvedValue(Response.json({ error: { code: "IDEMPOTENCY_CONFLICT", message: "请求已用于另一份积分包" } }, { status: 409 }));
  await expect(checkoutAction(input)).rejects.toMatchObject({ code: "idempotency_conflict", httpStatus: 409 });
});
