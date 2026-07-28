/**
 * Adobe Firefly 直连视频模型目录（依据 adobe2api 视频协议规格移植，见
 * docs/plan/2026-06-20-adobe-firefly-video-spec.md）。
 *
 * 把 model id（firefly-<family>-<dur>s-<ratio>[-<res>]）解析成直连 Adobe Firefly
 * /v2/3p-videos 端点所需的上游 model/modelId/modelVersion/engine + 时长 + 宽高比 +
 * 分辨率 + 音频/参考标志。纯数据 + 纯函数，DB-free，可单测。
 */

export type FireflyVideoResolution = "480p" | "720p" | "1080p" | "4k";
export type FireflyVideoSourceImageMode = "original" | "target-cover";
export type FireflyVideoWebApp = "express" | "firefly";
export type FireflyVideoInputImageRole = "frame" | "reference";

const RATIO_SUFFIX_MAP: Record<string, string> = {
  "1:1": "1x1",
  "4:3": "4x3",
  "3:4": "3x4",
  "16:9": "16x9",
  "9:16": "9x16",
  "21:9": "21x9",
};

// Adobe 视频标签以短边像素命名；非整除结果向上取偶数，故 480p 16:9 为 854×480。
const VIDEO_SIZE_MAP: Record<
  FireflyVideoResolution,
  Record<string, { width: number; height: number }>
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

export type FireflyVideoModelConf = {
  /** Firefly 模型族（如 sora2 / veo31 / kling-o3）。 */
  family: string;
  /** 上游 model 串（如 openai:firefly:colligo:sora2）。 */
  upstreamModel: string;
  /** payload.modelId（sora/veo/kling）。 */
  upstreamModelId: string;
  /** payload.modelVersion。 */
  upstreamModelVersion: string;
  /** 引擎标识（veo31-standard / kling-o3 等），部分上游需要。 */
  engine: string;
  /** 时长（秒）。 */
  duration: number;
  aspectRatio: string;
  outputResolution: FireflyVideoResolution;
  /** 该模型真实提交体使用的像素尺寸。 */
  size: { width: number; height: number };
  /** 是否生成音频（kling3 默认开）。 */
  generateAudio: boolean;
  /** 是否允许调用方覆盖 generateAudio。 */
  supportsAudio: boolean;
  /** 已验证并允许提交的输入图数量上限；0 表示当前只开放文生视频。 */
  maxInputImages: number;
  /** 显式参考图模式的数量上限；缺失或 0 表示只支持首尾帧语义。 */
  maxReferenceImages?: number;
  /** 提交所模拟的 Adobe 网页应用，决定 Origin、Referer 与公开网页 API Key。 */
  webApp: FireflyVideoWebApp;
  /** Bearer Token 来源；必须与目标 Adobe 网页接口的 IMS client_id 对齐。 */
  authProfile: FireflyVideoWebApp;
  /** 上传参考图前保留原图，或按目标尺寸 cover 裁剪。 */
  sourceImageMode: FireflyVideoSourceImageMode;
  /** veo31-ref 参考模式：reference_mode="image"。 */
  referenceMode?: "image";
  description: string;
};

export const FIREFLY_VIDEO_MODEL_CATALOG: Record<
  string,
  FireflyVideoModelConf
> = {};

type VideoFamilySpec = {
  family: string;
  /** 用于拼 model id 的前缀（含 firefly-）。 */
  prefix: string;
  upstreamModel: string;
  upstreamModelId: string;
  upstreamModelVersion: string;
  engine: string;
  durations: number[];
  ratios: string[];
  resolutions: FireflyVideoResolution[];
  /** 分辨率是否拼进 model id（veo31 系列拼，sora/kling 固定不拼）。 */
  resolutionInId: boolean;
  generateAudio?: boolean;
  supportsAudio?: boolean;
  maxInputImages?: number;
  maxReferenceImages?: number;
  webApp?: FireflyVideoWebApp;
  sourceImageMode?: FireflyVideoSourceImageMode;
  referenceMode?: "image";
  label: string;
};

