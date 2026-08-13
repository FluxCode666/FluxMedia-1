/**
 * 多列表分页 URL adapter 的纯函数测试。
 *
 * 使用方：管理设置、状态和其他同页多列表；确保更新一个 namespace 不会破坏
 * 其他列表，并锁定筛选/页大小变化清 cursor 回首页的行为。
 */
import { parsePaginationConfig } from "@repo/shared/pagination/config";
import { describe, expect, it } from "vitest";
import {
  buildPaginationHref,
  createPaginationUrlParamNames,
  parsePaginationUrlState,
} from "./url-adapter";

const paginationConfig = parsePaginationConfig([10, 20, 50]);

describe("pagination URL adapter", () => {
  it("解析 namespaced 页码、页大小与 cursor", () => {
    const params = new URLSearchParams(
      "modelPage=3&modelPageSize=50&modelCursor=signed-boundary"
    );

    expect(
      parsePaginationUrlState(
        params,
        createPaginationUrlParamNames("model"),
        paginationConfig
      )
    ).toEqual({
      page: 3,
      pageSize: 50,
      cursor: "signed-boundary",
    });
  });

  it("重复、负数、超大值和下线页大小安全回退", () => {
    const params = new URLSearchParams(
      "errorPage=-1&errorPage=2&errorPageSize=40&errorCursor=a&errorCursor=b"
    );

    expect(
      parsePaginationUrlState(
        params,
        createPaginationUrlParamNames("error"),
        paginationConfig
      )
    ).toEqual({ page: 1, pageSize: 20, cursor: null });

    expect(
      parsePaginationUrlState(
        new URLSearchParams("page=9007199254740992&pageSize=10"),
        createPaginationUrlParamNames(),
        paginationConfig
      )
    ).toEqual({ page: 1, pageSize: 10, cursor: null });
  });

  it("翻页保留其他 namespace、筛选和当前页大小", () => {
    const href = buildPaginationHref(
      "/dashboard/admin/settings",
      new URLSearchParams(
        "groupPage=4&memberPage=2&modelCursor=old&modelStatus=enabled&modelPageSize=50"
      ),
      createPaginationUrlParamNames("model"),
      { cursor: "next+/=", page: 3 },
      "page"
    );

    expect(href).toBe(
      "/dashboard/admin/settings?groupPage=4&memberPage=2&modelCursor=next%2B%2F%3D&modelPage=3&modelPageSize=50&modelStatus=enabled"
    );
  });

  it("筛选或页大小变化清当前 namespace 的页码和 cursor", () => {
    const href = buildPaginationHref(
      "/dashboard/admin/settings",
      new URLSearchParams(
        "memberPage=5&modelCursor=old&modelPage=4&modelPageSize=20&modelStatus=enabled"
      ),
      createPaginationUrlParamNames("model"),
      { criteria: { modelStatus: "disabled" }, pageSize: 50 },
      "criteria"
    );

    expect(href).toBe(
      "/dashboard/admin/settings?memberPage=5&modelPageSize=50&modelStatus=disabled"
    );
  });

  it("拒绝外部或非法路径和非法写入页码", () => {
    const names = createPaginationUrlParamNames();
    expect(() =>
      buildPaginationHref(
        "https://example.com",
        new URLSearchParams(),
        names,
        {
          page: 2,
        },
        "page"
      )
    ).toThrow("绝对站内路径");
    expect(() =>
      buildPaginationHref(
        "/orders",
        new URLSearchParams(),
        names,
        {
          page: 0,
        },
        "page"
      )
    ).toThrow(RangeError);
  });
});
