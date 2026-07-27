/**
 * 图像尺寸弹窗的纯选择规则。
 *
 * 使用方是简易生图尺寸选择器和 Vitest。该模块只负责预设比例换算、输入解析与当前
 * 尺寸反推，不依赖 React、数据库或浏览器状态。
 */

import {
  AUTO_IMAGE_SIZE,
  DEFAULT_IMAGE_SIZE,
  IMAGE_1K_BASE_EDGE,
  IMAGE_2K_BASE_EDGE,
  IMAGE_4K_BASE_EDGE,
  normalizeImageSize,
  normalizeValidImageSize,
  parseImageSize,
} from "@/features/image-generation/resolution";

export type ImageSizeMode = "auto" | "ratio" | "custom";
export type ImageSizeBase = "1k" | "2k" | "4k";
export type ImageAspectRatio =
  | "1:1"
  | "3:2"
  | "2:3"
  | "16:9"
  | "9:16"
  | "4:3"
  | "3:4"
  | "21:9";

export type ImageRatioDimensions = {
  width: number;
  height: number;
};

export type ImageSizeSelectionState = {
  mode: ImageSizeMode;
  base: ImageSizeBase;
  ratio: ImageAspectRatio;
  customRatio: string;
  customWidth: number;
  customHeight: number;
};

export const IMAGE_SIZE_BASES: readonly {
  value: ImageSizeBase;
  label: string;
  edge: number;
}[] = [
  { value: "1k", label: "1K", edge: IMAGE_1K_BASE_EDGE },
  { value: "2k", label: "2K", edge: IMAGE_2K_BASE_EDGE },
  { value: "4k", label: "4K", edge: IMAGE_4K_BASE_EDGE },
];

export const IMAGE_ASPECT_RATIOS: readonly {
  value: ImageAspectRatio;
  width: number;
  height: number;
}[] = [
  { value: "1:1", width: 1, height: 1 },
  { value: "3:2", width: 3, height: 2 },
  { value: "2:3", width: 2, height: 3 },
  { value: "16:9", width: 16, height: 9 },
  { value: "9:16", width: 9, height: 16 },
  { value: "4:3", width: 4, height: 3 },
  { value: "3:4", width: 3, height: 4 },
  { value: "21:9", width: 21, height: 9 },
];

/**
 * 将宽高比文本收窄为正数比例。
 *
 * @param value 用户输入的 `16:9` 或 `16x9` 文本。
 * @returns 合法正数宽高；格式、范围或数值非法时返回 null。
 */
export function parseImageAspectRatioInput(
  value: string
): ImageRatioDimensions | null {
  const match = value.trim().match(/^(\d{1,3})\s*[:x]\s*(\d{1,3})$/i);
  if (!match) return null;
  const width = Number(match[1] ?? Number.NaN);
  const height = Number(match[2] ?? Number.NaN);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * 按基准最长边和比例生成符合统一图像管线约束的尺寸。
 *
 * @param base 1K、2K 或 4K 基准档位。
 * @param ratio 正数宽高比。
 * @returns 已规整为 16 倍数、有效像素和最大宽高比的 `WIDTHxHEIGHT`。
 */
export function getImageSizeForRatio(
  base: ImageSizeBase,
  ratio: ImageRatioDimensions
): string {
  const baseSpec = IMAGE_SIZE_BASES.find((item) => item.value === base);
  if (!baseSpec || ratio.width <= 0 || ratio.height <= 0) {
    return DEFAULT_IMAGE_SIZE;
  }
  const longEdge = baseSpec.edge;
  const landscape = ratio.width >= ratio.height;
  const width = landscape ? longEdge : (longEdge * ratio.width) / ratio.height;
  const height = landscape ? (longEdge * ratio.height) / ratio.width : longEdge;
  return normalizeValidImageSize({ width, height });
}

/** 计算两个正整数的最大公约数，用于展示当前自定义尺寸的简化比例。 */
function greatestCommonDivisor(first: number, second: number): number {
  let left = Math.abs(Math.round(first));
  let right = Math.abs(Math.round(second));
  while (right !== 0) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  return left || 1;
}

/**
 * 从已生效尺寸反推弹窗初始模式。
 *
 * @param size 当前请求使用的 `auto` 或 `WIDTHxHEIGHT`。
 * @returns 可直接初始化弹窗本地状态的安全快照；非法尺寸回退默认方图。
 */
export function inferImageSizeSelectionState(
  size: string
): ImageSizeSelectionState {
  const fallbackDimensions = parseImageSize(DEFAULT_IMAGE_SIZE) ?? {
    width: 1024,
    height: 1024,
  };
  if (size.trim().toLowerCase() === AUTO_IMAGE_SIZE) {
    return {
      mode: "auto",
      base: "1k",
      ratio: "1:1",
      customRatio: "1:1",
      customWidth: fallbackDimensions.width,
      customHeight: fallbackDimensions.height,
    };
  }

  const dimensions = parseImageSize(size) ?? fallbackDimensions;
  const normalizedSize = normalizeImageSize(
    dimensions.width,
    dimensions.height
  );
  for (const base of IMAGE_SIZE_BASES) {
    for (const ratio of IMAGE_ASPECT_RATIOS) {
      if (getImageSizeForRatio(base.value, ratio) === normalizedSize) {
        return {
          mode: "ratio",
          base: base.value,
          ratio: ratio.value,
          customRatio: ratio.value,
          customWidth: dimensions.width,
          customHeight: dimensions.height,
        };
      }
    }
  }

  const divisor = greatestCommonDivisor(dimensions.width, dimensions.height);
  return {
    mode: "custom",
    base: "1k",
    ratio: "1:1",
    customRatio: `${Math.round(dimensions.width / divisor)}:${Math.round(
      dimensions.height / divisor
    )}`,
    customWidth: dimensions.width,
    customHeight: dimensions.height,
  };
}
