import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  payload: {} as {
    user: { id: string; role: string | null } | null;
  },
}));

vi.mock("../http/go-backend", () => ({
  requestGoBackendJson: vi.fn(async () => state.payload),
}));

describe("getUserRoleById", () => {
  beforeEach(() => {
    vi.resetModules();
    state.payload = { user: { id: "user-1", role: "user" } };
  });

  it("保留 admin 角色且通过当前 Go 会话读取", async () => {
    state.payload.user!.role = "admin";
    const { getUserRoleById } = await import("./role-server");
    expect(await getUserRoleById("user-1")).toBe("admin");
  });

  it("保留 super_admin 角色", async () => {
    state.payload.user!.role = "super_admin";
    const { getUserRoleById } = await import("./role-server");
    expect(await getUserRoleById("user-1")).toBe("super_admin");
  });

  it("未知、缺失或不匹配的会话归一为 user", async () => {
    state.payload.user!.role = "bogus-role";
    const { getUserRoleById } = await import("./role-server");
    expect(await getUserRoleById("user-1")).toBe("user");

    state.payload = { user: null };
    vi.resetModules();
    const reloaded = await import("./role-server");
    expect(await reloaded.getUserRoleById("missing")).toBe("user");

    state.payload = { user: { id: "another-user", role: "admin" } };
    vi.resetModules();
    const mismatch = await import("./role-server");
    expect(await mismatch.getUserRoleById("user-1")).toBe("user");
  });
});
