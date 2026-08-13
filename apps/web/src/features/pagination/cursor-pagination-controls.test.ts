/**
 * 游标分页 URL 导航契约测试。
 *
 * 使用方：历史与支付订单列表；锁定 page 和 cursor 必须原子写入并保留筛选、
 * 页大小以及同页其他 namespace。
 */
import { describe, expect, it } from "vitest";
import {
  buildPaginationHref,
  createPaginationUrlParamNames,
} from "./url-adapter";

describe("cursor pagination controls", () => {
  it("前后翻页同时更新可见页序号和不透明 cursor", () => {
    const href = buildPaginationHref(
      "/dashboard/history",
      new URLSearchParams("page=2&pageSize=50&status=failed&memberPage=4"),
      createPaginationUrlParamNames(),
      { cursor: "next+/=", page: 3 },
      "page"
    );

    expect(href).toBe(
      "/dashboard/history?cursor=next%2B%2F%3D&memberPage=4&page=3&pageSize=50&status=failed"
    );
  });
});
