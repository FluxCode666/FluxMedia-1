/**
 * 统一响应式分页控件的服务端结构测试。
 *
 * 使用方：所有随机访问列表；锁定桌面数字页码、移动页码选择器、当前页语义
 * 和上一页/下一页的原生禁用状态。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getPaginationWindow } from "@repo/shared/pagination/state";
import {
  formatPaginationPageLabel,
  getPaginationControlsViewModel,
} from "@repo/ui/components/pagination-controls";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(process.cwd(), "../..");
const serverPaginationConsumers = [
  "src/app/[locale]/(dashboard)/dashboard/admin/status/page.tsx",
  "src/app/[locale]/(dashboard)/dashboard/announcements/page.tsx",
  "src/app/[locale]/(dashboard)/dashboard/support/[id]/page.tsx",
  "src/app/[locale]/(dashboard)/dashboard/support/page.tsx",
  "src/app/[locale]/(marketing)/blog/page.tsx",
  "src/app/[locale]/(marketing)/pseo/page.tsx",
];

describe("PaginationControls", () => {
  it("从可序列化模板生成本地化页码标签", () => {
    expect(formatPaginationPageLabel("前往第 {page} 页", 12)).toBe(
      "前往第 12 页"
    );
    expect(
      formatPaginationPageLabel("Page {page}, current page {page}", 3)
    ).toBe("Page 3, current page 3");
  });

  it("服务端页面仅向客户端分页控件传递可序列化文案", () => {
    for (const file of serverPaginationConsumers) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(source).not.toContain("getPageLabel=");
      expect(source).toContain("pageLabelTemplate=");
      expect(source).toContain("currentPageLabelTemplate=");
    }

    const urlPaginationSource = readFileSync(
      resolve(
        repositoryRoot,
        "apps/web/src/features/pagination/pagination-controls.tsx"
      ),
      "utf8"
    );
    expect(urlPaginationSource).not.toContain("getPageLabel:");
  });

  it("组合桌面窗口与移动端完整页码选项", () => {
    expect(getPaginationWindow(5, 10)).toEqual([
      1,
      "start-ellipsis",
      4,
      5,
      6,
      "end-ellipsis",
      10,
    ]);
    expect(getPaginationControlsViewModel(5, 10)).toEqual({
      page: 5,
      totalPages: 10,
      showNavigation: true,
      canGoPrevious: true,
      canGoNext: true,
      mobilePages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    });
  });

  it("在首页禁用上一页，在末页禁用下一页", () => {
    expect(getPaginationControlsViewModel(1, 2)).toMatchObject({
      canGoPrevious: false,
      canGoNext: true,
    });
    expect(getPaginationControlsViewModel(2, 2)).toMatchObject({
      canGoPrevious: true,
      canGoNext: false,
    });
  });

  it("单页隐藏全部导航", () => {
    expect(getPaginationControlsViewModel(99, 1)).toEqual({
      page: 1,
      totalPages: 1,
      showNavigation: false,
      canGoPrevious: false,
      canGoNext: false,
      mobilePages: [1],
    });
  });
});
