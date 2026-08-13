/**
 * 跨包分页 URL adapter 的 DB-free 契约测试。
 *
 * 使用方：apps/web 与 packages/shared 客户端列表；确保共享导出不依赖 Next.js，
 * 且 namespace、严格解析和 criteria 重置行为保持一致。
 */
import { describe, expect, it } from "vitest";
import { parsePaginationConfig } from "./config";
import {
  buildPaginationHref,
  createPaginationUrlParamNames,
  parsePaginationUrlState,
} from "./url-adapter";

const config = parsePaginationConfig([10, 20, 50]);

describe("shared pagination URL adapter", () => {
  it("解析 namespaced 单值参数并拒绝重复 cursor", () => {
    const names = createPaginationUrlParamNames("user");
    expect(
      parsePaginationUrlState(
        new URLSearchParams(
          "userPage=3&userPageSize=50&userCursor=a&userCursor=b"
        ),
        names,
        config
      )
    ).toEqual({ page: 3, pageSize: 50, cursor: null });
  });

  it("criteria 变化保留其他 namespace 并清当前边界", () => {
    expect(
      buildPaginationHref(
        "/dashboard/admin/users",
        new URLSearchParams("userPage=4&userCursor=old&errorPage=2"),
        createPaginationUrlParamNames("user"),
        { criteria: { userStatus: "active" }, pageSize: 50 },
        "criteria"
      )
    ).toBe(
      "/dashboard/admin/users?errorPage=2&userPageSize=50&userStatus=active"
    );
  });
});
