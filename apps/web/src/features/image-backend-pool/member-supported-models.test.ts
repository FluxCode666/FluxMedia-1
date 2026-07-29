/**
 * 号池成员模型摘要的 DB-free 测试。
 *
 * 职责：锁定单行摘要的完整文本、真实溢出判定，以及空集合不产生无意义提示。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  buildMemberSupportedModelsPresentation,
  isMemberSupportedModelsOverflowing,
  MemberSupportedModels,
} from "./member-supported-models";

describe("MemberSupportedModels", () => {
  it("使用单行省略样式渲染完整模型文本", () => {
    const markup = renderToStaticMarkup(
      createElement(MemberSupportedModels, {
        modelIds: ["seedance2", "kling-v3-omni"],
      })
    );

    expect(markup).toContain("truncate");
    expect(markup).toContain("seedance2、kling-v3-omni");
  });

  it("空模型状态不渲染 Tooltip 触发器", () => {
    const markup = renderToStaticMarkup(
      createElement(MemberSupportedModels, { modelIds: [] })
    );

    expect(markup).toContain("未配置模型");
    expect(markup).not.toContain("data-state");
  });
});

describe("buildMemberSupportedModelsPresentation", () => {
  it("文本溢出时保留完整模型集合作为 Tooltip 内容并允许聚焦", () => {
    const presentation = buildMemberSupportedModelsPresentation(
      ["seedance2", "kling-v3-omni", "runway-gen4.5"],
      true
    );

    expect(presentation).toEqual({
      isEmpty: false,
      isFocusable: true,
      text: "seedance2、kling-v3-omni、runway-gen4.5",
      tooltipText: "seedance2、kling-v3-omni、runway-gen4.5",
    });
  });

  it("文本未溢出时只显示摘要，不创建 Tooltip 焦点", () => {
    expect(
      buildMemberSupportedModelsPresentation(["seedance2"], false)
    ).toEqual({
      isEmpty: false,
      isFocusable: false,
      text: "seedance2",
      tooltipText: null,
    });
  });

  it("空模型集合显示明确状态且永不创建 Tooltip", () => {
    expect(buildMemberSupportedModelsPresentation([], true)).toEqual({
      isEmpty: true,
      isFocusable: false,
      text: "未配置模型",
      tooltipText: null,
    });
  });
});

describe("isMemberSupportedModelsOverflowing", () => {
  it("仅在完整内容宽度大于有效可见宽度时返回 true", () => {
    expect(
      isMemberSupportedModelsOverflowing({
        clientWidth: 240,
        scrollWidth: 480,
      })
    ).toBe(true);
    expect(
      isMemberSupportedModelsOverflowing({
        clientWidth: 240,
        scrollWidth: 240,
      })
    ).toBe(false);
    expect(
      isMemberSupportedModelsOverflowing({
        clientWidth: 0,
        scrollWidth: 480,
      })
    ).toBe(false);
  });
});
