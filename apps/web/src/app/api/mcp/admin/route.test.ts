import { describe, expect, it, vi } from "vitest";
const { proxy } = vi.hoisted(() => ({ proxy: vi.fn(async () => new Response("ok", { status: 200 })) }));
vi.mock("@/features/external-api/go-proxy", () => ({ proxyExternalApi: proxy }));
import { POST } from "./route";
describe("POST /api/mcp/admin", () => { it("delegates to Go", async () => { const req = new Request("http://localhost/api/mcp/admin", { method: "POST", body: "{}" }); await POST(req); expect(proxy).toHaveBeenCalledWith(req); }); });
