/**
 * 简易生图页状态容器测试。
 *
 * 职责：锁定首屏默认输出参数，并通过轻量展示组件隔离网络、上传和交互细节。
 */
import { createDefaultGlobalImageCreditOverrides } from "@repo/shared/image-backend/group-image-pricing";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ImageCreatePanel } from "./image-create-panel";

vi.mock("./simple-image-create-panel", () => ({
  /** 只暴露父容器传入的尺寸，避免测试依赖完整页面布局。 */
  SimpleImageCreatePanel: ({ size }: { size: string }) =>
    createElement("output", { "data-testid": "initial-size" }, size),
}));

describe("ImageCreatePanel", () => {
  it("首屏默认使用 auto 尺寸", () => {
    const markup = renderToStaticMarkup(
      createElement(ImageCreatePanel, {
        balance: 100,
        catalog: {
          groups: [
            {
              id: "group-1",
              name: "默认组",
              isDefault: true,
              models: [
                {
                  id: "gpt-image-2",
                  capabilities: { generate: true, edit: true, mask: true },
                },
              ],
            },
          ],
        },
        imageModelPricing: createDefaultGlobalImageCreditOverrides(),
        imageModerationPricing: {
          imageModerationCredits: 0,
          textModerationCredits: 0,
        },
        maxFileSizeBytes: 10 * 1024 * 1024,
        maxUploadBytes: 20 * 1024 * 1024,
        moderationEnabled: false,
        onCreditsConsumed: () => undefined,
        recent: [],
        selectedBackendGroupId: null,
      })
    );

    expect(markup).toContain(
      '<output data-testid="initial-size">auto</output>'
    );
  });
});
