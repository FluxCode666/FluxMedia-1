/**
 * 管理用户列表分页契约测试。
 *
 * 验证默认值、产品页大小白名单和精确分页输出字段，防止传输层重新放宽输入。
 */
import { describe, expect, it } from "vitest";
import {
  adminUserListInputSchema,
  adminUserListOutputSchema,
} from "./admin-user-list-contract";

describe("admin user list contract", () => {
  it("使用第一页和每页 20 条作为默认值", () => {
    expect(adminUserListInputSchema.parse({})).toEqual({
      page: 1,
      pageSize: 20,
      status: "all",
      creditsStatus: "all",
    });
  });

  it.each([10, 20, 50])("接受产品页大小 %s", (pageSize) => {
    expect(adminUserListInputSchema.parse({ pageSize }).pageSize).toBe(
      pageSize
    );
  });

  it.each([1, 19, 100])("拒绝非白名单页大小 %s", (pageSize) => {
    expect(adminUserListInputSchema.safeParse({ pageSize }).success).toBe(
      false
    );
  });

  it("输出必须包含精确总条数和总页数", () => {
    expect(
      adminUserListOutputSchema.safeParse({
        users: [],
        pagination: {
          page: 1,
          pageSize: 20,
          totalCount: 0,
          totalPages: 1,
        },
        stats: { totalUsers: 0, admins: 0, banned: 0 },
      }).success
    ).toBe(true);
  });
});