const VIDEO_FAMILY_SPECS: VideoFamilySpec[] = [
  {
    family: "sora2",
    prefix: "sora2",
    upstreamModel: "openai:firefly:colligo:sora2",
    upstreamModelId: "sora",
    upstreamModelVersion: "sora-2",
    engine: "sora2",
    durations: [4, 8, 12],
    ratios: ["9:16", "16:9"],
    resolutions: ["720p"],
    resolutionInId: false,
    label: "Sora 2",
  },
  {
    family: "sora2-pro",
    prefix: "sora2-pro",
    upstreamModel: "openai:firefly:colligo:sora2-pro",
    upstreamModelId: "sora",
    upstreamModelVersion: "sora-2",
    engine: "sora2",
    durations: [4, 8, 12],
    ratios: ["9:16", "16:9"],
    resolutions: ["720p"],
    resolutionInId: false,
    label: "Sora 2 Pro",
  },
  {
    family: "veo31",
    prefix: "veo31",
    upstreamModel: "google:firefly:colligo:veo31",
    upstreamModelId: "veo",
    upstreamModelVersion: "3.1-generate",
    engine: "veo31-standard",
    durations: [4, 6, 8],
    ratios: ["16:9", "9:16"],
    resolutions: ["1080p", "720p"],
    resolutionInId: true,
    label: "Veo 3.1",
  },
  {
    family: "veo31-ref",
    prefix: "veo31-ref",
    upstreamModel: "google:firefly:colligo:veo31",
    upstreamModelId: "veo",
    upstreamModelVersion: "3.1-generate",
    engine: "veo31-standard",
    durations: [4, 6, 8],
    ratios: ["16:9", "9:16"],
    resolutions: ["1080p", "720p"],
    resolutionInId: true,
    referenceMode: "image",
    label: "Veo 3.1 Reference",
  },
  {
    family: "veo31-fast",
    prefix: "veo31-fast",
    upstreamModel: "google:firefly:colligo:veo31-fast",
    upstreamModelId: "veo",
    upstreamModelVersion: "3.1-fast-generate",
    engine: "veo31-fast",
    durations: [4, 6, 8],
    ratios: ["16:9", "9:16"],
    resolutions: ["1080p", "720p"],
    resolutionInId: true,
    label: "Veo 3.1 Fast",
  },
  {
    family: "kling-o3",
    prefix: "kling-o3",
    upstreamModel: "kling:firefly:colligo:o3",
    upstreamModelId: "kling",
    upstreamModelVersion: "kling_o3_pro_reference_to_video",
    engine: "kling-o3",
    durations: [5, 15],
    ratios: ["16:9", "9:16"],
    resolutions: ["1080p"],
    resolutionInId: false,
    label: "Kling O3",
  },
  {
    family: "kling3",
    prefix: "kling3",
    upstreamModel: "",
    upstreamModelId: "kling",
    upstreamModelVersion: "kling_v3",
    engine: "kling3",
    durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    ratios: ["16:9", "9:16"],
    resolutions: ["1080p", "720p"],
    resolutionInId: true,
    generateAudio: true,
    supportsAudio: true,
    webApp: "firefly",
    sourceImageMode: "original",
    label: "Kling 3.0",
  },
  {
    family: "kling3-omni",
    prefix: "kling3-omni",
    upstreamModel: "",
    upstreamModelId: "kling",
    upstreamModelVersion: "kling_v3_omni",
    engine: "kling3-omni",
    durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    ratios: ["16:9", "9:16"],
    resolutions: ["1080p", "720p"],
    resolutionInId: true,
    supportsAudio: true,
    maxInputImages: 2,
    maxReferenceImages: 3,
    webApp: "firefly",
    sourceImageMode: "original",
    label: "Kling 3.0 Omni",
  },
  {
    family: "runway-gen45",
    prefix: "runway-gen45",
    upstreamModel: "",
    upstreamModelId: "runway",
    upstreamModelVersion: "gen4.5",
    engine: "runway-gen45",
    durations: [5, 8, 10],
    ratios: ["16:9"],
    resolutions: ["720p"],
    resolutionInId: false,
    maxInputImages: 0,
    webApp: "firefly",
    label: "Runway Gen-4.5",
  },
  {
    family: "ray314",
    prefix: "ray314",
    upstreamModel: "",
    upstreamModelId: "luma",
    upstreamModelVersion: "3.14-ray",
    engine: "ray314",
    durations: [5, 10],
    ratios: ["1:1", "4:3", "3:4", "16:9", "9:16", "21:9"],
    resolutions: ["4k", "1080p", "720p"],
    resolutionInId: true,
    maxInputImages: 0,
    webApp: "firefly",
    label: "Ray 3.14",
  },
  {
    family: "ray314-hdr",
    prefix: "ray314-hdr",
    upstreamModel: "",
    upstreamModelId: "luma",
    upstreamModelVersion: "3.14-ray-hdr",
    engine: "ray314-hdr",
    durations: [5],
    ratios: ["1:1", "4:3", "3:4", "16:9", "9:16", "21:9"],
    resolutions: ["4k", "1080p", "720p"],
    resolutionInId: true,
    maxInputImages: 0,
    webApp: "firefly",
    label: "Ray 3.14 HDR",
  },
  {
    family: "seedance2",
    prefix: "seedance2",
    upstreamModel: "",
    upstreamModelId: "seedance",
    upstreamModelVersion: "seedance_2.0",
    engine: "seedance2",
    durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    ratios: ["1:1", "4:3", "3:4", "16:9", "9:16", "21:9"],
    resolutions: ["1080p", "720p", "480p"],
    resolutionInId: true,
    supportsAudio: true,
    webApp: "firefly",
    sourceImageMode: "original",
    label: "Seedance 2.0",
  },
  {
    family: "seedance2-fast",
    prefix: "seedance2-fast",
    upstreamModel: "",
    upstreamModelId: "seedance",
    upstreamModelVersion: "seedance_2.0_fast",
    engine: "seedance2",
    durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    ratios: ["1:1", "4:3", "3:4", "16:9", "9:16", "21:9"],
    resolutions: ["720p", "480p"],
    resolutionInId: true,
    supportsAudio: true,
    webApp: "firefly",
    sourceImageMode: "original",
    label: "Seedance 2.0 Fast",
  },
];

