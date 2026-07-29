/**
 * shadcn/ui Pagination 组合契约测试。
 *
 * 覆盖应用层依赖的当前页语义、具体导航标签与 asChild 按钮组合，确保框架
 * Link 和客户端按钮接入时不会产生嵌套交互元素或丢失原生禁用行为。
 */
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
} from "@repo/ui/components/pagination";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

describe("shadcn/ui Pagination 组合契约", () => {
  it("保留具体导航标签与当前页语义", () => {
    const html = renderToStaticMarkup(
      createElement(
        Pagination,
        { "aria-label": "交易记录分页" },
        createElement(
          PaginationContent,
          null,
          createElement(
            PaginationItem,
            null,
            createElement(
              PaginationLink,
              { href: "/transactions?page=2", isActive: true },
              "2"
            )
          )
        )
      )
    );

    expect(html).toContain('aria-label="交易记录分页"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('href="/transactions?page=2"');
  });

  it("通过 asChild 生成单一且原生禁用的按钮", () => {
    const html = renderToStaticMarkup(
      createElement(
        PaginationLink,
        {
          "aria-label": "上一页",
          asChild: true,
          size: "icon-sm",
        },
        createElement("button", { disabled: true, type: "button" }, "上一页")
      )
    );

    expect(html.startsWith("<button")).toBe(true);
    expect(html).toContain('aria-label="上一页"');
    expect(html).toContain(" disabled");
    expect(html).not.toContain("<a");
  });
});
