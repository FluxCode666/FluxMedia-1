/**
 * Adobe 视频供应商适配层与迁移期兼容目录。
 *
 * 新请求的真实模型与参数能力只来自中立 video-generation 目录；供应商身份保留在本文件。
 * 旧复合目录仅维持尚未切换的内部调用方可运行，不能作为新请求或账号池的能力事实源，
 * 并会在供应商适配器完成独立参数切换后删除。
 */
import {
  VIDEO_MODEL_CAPABILITIES,
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

/** 旧调用方尚未迁移的输入图角色类型；新请求使用具名输入字段。 */
export type FireflyVideoInputImageRole = "frame" | "reference";

const RATIO_SUFFIX_MAP: Readonly<Record<string, string>> = {
  "1:1": "1x1",
  "4:3": "4x3",
  "3:4": "3x4",
  "16:9": "16x9",
  "9:16": "9x16",
  "21:9": "21x9",
};

/**
 * 旧供应商组合配置形状。
 *
 * 不再从模型字符串构造该对象；供应商适配器必须以真实模型映射和独立请求参数形成上游
 * 载荷。保留类型只用于未迁移调用方通过 TypeScript 编译。
 */
export type FireflyVideoModelConf = {
  family: string;
  upstreamModel: string;
  upstreamModelId: string;
  upstreamModelVersion: string;
  engine: string;
  duration: number;
  aspectRatio: string;
  outputResolution: FireflyVideoResolution;
  size: { width: number; height: number };
  generateAudio: boolean;
  supportsAudio: boolean;
  maxInputImages: number;
  maxReferenceImages?: number;
  webApp: FireflyVideoWebApp;
  authProfile: FireflyVideoWebApp;
  sourceImageMode: FireflyVideoSourceImageMode;
  referenceMode?: "image";
  description: string;
};

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
  readonly referenceMode?: "image";
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
    referenceMode: "image",
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
    Readonly<Record<string, { width: number; height: number }>>
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

type LegacyVideoModelShape = {
  readonly resolutionInId: boolean;
  readonly maxInputImages: number;
  readonly maxReferenceImages?: number;
};

// WHY：公共目录必须立即成为唯一能力事实，但 UOL、账号池和 worker 会在后续单元依次
// 切换。这里冻结原有组合身份形状以保证中间提交可运行；任何新代码都不得消费此映射。
const LEGACY_VIDEO_MODEL_SHAPES = {
  sora2: { resolutionInId: false, maxInputImages: 1 },
  "sora2-pro": { resolutionInId: false, maxInputImages: 1 },
  veo31: { resolutionInId: true, maxInputImages: 2 },
  "veo31-fast": { resolutionInId: true, maxInputImages: 2 },
  "veo31-ref": { resolutionInId: true, maxInputImages: 3 },
  "kling-o3": { resolutionInId: false, maxInputImages: 2 },
  kling3: { resolutionInId: true, maxInputImages: 2 },
  "kling3-omni": {
    resolutionInId: true,
    maxInputImages: 2,
    maxReferenceImages: 3,
  },
  "runway-gen45": { resolutionInId: false, maxInputImages: 0 },
  ray314: { resolutionInId: true, maxInputImages: 0 },
  "ray314-hdr": { resolutionInId: true, maxInputImages: 0 },
  seedance2: { resolutionInId: true, maxInputImages: 1 },
  "seedance2-fast": { resolutionInId: true, maxInputImages: 1 },
} as const satisfies Readonly<Record<VideoModelId, LegacyVideoModelShape>>;

/**
 * 真实视频模型的迁移期旧家族投影。
 *
 * 参数集合来自中立描述符；复合 ID 形状与输入数量冻结为改造前值，仅服务尚未迁移的
 * 内部调用方。新请求和账号池必须直接消费 VIDEO_MODEL_CAPABILITIES。
 */
export const FIREFLY_VIDEO_FAMILIES = VIDEO_MODEL_CAPABILITIES.map(
  (capability) => {
    const legacyShape: LegacyVideoModelShape =
      LEGACY_VIDEO_MODEL_SHAPES[capability.modelId];
    return {
      family: capability.modelId,
      label: capability.displayName,
      durations: capability.durations,
      ratios: capability.aspectRatios,
      resolutions: capability.resolutions,
      resolutionInId: legacyShape.resolutionInId,
      generateAudio: capability.audio.defaultEnabled,
      supportsAudio: capability.audio.supported,
      maxInputImages: legacyShape.maxInputImages,
      ...(legacyShape.maxReferenceImages !== undefined
        ? { maxReferenceImages: legacyShape.maxReferenceImages }
        : {}),
    };
  }
);

/**
 * 迁移期复合模型目录。
 *
 * 仅供尚未切换的内部调用方；新契约必须使用真实 ID 与独立参数。该目录会在 U5 完成
 * 供应商适配器切换后删除，U7 迁移使用独立冻结资料而不是读取这里。
 */
export const FIREFLY_VIDEO_MODEL_CATALOG: Record<
  string,
  FireflyVideoModelConf
> = {};

for (const capability of VIDEO_MODEL_CAPABILITIES) {
  const provider: FireflyVideoProviderModel =
    FIREFLY_VIDEO_PROVIDER_MODELS[capability.modelId];
  const legacyShape: LegacyVideoModelShape =
    LEGACY_VIDEO_MODEL_SHAPES[capability.modelId];
  for (const duration of capability.durations) {
    for (const aspectRatio of capability.aspectRatios) {
      const ratioSuffix = RATIO_SUFFIX_MAP[aspectRatio];
      if (!ratioSuffix) continue;
      for (const resolution of capability.resolutions) {
        const size = VIDEO_SIZE_MAP[resolution]?.[aspectRatio];
        if (!size) continue;
        const compositeId = legacyShape.resolutionInId
          ? `${capability.modelId}-${duration}s-${ratioSuffix}-${resolution}`
          : `${capability.modelId}-${duration}s-${ratioSuffix}`;
        FIREFLY_VIDEO_MODEL_CATALOG[compositeId] = {
          family: capability.modelId,
          upstreamModel: provider.upstreamModel,
          upstreamModelId: provider.upstreamModelId,
          upstreamModelVersion: provider.upstreamModelVersion,
          engine: provider.engine,
          duration,
          aspectRatio,
          outputResolution: resolution,
          size: { ...size },
          generateAudio: capability.audio.defaultEnabled,
          supportsAudio: capability.audio.supported,
          maxInputImages: legacyShape.maxInputImages,
          ...(legacyShape.maxReferenceImages !== undefined
            ? { maxReferenceImages: legacyShape.maxReferenceImages }
            : {}),
          webApp: provider.webApp,
          authProfile: provider.authProfile,
          sourceImageMode: provider.sourceImageMode,
          ...(provider.referenceMode
            ? { referenceMode: provider.referenceMode }
            : {}),
          description: `${capability.displayName} (${duration}s ${aspectRatio} ${resolution})`,
        };
      }
    }
  }
}

/** Kling 3.0 历史无分辨率 ID 的迁移期别名。 */
const LEGACY_VIDEO_MODEL_ALIASES: Readonly<Record<string, string>> =
  Object.fromEntries(
    [5, 10, 15].flatMap((duration) =>
      ["16x9", "9x16"].map((aspectRatio) => {
        const legacyId = `kling3-${duration}s-${aspectRatio}`;
        return [legacyId, `${legacyId}-720p`];
      })
    )
  );

/**
 * 迁移期解析旧复合视频模型 ID。
 *
 * @param modelId - 未受信任模型身份。
 * @returns 旧目录存在的规范裸复合 ID；未知输入返回 null。
 * @sideEffects 无。
 * @failure 不抛错。
 */
export function resolveFireflyVideoModelId(
  modelId?: string | null
): string | null {
  const normalized = String(modelId ?? "")
    .trim()
    .toLowerCase();
  const withoutPrefix = normalized.startsWith("firefly-")
    ? normalized.slice("firefly-".length)
    : normalized;
  const canonical = LEGACY_VIDEO_MODEL_ALIASES[withoutPrefix] ?? withoutPrefix;
  return Object.hasOwn(FIREFLY_VIDEO_MODEL_CATALOG, canonical)
    ? canonical
    : null;
}

/** 解析迁移期旧复合视频 model id；真实 ID 因缺少独立参数返回 null。 */
export function resolveFireflyVideoModel(
  modelId?: string | null
): FireflyVideoModelConf | null {
  const canonicalId = resolveFireflyVideoModelId(modelId);
  return canonicalId
    ? (FIREFLY_VIDEO_MODEL_CATALOG[canonicalId] ?? null)
    : null;
}

/** 判断迁移期目录是否支持给定复合视频 model id。 */
export function isFireflyVideoModelId(modelId?: string | null): boolean {
  return resolveFireflyVideoModel(modelId) !== null;
}

/**
 * 返回旧供应商配置在指定输入语义下允许的图片数量。
 *
 * @param config - U5 切换前调用方持有的供应商配置。
 * @param role - 旧输入图角色。
 * @returns 对应配置上限；0 表示不支持。
 * @sideEffects 无。
 * @failure 不抛错。
 */
export function fireflyVideoMaxInputImages(
  config: FireflyVideoModelConf,
  role: FireflyVideoInputImageRole = "frame"
): number {
  return role === "reference"
    ? (config.maxReferenceImages ?? 0)
    : config.maxInputImages;
}

/** 按旧供应商配置取已经确定的像素宽高。 */
export function fireflyVideoSize(config: FireflyVideoModelConf): {
  width: number;
  height: number;
};

/** 按独立分辨率与宽高比取 Adobe 像素宽高。 */
export function fireflyVideoSize(
  resolution: FireflyVideoResolution,
  aspectRatio: string
): { width: number; height: number } | null;

/**
 * 解析 Adobe 视频提交尺寸。
 *
 * @param configOrResolution - 旧供应商配置，或规范小写分辨率。
 * @param aspectRatio - 使用独立分辨率时必需的规范宽高比。
 * @returns 独立尺寸对象；未知组合返回 null。
 * @sideEffects 无。
 * @failure 不抛错。
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
