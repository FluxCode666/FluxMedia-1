/**
 * Lieflat Mono 图表 token 契约测试。
 *
 * 使用方：Vitest；固定纸灰、炭黑和七级灰阶，确保数据编码不混入应用 primary、品牌色
 * 或四张图重复模板。
 */
import { describe, expect, it } from "vitest";

import {
  DATA_DASHBOARD_CHART_TEMPLATES,
  LIEFLAT_MONO_TOKENS,
} from "./chart-tokens";

describe("data dashboard chart tokens", () => {
  it("保持 Lieflat Mono 唯一色阶", () => {
    expect(LIEFLAT_MONO_TOKENS).toEqual({
      ink: "#1C1C1A",
      paper: "#F0EFEB",
      muted: "#8F8E88",
      faint: "#C6C5BF",
      grid: "#DEDDD6",
      ladder: [
        "#1C1C1A",
        "#4A4944",
        "#6A6963",
        "#8F8E88",
        "#B0AFA9",
        "#C6C5BF",
        "#D8D7D1",
      ],
    });
    expect(JSON.stringify(LIEFLAT_MONO_TOKENS)).not.toMatch(/primary|brand/i);
  });

  it("四张图使用不重复的已审计模板", () => {
    expect(DATA_DASHBOARD_CHART_TEMPLATES).toEqual({
      images: "F2-hairline-line",
      credits: "F3-hairline-area",
      videos: "L3-barcode-lollipop",
      composition: "G4-dot-waffle",
    });
    expect(new Set(Object.values(DATA_DASHBOARD_CHART_TEMPLATES))).toHaveLength(
      4
    );
  });
});
