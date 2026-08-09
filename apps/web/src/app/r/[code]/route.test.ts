/** 推广短链 cookie、本地化跳转与公开地址契约测试。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

describe("GET /r/[code]", () => {
  beforeEach(() => {
    vi.stubEnv("BETTER_AUTH_URL", "https://media.example.test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stores a normalized referral code and follows locale preference", async () => {
    const response = await GET(
      new Request("https://media.example.test/r/abc123", {
        headers: { cookie: "NEXT_LOCALE=en" },
      }),
      { params: Promise.resolve({ code: "abc123" }) }
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://media.example.test/en/sign-up"
    );
    expect(response.headers.get("set-cookie")).toContain(
      "fluxmedia_referral_code=ABC123"
    );
  });

  it("does not store malformed codes", async () => {
    const response = await GET(
      new Request("https://media.example.test/r/bad!"),
      { params: Promise.resolve({ code: "bad!" }) }
    );
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("does not redirect to the container bind address", async () => {
    const response = await GET(
      new Request("https://0.0.0.0:3000/r/abc123"),
      { params: Promise.resolve({ code: "abc123" }) }
    );

    expect(response.headers.get("location")).toBe(
      "https://media.example.test/zh/sign-up"
    );
  });

  it("falls back to the canonical site when configured origins are internal", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://0.0.0.0:3000");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");

    const response = await GET(
      new Request("https://0.0.0.0:3000/r/abc123"),
      { params: Promise.resolve({ code: "abc123" }) }
    );

    expect(response.headers.get("location")).toBe(
      "https://media.flux-code.cc/zh/sign-up"
    );
  });
});
