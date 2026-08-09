/**
 * Lieflat 日序列与两类 Waffle 的 DB-free 几何函数。
 *
 * 使用方：F2、F3、L3、G4 React SVG。所有函数确定性、无随机数和 DOM 依赖，确保刷新、
 * SSR、截图与回归测试得到相同位置。
 */

export type HairlinePoint = {
  index: number;
  value: number;
  x: number;
  y: number;
};

export type HairlineGeometry = {
  points: HairlinePoint[];
  baseline: number;
  plotTop: number;
  peakIndex: number;
  maxValue: number;
};

/**
 * 把 1 至 30 个非负值映射到固定 400×260 SVG 绘图区。
 *
 * @param values 每个真实自然日的值，调用方保证顺序与 DTO 桶一致。
 * @returns 每日 x/y、基线、峰值和最大值；全零序列仍保留全部基线位置。
 */
export function buildHairlineGeometry(
  values: readonly number[]
): HairlineGeometry {
  if (values.length === 0 || values.length > 30) {
    throw new RangeError("Lieflat 日序列必须包含 1 至 30 个位置");
  }
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new RangeError("Lieflat 日序列只能包含有限非负数值");
  }
  const left = 28;
  const right = 372;
  const plotTop = 24;
  const baseline = 205;
  const actualMax = Math.max(...values);
  const scaleMax = Math.max(1, actualMax);
  const peakIndex = values.indexOf(actualMax);
  const points = values.map((value, index) => {
    const x =
      values.length === 1
        ? (left + right) / 2
        : left + (index / (values.length - 1)) * (right - left);
    return {
      index,
      value,
      x,
      y: baseline - (value / scaleMax) * (baseline - plotTop),
    };
  });
  return { points, baseline, plotTop, peakIndex, maxValue: actualMax };
}

/**
 * 选择少量日期标签锚点而不丢弃任何数据位置。
 *
 * @param count 日桶数量。
 * @returns 7 天全部显示；更长序列显示首、四分位、中点、末四分位和末日。
 */
export function selectDateLabelIndices(count: number): number[] {
  if (!Number.isSafeInteger(count) || count <= 0 || count > 30) {
    throw new RangeError("日期标签数量必须为 1 至 30");
  }
  if (count <= 7) return Array.from({ length: count }, (_, index) => index);
  const last = count - 1;
  return [
    ...new Set([
      0,
      Math.round(last / 4),
      Math.round(last / 2),
      Math.round((last * 3) / 4),
      last,
    ]),
  ];
}

/** 两类成功任务分配到 100 个百分比点后的稳定结果。 */
export type TaskWaffleAllocation = {
  allocations: [number, number];
  dots: Array<{ id: string; kind: "image" | "video" }>;
};

/**
 * 用最大余数法把图片/视频任务占比分配为恰好 100 个点。
 *
 * @param imageTaskCount 成功图片任务数。
 * @param videoTaskCount 成功视频任务数。
 * @returns 原始总数为零时不造点；并列余数时稳定优先图片。
 */
export function allocateTaskWaffleDots(
  imageTaskCount: number,
  videoTaskCount: number
): TaskWaffleAllocation {
  if (
    !Number.isSafeInteger(imageTaskCount) ||
    !Number.isSafeInteger(videoTaskCount) ||
    imageTaskCount < 0 ||
    videoTaskCount < 0
  ) {
    throw new RangeError("Waffle 任务数必须是非负安全整数");
  }
  const total = imageTaskCount + videoTaskCount;
  if (total === 0) return { allocations: [0, 0], dots: [] };
  const exact = [
    (imageTaskCount / total) * 100,
    (videoTaskCount / total) * 100,
  ] as const;
  const allocations: [number, number] = [
    Math.floor(exact[0]),
    Math.floor(exact[1]),
  ];
  const remainder = 100 - allocations[0] - allocations[1];
  if (remainder === 1) {
    const imageRemainder = exact[0] - allocations[0];
    const videoRemainder = exact[1] - allocations[1];
    if (imageRemainder >= videoRemainder) {
      allocations[0] += 1;
    } else {
      allocations[1] += 1;
    }
  } else if (remainder !== 0) {
    throw new RangeError("Waffle 百分比无法稳定分配为 100 个点");
  }
  return {
    allocations,
    dots: [
      ...Array.from({ length: allocations[0] }, (_, slot) => ({
        id: `image-${slot + 1}`,
        kind: "image" as const,
      })),
      ...Array.from({ length: allocations[1] }, (_, slot) => ({
        id: `video-${slot + 1}`,
        kind: "video" as const,
      })),
    ],
  };
}
