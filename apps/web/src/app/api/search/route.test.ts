import { describe, expect, it, vi } from "vitest";
const { proxy } = vi.hoisted(() => ({ proxy: vi.fn(async () => new Response("ok", { status: 200 })) }));
vi.mock("@/features/external-api/go-proxy", () => ({ proxyExternalApi: proxy }));
import { GET } from "./route";
describe("GET /api/search", () => { it("delegates to Go", async () => { const req = new Request("http://localhost/api/search?query=x"); await GET(req); expect(proxy).toHaveBeenCalledWith(req); }); });
