/**
 * Adobe 视频供应商真实模型映射与像素尺寸。
 *
 * 使用方：Adobe payload、client 与 Web 直连适配器。公共参数、输入和声音能力来自中立
 * video-generation 目录；本文件只保存真实模型到 Adobe 协议身份及上传策略的映射。
 */
import {
  type VideoAspectRatio,
  type VideoModelId,
  type VideoResolution,
  videoModelIdSchema,
} from "../../video-generation";

/** Adobe 供应商适配层支持的输出分辨率，与公开小写字面量一致。 */
export type FireflyVideoResolution = VideoResolution;

/** Adobe 上传输入图时的供应商预处理方式。 */
export type FireflyVideoSourceImageMode = "original" | "target-cover";

/** Adobe 网页应用与 IMS 鉴权 Profile。 */
export type FireflyVideoWebApp = "express" | "firefly";

/** 单个真实模型在 Adobe 供应商协议中的参数无关映射。 */
export type FireflyVideoProviderModel = {
  readonly modelId: VideoModelId;
  readonly upstreamModel: string;
  readonly upstreamModelId: string;
  readonly upstreamModelVersion: string;
  readonly engine: string;
  readonly webApp: FireflyVideoWebApp;
  readonly authProfile: FireflyVideoWebApp;
  readonly sourceImageMode: FireflyVideoSourceImageMode;
};

/**
 * Adobe 真实模型映射。
 *
 * 该映射只持有供应商协议身份与上传策略，不声明公开时长、比例、分辨率、输入数量或声音
 * 能力；这些合法性事实只能来自中立视频能力描述符。
 */
export const FIREFLY_VIDEO_PROVIDER_MODELS = {
  sora2: {
    modelId: "sora2",
    upstreamModel: "openai:firefly:colligo:sora2",
    upstreamModelId: "sora",
    upstreamModelVersion: "sora-2",
    engine: "sora2",
    webApp: "express",
    authProfile: "express",
    sourceImageMode: "target-cover",
  },
  "sora2-pro": {
    modelId: "sora2-pro",
    upstreamModel: "openai:firefly:colligo:sora2-pro",
    upstreamModelId: "sora",
    upstreamModelVersion: "sora-2",
    engine: "sora2",
    webApp: "express",
    authProfile: "express",
    sourceImageMode: "target-cover",
  },
  veo31: {
    modelId: "veo31",
    upstreamModel: "google:firefly:colligo:veo31",
    upstreamModelId: "veo",
    upstreamModelVersion: "3.1-generate",
    engine: "veo31-standard",
    webApp: "express",
    authProfile: "express",
    sourceImageMode: "target-cover",
  },
  "veo31-fast": {
    modelId: "veo31-fast",
    upstreamModel: "google:firefly:colligo:veo31-fast",
    upstreamModelId: "veo",
    upstreamModelVersion: "3.1-fast-generate",
    engine: "veo31-fast",
    webApp: "express",
    authProfile: "express",
    sourceImageMode: "target-cover",
  },
  "veo31-ref": {
    modelId: "veo31-ref",
    upstreamModel: "google:firefly:colligo:veo31",
    upstreamModelId: "veo",
    upstreamModelVersion: "3.1-generate",
    engine: "veo31-standard",
    webApp: "express",
    authProfile: "express",
    sourceImageMode: "target-cover",
  },
  "kling-o3": {
    modelId: "kling-o3",
    upstreamModel: "kling:firefly:colligo:o3",
    upstreamModelId: "kling",
    upstreamModelVersion: "kling_o3_pro_reference_to_video",
    engine: "kling-o3",
    webApp: "express",
    authProfile: "express",
    sourceImageMode: "target-cover",
  },
  kling3: {
    modelId: "kling3",
    upstreamModel: "",
    upstreamModelId: "kling",
    upstreamModelVersion: "kling_v3",
    engine: "kling3",
    webApp: "firefly",
    authProfile: "firefly",
    sourceImageMode: "original",
  },
  "kling3-omni": {
    modelId: "kling3-omni",
    upstreamModel: "",
    upstreamModelId: "kling",
    upstreamModelVersion: "kling_v3_omni",
    engine: "kling3-omni",
    webApp: "firefly",
    authProfile: "firefly",
    sourceImageMode: "original",
  },
  "runway-gen45": {
    modelId: "runway-gen45",
    upstreamModel: "",
    upstreamModelId: "runway",
    upstreamModelVersion: "gen4.5",
    engine: "runway-gen45",
    webApp: "firefly",
    authProfile: "firefly",
    sourceImageMode: "target-cover",
  },
  ray314: {
    modelId: "ray314",
    upstreamModel: "",
    upstreamModelId: "luma",
    upstreamModelVersion: "3.14-ray",
    engine: "ray314",
    webApp: "firefly",
    authProfile: "firefly",
    sourceImageMode: "target-cover",
  },
  "ray314-hdr": {
    modelId: "ray314-hdr",
    upstreamModel: "",
    upstreamModelId: "luma",
    upstreamModelVersion: "3.14-ray-hdr",
    engine: "ray314-hdr",
    webApp: "firefly",
    authProfile: "firefly",
    sourceImageMode: "target-cover",
  },
  seedance2: {
    modelId: "seedance2",
    upstreamModel: "",
    upstreamModelId: "seedance",
    upstreamModelVersion: "seedance_2.0",
    engine: "seedance2",
    webApp: "firefly",
    authProfile: "firefly",
    sourceImageMode: "original",
  },
  "seedance2-fast": {
    modelId: "seedance2-fast",
    upstreamModel: "",
    upstreamModelId: "seedance",
    upstreamModelVersion: "seedance_2.0_fast",
    engine: "seedance2",
    webApp: "firefly",
    authProfile: "firefly",
    sourceImageMode: "original",
  },
} as const satisfies Readonly<Record<VideoModelId, FireflyVideoProviderModel>>;

/**
 * 按精确真实 ID 读取 Adobe 供应商映射。
 *
 * @param modelId - 未受信任模型身份。
 * @returns 真实模型的参数无关 Adobe 映射；旧前缀、复合 ID、别名和未知值返回 null。
 * @sideEffects 无。
 * @failure 不抛错。
 */
export function resolveFireflyVideoProviderModel(
  modelId: unknown
): FireflyVideoProviderModel | null {
  const parsed = videoModelIdSchema.safeParse(modelId);
  return parsed.success ? FIREFLY_VIDEO_PROVIDER_MODELS[parsed.data] : null;
}

// Adobe 视频标签以短边像素命名；非整除结果向上取偶数，故 480p 16:9 为 854×480。
const VIDEO_SIZE_MAP: Readonly<
  Record<
    FireflyVideoResolution,
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
 * 按独立分辨率与宽高比解析 Adobe 视频提交尺寸。
 *
 * @param resolution - 已验证的规范小写分辨率。
 * @param aspectRatio - 已验证的规范宽高比。
 * @returns 独立尺寸对象；未知组合返回 null。
 * @sideEffects 无。
 * @failure 不抛错。
 */
export function fireflyVideoSize(
  resolution: FireflyVideoResolution,
  aspectRatio: VideoAspectRatio | string
): { width: number; height: number } | null {
  const size = VIDEO_SIZE_MAP[resolution]?.[aspectRatio as VideoAspectRatio];
  return size ? { ...size } : null;
}
