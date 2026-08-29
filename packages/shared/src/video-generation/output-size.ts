/**
 * 视频输出像素尺寸的供应商无关目录。
 *
 * 使用方：UOL、视频执行契约与供应商适配器。该模块只负责规范分辨率、宽高比和
 * 精确像素值的映射；模型是否支持组合仍由能力目录权威判断。
 */
import { z } from "zod";
import {
  type VideoAspectRatio,
  type VideoResolution,
  videoAspectRatioSchema,
  videoResolutionSchema,
} from "./contracts";

/** 视频任务保存的精确像素尺寸。 */
export const videoPixelSizeSchema = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();

/** 规范像素尺寸及其分辨率、宽高比身份。 */
export type VideoOutputSize = z.infer<typeof videoPixelSizeSchema> & {
  readonly size: string;
  readonly resolution: VideoResolution;
  readonly aspectRatio: VideoAspectRatio;
};

/** 自定义视频分辨率标签的按比例输出像素映射。 */
export type CustomVideoOutputSizesByResolution = Readonly<
  Record<
    string,
    Readonly<
      Partial<Record<VideoAspectRatio, { width: number; height: number }>>
    >
  >
>;

const VIDEO_OUTPUT_SIZE_CATALOG: Readonly<
  Record<
    VideoResolution,
    Readonly<Record<VideoAspectRatio, { width: number; height: number }>>
  >
> = {
  "480p": {
    "1:1": { width: 480, height: 480 },
    "4:3": { width: 640, height: 480 },
    "3:4": { width: 480, height: 640 },
    "16:9": { width: 854, height: 480 },
    "9:16": { width: 480, height: 854 },
    "21:9": { width: 1120, height: 480 },
  },
  "720p": {
    "1:1": { width: 720, height: 720 },
    "4:3": { width: 960, height: 720 },
    "3:4": { width: 720, height: 960 },
    "16:9": { width: 1280, height: 720 },
    "9:16": { width: 720, height: 1280 },
    "21:9": { width: 1680, height: 720 },
  },
  "1080p": {
    "1:1": { width: 1080, height: 1080 },
    "4:3": { width: 1440, height: 1080 },
    "3:4": { width: 1080, height: 1440 },
    "16:9": { width: 1920, height: 1080 },
    "9:16": { width: 1080, height: 1920 },
    "21:9": { width: 2520, height: 1080 },
  },
  "2k": {
    "1:1": { width: 1440, height: 1440 },
    "4:3": { width: 1920, height: 1440 },
    "3:4": { width: 1440, height: 1920 },
    "16:9": { width: 2560, height: 1440 },
    "9:16": { width: 1440, height: 2560 },
    "21:9": { width: 3360, height: 1440 },
  },
  "4k": {
    "1:1": { width: 2160, height: 2160 },
    "4:3": { width: 2880, height: 2160 },
    "3:4": { width: 2160, height: 2880 },
    "16:9": { width: 3840, height: 2160 },
    "9:16": { width: 2160, height: 3840 },
    "21:9": { width: 5040, height: 2160 },
  },
  "8k": {
    "1:1": { width: 4320, height: 4320 },
    "4:3": { width: 5760, height: 4320 },
    "3:4": { width: 4320, height: 5760 },
    "16:9": { width: 7680, height: 4320 },
    "9:16": { width: 4320, height: 7680 },
    "21:9": { width: 10080, height: 4320 },
  },
};

/**
 * 按规范分辨率和宽高比读取精确像素尺寸。
 *
 * @param resolution - 公开分辨率标签。
 * @param aspectRatio - 公开宽高比。
 * @returns 目录中的尺寸对象；未知组合返回 null。
 */
export function getVideoOutputSize(
  resolution: unknown,
  aspectRatio: unknown
): VideoOutputSize | null {
  const parsedResolution = videoResolutionSchema.safeParse(resolution);
  const parsedAspectRatio = videoAspectRatioSchema.safeParse(aspectRatio);
  if (!parsedResolution.success || !parsedAspectRatio.success) return null;
  const pixels =
    VIDEO_OUTPUT_SIZE_CATALOG[parsedResolution.data][parsedAspectRatio.data];
  return {
    size: `${pixels.width}x${pixels.height}`,
    width: pixels.width,
    height: pixels.height,
    resolution: parsedResolution.data,
    aspectRatio: parsedAspectRatio.data,
  };
}

/**
 * 解析内置或自定义视频的精确输出像素。
 *
 * 自定义模型优先使用平台标准目录；只有标准目录无法识别时才读取管理员声明的
 * `outputSizesByResolution[resolution][aspectRatio]`。缺失或损坏映射返回 null，调用方
 * 必须拒绝创建任务，不能把供应商专属标签猜测成错误尺寸。
 */
export function getCustomVideoOutputSize(
  resolution: unknown,
  aspectRatio: unknown,
  customSizes?: unknown
): { width: number; height: number; size: string } | null {
  const standard = getVideoOutputSize(resolution, aspectRatio);
  if (standard) return standard;
  if (typeof resolution !== "string" || typeof aspectRatio !== "string") {
    return null;
  }
  if (
    !customSizes ||
    typeof customSizes !== "object" ||
    Array.isArray(customSizes)
  ) {
    return null;
  }
  const byResolution = (customSizes as Record<string, unknown>)[resolution];
  if (
    !byResolution ||
    typeof byResolution !== "object" ||
    Array.isArray(byResolution)
  ) {
    return null;
  }
  const pixels = (byResolution as Record<string, unknown>)[aspectRatio];
  if (!pixels || typeof pixels !== "object" || Array.isArray(pixels)) {
    return null;
  }
  const width = (pixels as Record<string, unknown>).width;
  const height = (pixels as Record<string, unknown>).height;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    (width as number) <= 0 ||
    (height as number) <= 0
  ) {
    return null;
  }
  return {
    width: width as number,
    height: height as number,
    size: `${width}x${height}`,
  };
}
