/** 推广短链 cookie 与本地化跳转契约测试。 */
import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /r/[code]", () => {
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
});
