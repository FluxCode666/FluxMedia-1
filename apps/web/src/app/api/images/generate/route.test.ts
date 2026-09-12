import { describe, expect, it, vi } from "vitest";
const { proxy } = vi.hoisted(() => ({ proxy: vi.fn(async () => new Response("{}", { status: 202 })) }));
vi.mock("@/features/external-api/go-proxy", () => ({ proxyExternalApi: proxy }));
import { POST } from "./route";
describe("POST /api/images/generate", () => { it("delegates task creation to Go", async () => { const req = new Request("http://localhost/api/images/generate", { method: "POST", body: "{}" }); await POST(req); expect(proxy).toHaveBeenCalledWith(req); }); });
