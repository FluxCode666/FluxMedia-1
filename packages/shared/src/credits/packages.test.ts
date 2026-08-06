import { describe, expect, it } from "vitest";

import type { RuntimeCreditPackage } from "./packages";

// packages.ts 经 system-settings 间接 import @repo/database，
// 后者模块加载时要求 DATABASE_URL；先注入占位再动态 import（不会真正连库）。
async function loadPackages() {
  process.env.DATABASE_URL ||=
    "postgres://test:test@127.0.0.1:5432/gpt2image_test";
  return await import("./packages");
}

function makePackage(
  overrides: Partial<RuntimeCreditPackage> = {}
): RuntimeCreditPackage {
  return {
    id: "credits_test",
    name: "Test pack",
    description: "",
    credits: 5000,
    price: 20,
    ...overrides,
  };
}

describe("getCreditPackagePrice", () => {
  it("returns the single configured price for every user", async () => {
    const { getCreditPackagePrice } = await loadPackages();
    const pkg = makePackage({ price: 99 });

    expect(getCreditPackagePrice(pkg)).toBe(99);
  });
});

describe("getCreditPackageCreemProductId", () => {
  it("uses an explicit product id or a stable fallback", async () => {
    const { getCreditPackageCreemProductId } = await loadPackages();
    expect(getCreditPackageCreemProductId(makePackage({ id: "p1" }))).toBe(
      "credits_p1"
    );
  });

  it("prefers an explicit creemProductId over the credits_<id> fallback", async () => {
    const { getCreditPackageCreemProductId } = await loadPackages();
    const pkg = makePackage({ id: "p2", creemProductId: "prod_default" });

    expect(getCreditPackageCreemProductId(pkg)).toBe("prod_default");
  });
});

describe("getCreditPackageCurrency", () => {
  it("uses an ISO currency configured on the package and keeps legacy packages in CNY", async () => {
    const { getCreditPackageCurrency } = await loadPackages();

    expect(getCreditPackageCurrency(makePackage({ currency: "usd" }))).toBe(
      "USD"
    );
    expect(getCreditPackageCurrency(makePackage())).toBe("CNY");
  });
});
