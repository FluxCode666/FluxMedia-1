/**
 * 图像尺寸弹窗纯规则测试。
 *
 * 使用方是 Vitest；锁定旧版比例弹窗的 1K/2K/4K 换算、自定义比例解析与状态反推。
 */

import { describe, expect, it } from "vitest";

import {
  getImageSizeForRatio,
  inferImageSizeSelectionState,
  parseImageAspectRatioInput,
} from "./image-size-selection";

describe("parseImageAspectRatioInput", () => {
  it("接受冒号或 x 分隔的正数比例", () => {
    expect(parseImageAspectRatioInput("16:9")).toEqual({
      width: 16,
      height: 9,
    });
    expect(parseImageAspectRatioInput(" 3 x 2 ")).toEqual({
      width: 3,
      height: 2,
    });
  });

  it("拒绝空值、零值和非比例文本", () => {
    expect(parseImageAspectRatioInput("")).toBeNull();
    expect(parseImageAspectRatioInput("0:9")).toBeNull();
    expect(parseImageAspectRatioInput("wide")).toBeNull();
  });
});

describe("getImageSizeForRatio", () => {
  it("恢复常用 1K、2K 和 4K 比例尺寸", () => {
    expect(getImageSizeForRatio("1k", { width: 1, height: 1 })).toBe(
      "1248x1248"
    );
    expect(getImageSizeForRatio("2k", { width: 16, height: 9 })).toBe(
      "2048x1152"
    );
    expect(getImageSizeForRatio("4k", { width: 9, height: 16 })).toBe(
      "2160x3840"
    );
  });
});

describe("inferImageSizeSelectionState", () => {
  it("识别自动、预设比例和自定义宽高", () => {
    expect(inferImageSizeSelectionState("auto").mode).toBe("auto");
    expect(inferImageSizeSelectionState("2048x1152")).toMatchObject({
      mode: "ratio",
      base: "2k",
      ratio: "16:9",
    });
    expect(inferImageSizeSelectionState("1024x1024")).toMatchObject({
      mode: "custom",
      customRatio: "1:1",
      customWidth: 1024,
      customHeight: 1024,
    });
  });
});
