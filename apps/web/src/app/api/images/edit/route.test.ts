import { describe, expect, it, vi } from "vitest";
const { proxy } = vi.hoisted(() => ({ proxy: vi.fn(async () => new Response("{}", { status: 202 })) }));
vi.mock("@/features/external-api/go-proxy", () => ({ proxyExternalApi: proxy }));
import { POST } from "./route";
describe("POST /api/images/edit", () => { it("delegates multipart task creation to Go", async () => { const req = new Request("http://localhost/api/images/edit", { method: "POST", body: new FormData() }); await POST(req); expect(proxy).toHaveBeenCalledWith(req); }); });
