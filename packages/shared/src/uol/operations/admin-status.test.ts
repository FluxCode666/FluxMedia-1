/**
 * 管理状态历史错误 UOL 契约测试。
 *
 * 验证 operation 保持仅人工管理员暴露、只读语义及 10/20/50 页大小边界。
 */
import { describe, expect, it } from "vitest";
import { listAdminStatusErrors } from "./admin-status";

describe("admin status error operation", () => {
  it("限制为人工后端池查看角色的只读操作", () => {
    expect(listAdminStatusErrors.access).toEqual({
      kind: "imageBackendPoolViewer",
    });
    expect(listAdminStatusErrors.agentExposure).toBe("human-only");
    expect(listAdminStatusErrors.readOnly).toBe(true);
    expect(listAdminStatusErrors.destructive).toBe(false);
  });

  it.each([10, 20, 50])("接受产品页大小 %s", (pageSize) => {
    expect(listAdminStatusErrors.input.safeParse({ pageSize }).success).toBe(
      true
    );
  });

  it("拒绝旧固定页大小以外的任意值", () => {
    expect(
      listAdminStatusErrors.input.safeParse({ pageSize: 100 }).success
    ).toBe(false);
  });
});