/**
 * 解析模型族已验证的输入图数量上限。
 *
 * @param spec 模型族静态规格。
 * @returns 显式上限，或按既有引擎协议推导出的兼容上限。
 * @sideEffects 无。
 * @failure 不抛错；未知引擎保持历史单图能力。
 */
function resolveVideoFamilyMaxInputImages(spec: VideoFamilySpec): number {
  if (spec.maxInputImages !== undefined) return spec.maxInputImages;
  if (spec.engine === "veo31-standard" && spec.referenceMode === "image") {
    return 3;
  }
  if (
    spec.engine === "veo31-fast" ||
    spec.engine === "veo31-standard" ||
    spec.engine === "kling-o3" ||
    spec.engine === "kling3"
  ) {
    return 2;
  }
  return 1;
}

function registerVideoFamily(spec: VideoFamilySpec): void {
  const maxInputImages = resolveVideoFamilyMaxInputImages(spec);
  for (const duration of spec.durations) {
    for (const ratio of spec.ratios) {
      const suffix = RATIO_SUFFIX_MAP[ratio];
      if (!suffix) continue;
      for (const resolution of spec.resolutions) {
        const size = VIDEO_SIZE_MAP[resolution]?.[ratio];
        if (!size) continue;
        const id = spec.resolutionInId
          ? `${spec.prefix}-${duration}s-${suffix}-${resolution}`
          : `${spec.prefix}-${duration}s-${suffix}`;
        FIREFLY_VIDEO_MODEL_CATALOG[id] = {
          family: spec.family,
          upstreamModel: spec.upstreamModel,
          upstreamModelId: spec.upstreamModelId,
          upstreamModelVersion: spec.upstreamModelVersion,
          engine: spec.engine,
          duration,
          aspectRatio: ratio,
          outputResolution: resolution,
          size: { ...size },
          generateAudio: spec.generateAudio ?? false,
          supportsAudio: spec.supportsAudio ?? false,
          maxInputImages,
          ...(spec.maxReferenceImages !== undefined
            ? { maxReferenceImages: spec.maxReferenceImages }
            : {}),
          webApp: spec.webApp ?? "express",
          authProfile: spec.webApp ?? "express",
          sourceImageMode: spec.sourceImageMode ?? "target-cover",
          ...(spec.referenceMode ? { referenceMode: spec.referenceMode } : {}),
          description: `${spec.label} (${duration}s ${ratio} ${resolution})`,
        };
      }
    }
  }
}

for (const spec of VIDEO_FAMILY_SPECS) {
  registerVideoFamily(spec);
}

/**
 * Kling 3.0 历史无分辨率 ID 的兼容映射。
 *
 * @remarks 旧 ID 只解析为 720p，不进入运行时目录，避免管理端重复展示。
 */
