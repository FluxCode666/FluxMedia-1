/** 站点公开地址解析契约测试，覆盖容器监听地址拒绝与默认回退。 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SITE_URL,
  normalizePublicAppUrl,
  resolvePublicAppUrl,
} from "./site";

describe("public site URL", () => {
  it("rejects container bind addresses by default", () => {
    expect(normalizePublicAppUrl("https://0.0.0.0:3000")).toBeNull();
    expect(normalizePublicAppUrl("http://localhost:3000")).toBeNull();
  });

  it("keeps local addresses available when explicitly allowed", () => {
    expect(
      normalizePublicAppUrl("http://localhost:3000", { allowInternal: true })
    ).toBe("http://localhost:3000");
  });

  it("falls back to the canonical public site when candidates are invalid", () => {
    expect(resolvePublicAppUrl(["https://0.0.0.0:3000", "not-a-url"])).toBe(
      DEFAULT_SITE_URL
    );
  });
});
