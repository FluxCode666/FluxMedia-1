/**
 * 首页模型目录消费边界测试。
 *
 * 使用方是 Vitest；锁定首页按优先级混排且最多六项，快速集成继续收到完整图像目录。
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
      homepage: [
        { id: "image-five", category: "image" as const, priority: 5 },
        { id: "video-two", category: "video" as const, priority: 2 },
        { id: "image-two", category: "image" as const, priority: 2 },
        { id: "video-one", category: "video" as const, priority: 1 },
        { id: "image-six", category: "image" as const, priority: 6 },
        { id: "video-seven", category: "video" as const, priority: 7 },
        { id: "overflow", category: "video" as const, priority: 8 },
      ],
    };

    const consumers = getHomepageModelCatalogConsumers(catalog);

    expect(consumers.preview).toEqual({
      status: "ready",
      models: [
        { id: "video-one", category: "video", priority: 1 },
        { id: "video-two", category: "video", priority: 2 },
        { id: "image-two", category: "image", priority: 2 },
        { id: "image-five", category: "image", priority: 5 },
        { id: "image-six", category: "image", priority: 6 },
        { id: "video-seven", category: "video", priority: 7 },
      ],
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
