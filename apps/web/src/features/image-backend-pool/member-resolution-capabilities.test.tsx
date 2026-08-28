/**
 * 供应商账号按模型输入与分辨率能力的 DB-free 测试。
 *
 * 职责：锁定继承与账号覆盖之间的可逆转换、模型隔离和至少一个分辨率约束。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  MemberResolutionCapabilitiesEditor,
  setMemberResolutionCapabilityMode,
  setMemberResolutionSelected,
  setMemberVideoInputCapability,
} from "./member-resolution-capabilities";

const globalResolutions = ["480p", "720p", "1080p", "4k"];

describe("member resolution capability state", () => {
  it("按模型独立更新参考媒体输入能力并在全部关闭时清理键", () => {
    const withVideo = setMemberVideoInputCapability(
      {},
      "Seedance2",
      "referenceVideos",
      true
    );
    expect(withVideo).toEqual({
      seedance2: { referenceVideos: true, referenceAudios: false },
    });
    expect(
      setMemberVideoInputCapability(
        withVideo,
        "seedance2",
        "referenceVideos",
        false
      )
    ).toEqual({});
  });

  it("从继承切到自定义时复制当前全局能力", () => {
    expect(
      setMemberResolutionCapabilityMode(
        {},
        "Seedance2",
        globalResolutions,
        "custom"
      )
    ).toEqual({ seedance2: globalResolutions });
  });

  it("从自定义切回继承时只删除当前模型覆盖", () => {
    expect(
      setMemberResolutionCapabilityMode(
        {
          seedance2: ["720p", "1080p"],
          "gpt-image-2": ["1k", "2k"],
        },
        "seedance2",
        globalResolutions,
        "inherit"
      )
    ).toEqual({ "gpt-image-2": ["1k", "2k"] });
  });

  it("修改单个模型不会改变其他模型的账号能力", () => {
    const result = setMemberResolutionSelected(
      {
        seedance2: ["720p", "1080p"],
        "gpt-image-2": ["1k", "2k"],
      },
      "seedance2",
      globalResolutions,
      "720p",
      false
    );

    expect(result).toEqual({
      capabilities: {
        "gpt-image-2": ["1k", "2k"],
        seedance2: ["1080p"],
      },
      rejected: false,
    });
  });

  it("拒绝移除自定义能力中的最后一个分辨率", () => {
    const capabilities = { seedance2: ["1080p"] };

    expect(
      setMemberResolutionSelected(
        capabilities,
        "seedance2",
        globalResolutions,
        "1080p",
        false
      )
    ).toEqual({ capabilities, rejected: true });
  });
});

describe("MemberResolutionCapabilitiesEditor", () => {
  it("明确展示继承与自定义模式，并在继承时禁用分辨率选择", () => {
    const markup = renderToStaticMarkup(
      createElement(MemberResolutionCapabilitiesEditor, {
        modelIds: ["seedance2"],
        modelOptions: [
          {
            id: "seedance2",
            label: "Seedance 2.0",
            category: "video",
            source: "model_configuration",
            supportedResolutions: globalResolutions,
          },
        ],
        value: {},
        onChange: vi.fn(),
        videoInputCapabilitiesByModel: {},
        onVideoInputCapabilitiesChange: vi.fn(),
      })
    );

    expect(markup).toContain("继承全局");
    expect(markup).toContain("自定义");
    expect(markup).toContain("只读继承");
    expect(markup).toContain("4k");
    expect(markup).toContain('aria-label="seedance2 支持 4k"');
    expect(markup).toContain("支持参考视频输入");
    expect(markup).toContain("支持参考音频输入");
    expect(markup).toContain("disabled");
  });
});
