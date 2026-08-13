/**
 * 统一响应式分页控件的服务端结构测试。
 *
 * 使用方：所有随机访问列表；锁定桌面数字页码、移动页码选择器、当前页语义
 * 和上一页/下一页的原生禁用状态。
 */
import { getPaginationWindow } from "@repo/shared/pagination/state";
import { PaginationControls } from "@repo/ui/components/pagination-controls";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

describe("PaginationControls", () => {
  it("组合桌面页码、移动选择器和前后导航", () => {
    const html = renderToStaticMarkup(
      createElement(PaginationControls, {
        ariaLabel: "订单分页",
        getPageLabel: (page, isCurrent) =>
          isCurrent ? `当前第 ${page} 页` : `前往第 ${page} 页`,
        items: getPaginationWindow(5, 10),
        nextLabel: "下一页",
        onPageChange: vi.fn(),
        page: 5,
        pageSelectLabel: "选择页码",
        previousLabel: "上一页",
        totalPages: 10,
      })
    );

    expect(html).toContain('aria-label="订单分页"');
    expect(html).toContain('aria-label="选择页码"');
    expect(html).toContain('aria-label="上一页"');
    expect(html).toContain('aria-label="下一页"');
    expect(html).toContain('aria-current="page"');
    expect(html.match(/More pages/g)?.length).toBe(2);
  });

  it("首页禁用上一页且不会产生嵌套交互元素", () => {
    const html = renderToStaticMarkup(
      createElement(PaginationControls, {
        ariaLabel: "用户分页",
        getPageLabel: (page) => `第 ${page} 页`,
        items: getPaginationWindow(1, 2),
        nextLabel: "下一页",
        onPageChange: vi.fn(),
        page: 1,
        pageSelectLabel: "选择页码",
        previousLabel: "上一页",
        totalPages: 2,
      })
    );

    expect(html).toMatch(/<button[^>]*aria-label="上一页"[^>]*disabled/);
    expect(html).not.toContain("<a");
    expect(html).not.toContain("<button><button");
  });

  it("单页隐藏全部导航", () => {
    const html = renderToStaticMarkup(
      createElement(PaginationControls, {
        ariaLabel: "空结果分页",
        getPageLabel: (page) => `第 ${page} 页`,
        items: [1],
        nextLabel: "下一页",
        onPageChange: vi.fn(),
        page: 1,
        pageSelectLabel: "选择页码",
        previousLabel: "上一页",
        totalPages: 1,
      })
    );

    expect(html).toBe("");
  });
});
