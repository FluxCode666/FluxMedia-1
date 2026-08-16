/**
 * 视频生成公开能力 DTO 契约。
 *
 * 职责：为 UOL、服务端能力发现和客户端创作面板提供同一组严格输出 schema。
 * 本模块仅依赖跨运行时纯契约，禁止引入数据库、网络或 Node 专属模块。
 */
import { z } from "zod";

import {
  MAX_MEDIA_INPUT_BYTES,
  MAX_MEDIA_INPUT_COUNT,
} from "../image-generation/media-limits";
import {
  videoAspectRatioSchema,
  videoFrameInputCapabilitySchema,
  videoPublicModelIdSchema,
  videoPublicResolutionSchema,
} from "./contracts";
import { videoCurrentQuoteSchema } from "./public-billing";

/** 单个真实视频模型的公开有效能力与配置可达性。 */
export const videoCapabilityItemSchema = z
  .object({
    model: videoPublicModelIdSchema,
    displayName: z.string().trim().min(1).max(160),
    durations: z.array(z.number().int().positive()).min(1),
    aspectRatios: z.array(videoAspectRatioSchema).min(1),
    resolutions: z.array(videoPublicResolutionSchema).min(1),
    input: z
      .object({
        frames: videoFrameInputCapabilitySchema,
        referenceImages: z
          .object({
            maxCount: z.number().int().nonnegative(),
            configurable: z.boolean(),
          })
          .strict(),
        framesAndReferencesMutuallyExclusive: z.boolean(),
      })
      .strict(),
    audio: z
      .object({
        supported: z.boolean(),
        defaultEnabled: z.boolean(),
      })
      .strict(),
    configuredReachable: z.boolean(),
    billing: z.array(videoCurrentQuoteSchema).min(1),
  })
  .strict();

/** video.listCapabilities 的稳定输出，不包含成员、凭据、健康或容量。 */
export const videoListCapabilitiesOutputSchema = z
  .object({
    items: z.array(videoCapabilityItemSchema),
    limits: z
      .object({
        maxMediaInputCount: z.literal(MAX_MEDIA_INPUT_COUNT),
        maxMediaInputBytes: z.literal(MAX_MEDIA_INPUT_BYTES),
      })
      .strict(),
  })
  .strict();
