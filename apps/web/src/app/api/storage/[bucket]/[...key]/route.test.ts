import { describe, expect, it, vi } from "vitest";
const { proxy } = vi.hoisted(() => ({ proxy: vi.fn(async () => new Response("ok", { status: 200 })) }));
vi.mock("@/features/external-api/go-proxy", () => ({ proxyExternalApi: proxy }));
import { DELETE, GET, PUT } from "./route";
describe("storage route", () => { it.each([GET, PUT, DELETE])("delegates requests to Go", async (handler) => { const req = new Request("http://localhost/api/storage/generations/key", { method: handler === GET ? "GET" : handler === PUT ? "PUT" : "DELETE" }); await handler(req); expect(proxy).toHaveBeenCalledWith(req); }); });
