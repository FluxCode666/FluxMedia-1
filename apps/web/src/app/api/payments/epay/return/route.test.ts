import { describe, expect, it, vi } from "vitest";
const { proxy } = vi.hoisted(() => ({ proxy: vi.fn(async () => new Response(null, { status: 302 })) }));
vi.mock("@/features/external-api/go-proxy", () => ({ proxyExternalApi: proxy }));
import { GET, POST } from "./route";
describe("Epay return route", () => { it.each([GET, POST])("delegates to Go", async (handler) => { const req = new Request("http://localhost/api/payments/epay/return", { method: handler === GET ? "GET" : "POST" }); await handler(req); expect(proxy).toHaveBeenCalledWith(req); }); });
