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
  it("渲染带数量、省略文本和展开提示的可点击摘要", () => {
    const markup = renderToStaticMarkup(
      createElement(MemberSupportedModels, {
        modelIds: ["seedance2", "kling-v3-omni"],
      })
    );

    expect(markup).toContain("truncate");
    expect(markup).toContain("seedance2、kling-v3-omni");
    expect(markup).toContain("支持模型");
    expect(markup).toContain("展开全部");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="展开全部支持模型，共 2 个"');
    expect(markup).toContain(">2<");
  });

  it("空模型状态不渲染展开按钮", () => {
    const markup = renderToStaticMarkup(
      createElement(MemberSupportedModels, { modelIds: [] })
    );

    expect(markup).toContain("未配置模型");
    expect(markup).not.toContain("<button");
  });
});

describe("buildMemberSupportedModelsPresentation", () => {
  it("文本溢出时保留完整模型集合作为 Tooltip 内容并允许聚焦", () => {
    const presentation = buildMemberSupportedModelsPresentation(
      ["seedance2", "kling-v3-omni", "runway-gen4.5"],
      true,
      false
    );

    expect(presentation).toEqual({
      isEmpty: false,
      isExpanded: false,
      modelCount: 3,
      text: "seedance2、kling-v3-omni、runway-gen4.5",
      toggleLabel: "展开全部",
      tooltipText: "seedance2、kling-v3-omni、runway-gen4.5",
    });
  });

  it("展开时切换为收起文案并关闭 Tooltip", () => {
    expect(
      buildMemberSupportedModelsPresentation(["seedance2"], true, true)
    ).toEqual({
      isEmpty: false,
      isExpanded: true,
      modelCount: 1,
      text: "seedance2",
      toggleLabel: "收起",
      tooltipText: null,
    });
  });

  it("文本未溢出时仍可点击展开，但不创建 Tooltip", () => {
    expect(
      buildMemberSupportedModelsPresentation(["seedance2"], false, false)
    ).toEqual({
      isEmpty: false,
      isExpanded: false,
      modelCount: 1,
      text: "seedance2",
      toggleLabel: "展开全部",
      tooltipText: null,
    });
  });

  it("空模型集合显示明确状态且永不创建 Tooltip", () => {
    expect(buildMemberSupportedModelsPresentation([], true, true)).toEqual({
      isEmpty: true,
      isExpanded: false,
      modelCount: 0,
      text: "未配置模型",
      toggleLabel: "",
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
