/**
 * 首页模型目录消费边界测试。
 *
 * 使用方是 Vitest；锁定首页视觉预览最多六项，而快速集成继续收到完整公开图像目录。
 */
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/i18n/routing", () => ({
  Link: ({ children, href }: { children: ReactNode; href: string }) =>
    createElement("a", { href }, children),
}));

import { getHomepageModelCatalogConsumers } from "./homepage-model-catalog";

describe("getHomepageModelCatalogConsumers", () => {
  it("预览截断不改变快速集成收到的完整模型顺序", () => {
    const catalog = {
      status: "ready" as const,
      image: Array.from({ length: 8 }, (_, index) => ({
        id: `image-model-${index + 1}`,
      })),
    };

    const consumers = getHomepageModelCatalogConsumers(catalog);

    expect(consumers.preview).toEqual({
      status: "ready",
      image: catalog.image.slice(0, 6),
    });
    expect(consumers.integration).toBe(catalog);
    expect(consumers.integration.status === "ready").toBe(true);
    if (consumers.integration.status === "ready") {
      expect(consumers.integration.image).toHaveLength(8);
      expect(consumers.integration.image[7]?.id).toBe("image-model-8");
    }
  });

  it("依赖失败状态同时传给预览和快速集成", () => {
    const catalog = { status: "unavailable" as const };

    expect(getHomepageModelCatalogConsumers(catalog)).toEqual({
      preview: catalog,
      integration: catalog,
    });
  });
});
