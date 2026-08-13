/**
 * 客服工单 URL 分页适配测试。
 *
 * 职责：锁定严格 page/pageSize/status/search 解析，以及两个 namespace 在修改
 * 页大小时只重置自身页码并保留同页其余列表状态。
 */
import { describe, expect, it } from "vitest";

import {
  buildTicketPageHref,
  buildTicketPageSizeHref,
  parseTicketListQuery,
  parseTicketMessageQuery,
  type TicketSearchParams,
} from "./ticket-query";

const paginationConfig = {
  defaultPageSize: 20 as const,
  pageSizeOptions: [10, 20, 50],
};

describe("ticket query parsing", () => {
  it("parses the settled list state and rejects duplicate or unknown values", () => {
    expect(
      parseTicketListQuery(
        {
          page: "3",
          pageSize: "50",
          status: "resolved",
          search: "  billing  ",
        },
        paginationConfig
      )
    ).toEqual({
      page: 3,
      pageSize: 50,
      status: "resolved",
      search: "billing",
    });
    expect(
      parseTicketListQuery(
        { page: ["2", "3"], pageSize: "25", status: "pending" },
        paginationConfig
      )
    ).toEqual({ page: 1, pageSize: 20, status: "all", search: "" });
  });

  it("uses an independent message namespace", () => {
    expect(
      parseTicketMessageQuery(
        { page: "7", pageSize: "50", messagePage: "4", messagePageSize: "10" },
        paginationConfig
      )
    ).toEqual({ page: 4, pageSize: 10 });
  });
});

describe("ticket query hrefs", () => {
  const searchParams = {
    page: "3",
    pageSize: "50",
    status: "open",
    messagePage: "4",
    messagePageSize: "10",
  } satisfies TicketSearchParams;

  it("resets only the list namespace when list page size changes", () => {
    expect(
      buildTicketPageSizeHref(
        "/zh/dashboard/support",
        searchParams,
        20,
        "ticket"
      )
    ).toBe(
      "/zh/dashboard/support?messagePage=4&messagePageSize=10&pageSize=20&status=open"
    );
  });

  it("resets only the message namespace when message page size changes", () => {
    expect(
      buildTicketPageSizeHref(
        "/zh/dashboard/support/ticket-1",
        searchParams,
        50,
        "message"
      )
    ).toBe(
      "/zh/dashboard/support/ticket-1?messagePageSize=50&page=3&pageSize=50&status=open"
    );
  });

  it("canonicalizes only the clamped namespace page", () => {
    expect(
      buildTicketPageHref(
        "/zh/dashboard/support/ticket-1",
        searchParams,
        2,
        "message"
      )
    ).toBe(
      "/zh/dashboard/support/ticket-1?messagePage=2&messagePageSize=10&page=3&pageSize=50&status=open"
    );
  });
});
