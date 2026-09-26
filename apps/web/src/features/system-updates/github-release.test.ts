import { describe, expect, it } from "vitest";

import { canUpdateTo, compareReleaseVersions } from "./github-release";

describe("GitHub release version ordering", () => {
  it("compares stable semantic versions numerically", () => {
    expect(compareReleaseVersions("v1.10.0", "v1.9.9")).toBe(1);
    expect(compareReleaseVersions("v1.2.3", "v1.2.4")).toBe(-1);
    expect(compareReleaseVersions("v1.2.3", "v1.2.3")).toBe(0);
  });

  it("orders supported prereleases before stable releases", () => {
    expect(compareReleaseVersions("v1.0.0", "v1.0.0-rc.2")).toBe(1);
    expect(compareReleaseVersions("v1.0.0-beta.1", "v1.0.0-alpha.2")).toBe(1);
    expect(compareReleaseVersions("v1.0.0-rc.3", "v1.0.0-rc.2")).toBe(1);
  });

  it("only treats a strictly newer valid release as an update", () => {
    expect(canUpdateTo("v1.0.0", "v1.0.1")).toBe(true);
    expect(canUpdateTo("v1.0.1", "v1.0.1")).toBe(false);
    expect(canUpdateTo("v1.0.2", "v1.0.1")).toBe(false);
    expect(canUpdateTo("unknown", "v1.0.1")).toBe(false);
    expect(canUpdateTo("v1.0.0", "latest")).toBe(false);
  });
});
