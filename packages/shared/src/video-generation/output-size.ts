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
  "4k": {
    "1:1": { width: 2160, height: 2160 },
    "4:3": { width: 2880, height: 2160 },
    "3:4": { width: 2160, height: 2880 },
    "16:9": { width: 3840, height: 2160 },
    "9:16": { width: 2160, height: 3840 },
    "21:9": { width: 5040, height: 2160 },
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
