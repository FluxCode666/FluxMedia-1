/**
 * 管理端数据看板用户搜索服务测试。
 *
 * 使用方：Vitest；验证名称/邮箱搜索输入会被严格解析，输出只保留安全用户下拉字段，
 * 并且选中用户深链使用精确 user ID 查询。
 */
import { describe, expect, it, vi } from "vitest";

import { searchAdminDataDashboardUsers } from "./admin-data-dashboard-user-search";

describe("searchAdminDataDashboardUsers", () => {
  it("传递名称或邮箱查询并收敛用户选项", async () => {
    const repository = {
      searchUsers: vi
        .fn()
        .mockResolvedValue([
          { id: "user-1", name: "张三", email: "zhang@example.com" },
        ]),
    };

    await expect(
      searchAdminDataDashboardUsers({ query: "张", limit: 20 }, repository)
    ).resolves.toEqual({
      users: [{ id: "user-1", name: "张三", email: "zhang@example.com" }],
    });
    expect(repository.searchUsers).toHaveBeenCalledWith({
      query: "张",
      limit: 20,
    });
  });

  it("选中用户深链使用精确 ID 并拒绝未知输入", async () => {
    const repository = {
      searchUsers: vi.fn().mockResolvedValue([]),
    };

    await expect(
      searchAdminDataDashboardUsers(
        { query: "", limit: 1, selectedUserId: "user-1" },
        repository
      )
    ).resolves.toEqual({ users: [] });
    expect(repository.searchUsers).toHaveBeenCalledWith({
      query: "",
      limit: 1,
      selectedUserId: "user-1",
    });
    await expect(
      searchAdminDataDashboardUsers({ query: "x", unknown: true }, repository)
    ).rejects.toThrow();
  });
});