const LEGACY_VIDEO_MODEL_ALIASES: Readonly<Record<string, string>> =
  Object.fromEntries(
    [5, 10, 15].flatMap((duration) =>
      ["16x9", "9x16"].map((aspectRatio) => {
        const legacyId = `kling3-${duration}s-${aspectRatio}`;
        return [legacyId, `${legacyId}-720p`];
      })
    )
  );

/** 将历史 Firefly 前缀视频模型规范化为目录使用的裸完整 ID。 */
function normalizeFireflyVideoModelId(modelId: string): string {
  return modelId.startsWith("firefly-")
    ? modelId.slice("firefly-".length)
    : modelId;
}

/**
 * 将可兼容的视频 ID 解析为目录中的规范裸 ID。
 *
 * @param modelId 裸 ID 或历史 Firefly 前缀 ID。
 * @returns 目录存在的裸完整 ID；未知、空值或非法组合返回 null。
 * @sideEffects 无。
 * @failure 不抛错。
 */
export function resolveFireflyVideoModelId(
  modelId?: string | null
): string | null {
  const id = normalizeFireflyVideoModelId(
    String(modelId || "")
      .trim()
      .toLowerCase()
  );
  if (!id) return null;
  const canonicalId = LEGACY_VIDEO_MODEL_ALIASES[id] ?? id;
  return Object.hasOwn(FIREFLY_VIDEO_MODEL_CATALOG, canonicalId)
    ? canonicalId
    : null;
}

/** 视频模型族 id 列表（供前端/接口列出可选模型族）。 */
export const FIREFLY_VIDEO_FAMILIES = VIDEO_FAMILY_SPECS.map((spec) => ({
  family: spec.family,
  label: spec.label,
  durations: spec.durations,
  ratios: spec.ratios,
  resolutions: spec.resolutions,
  resolutionInId: spec.resolutionInId,
  generateAudio: spec.generateAudio ?? false,
  supportsAudio: spec.supportsAudio ?? false,
  maxInputImages: resolveVideoFamilyMaxInputImages(spec),
  ...(spec.maxReferenceImages !== undefined
    ? { maxReferenceImages: spec.maxReferenceImages }
    : {}),
}));

/** 解析 Firefly 或兼容裸视频 model id → 配置；解析不到返回 null。 */
export function resolveFireflyVideoModel(
  modelId?: string | null
): FireflyVideoModelConf | null {
  const canonicalId = resolveFireflyVideoModelId(modelId);
  if (!canonicalId) return null;
  return FIREFLY_VIDEO_MODEL_CATALOG[canonicalId] ?? null;
}

/** 是否为目录支持的 Firefly 或兼容裸视频 model id。 */
export function isFireflyVideoModelId(modelId?: string | null): boolean {
  return resolveFireflyVideoModel(modelId) !== null;
}

/**
 * 返回各 Firefly 视频模型在指定语义下允许的输入图数量上限。
 *
 * @param config 已解析的视频模型配置。
 * @param role 输入图角色；默认保持既有首尾帧语义。
 * @returns 该角色允许的数量；0 表示不支持。
 * @sideEffects 无。
 */
export function fireflyVideoMaxInputImages(
  config: FireflyVideoModelConf,
  role: FireflyVideoInputImageRole = "frame"
): number {
  return role === "reference"
    ? (config.maxReferenceImages ?? 0)
    : config.maxInputImages;
}

/** 按已解析模型配置取真实提交像素宽高。 */
export function fireflyVideoSize(config: FireflyVideoModelConf): {
  width: number;
  height: number;
};

/** 按通用分辨率 + 宽高比取像素宽高，供旧调用方兼容使用。 */
export function fireflyVideoSize(
  resolution: FireflyVideoResolution,
  aspectRatio: string
): { width: number; height: number } | null;

/**
 * 解析 Adobe 视频提交尺寸。
 *
 * @param configOrResolution 已解析模型配置，或通用分辨率标签。
 * @param aspectRatio 仅通用分辨率调用形态需要的宽高比。
 * @returns 独立尺寸对象；通用映射不存在时返回 null。
 * @sideEffects 无。
 * @failure 不抛错，未知通用组合返回 null。
 */
export function fireflyVideoSize(
  configOrResolution: FireflyVideoModelConf | FireflyVideoResolution,
  aspectRatio?: string
): { width: number; height: number } | null {
  if (typeof configOrResolution === "object") {
    return { ...configOrResolution.size };
  }
  const size = VIDEO_SIZE_MAP[configOrResolution]?.[aspectRatio ?? ""];
  return size ? { ...size } : null;
}
