/**
 * Lieflat 图表纯几何与 Waffle 分配测试。
 *
 * 使用方：Vitest；验证 7/30 天都保留逐日位置、零值落在诚实基线，且两类任务用最大
 * 余数法稳定分配恰好 100 个百分比点。
 */
import { describe, expect, it } from "vitest";

import {
  allocateTaskWaffleDots,
  buildHairlineGeometry,
  selectDateLabelIndices,
} from "./chart-geometry";

describe("buildHairlineGeometry", () => {
  it.each([7, 30])("为 %d 天保留相同数量的真实位置", (days) => {
    const values = Array.from({ length: days }, (_, index) =>
      index === days - 1 ? 10 : 0
    );
    const geometry = buildHairlineGeometry(values);

    expect(geometry.points).toHaveLength(days);
    expect(
      geometry.points
        .filter((point) => point.value === 0)
        .every((point) => point.y === geometry.baseline)
    ).toBe(true);
    expect(geometry.peakIndex).toBe(days - 1);
  });

  it("标签稀疏不改变数据位置数量", () => {
    expect(selectDateLabelIndices(7)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(selectDateLabelIndices(30)).toEqual([0, 7, 15, 22, 29]);
  });
});

describe("allocateTaskWaffleDots", () => {
  it.each([
    [1, 1, [50, 50]],
    [1, 2, [33, 67]],
    [1, 99, [1, 99]],
  ] as const)("将 %d:%d 稳定分配为 %j", (images, videos, expected) => {
    const result = allocateTaskWaffleDots(images, videos);

    expect(result.allocations).toEqual(expected);
    expect(result.dots).toHaveLength(100);
    expect(result.dots.filter((dot) => dot.kind === "image")).toHaveLength(
      expected[0]
    );
  });

  it("无成功任务时不生成伪比例点", () => {
    expect(allocateTaskWaffleDots(0, 0)).toEqual({
      allocations: [0, 0],
      dots: [],
    });
  });
});
