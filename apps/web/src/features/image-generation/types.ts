import type { ImageCreditOverrides } from "@repo/shared/image-backend/group-image-pricing";
import type { RequestParameterMapping } from "@repo/shared/image-backend/request-parameter-mapping";

export interface GenerateImageParams {
  prompt: string;
  apiPrompt?: string;
  promptOptimization?: boolean;
  signal?: AbortSignal;
  size?: string;
  width?: number;
  height?: number;
  model?: string;
  gptModel?: string;
  thinking?: ThinkingLevel;
  n?: number;
  quality?: ImageQuality;
  moderation?: ImageModeration;
  outputFormat?: ImageOutputFormat;
  outputCompression?: number;
  background?: ImageBackground;
  /** 透明背景抠图回退(显式开关,issue #27):仅 true 且 background=transparent 时,后端不支持
   * 透明则"不透明重生成 + 服务端 ISNet 抠图"得到透明结果;不开则透明直接透传、不支持即返回真实错误。 */
  transparentMatte?: boolean;
  /** 审核改写重试:显式 false 时本次失败不自动改写提示词重试,直接返回真实错误(issue #24)。 */
  moderationPromptRepair?: boolean;
  /** 高清修复:true 时对最终图用 SCUNet 盲复原(去噪/去压缩块/增强质感,不改分辨率);仅在主开关
   *  IMAGE_RESTORATION_ENABLED 开时生效,默认关(见 operations.ts / image-restoration.ts)。 */
  hdRepair?: boolean;
  /** 分块修复:true 时把最终图切成 2×2 的 1K 块,逐块 gpt-image-2 img2img 重绘(重点修文字)
   *  再拼接、超分到目标。逐块单独计费。仅在主开关 IMAGE_BLOCK_REPAIR_ENABLED 开时生效。 */
  blockRepair?: boolean;
  /** 分块修复每块提示词(覆盖管理端默认);为空用默认。 */
  repairPrompt?: string;
}

export interface GenerateImageResult {
  imageBase64?: string;
  imageUrl?: string;
  imageOutputs?: GeneratedImageOutput[];
  imageOutputCount?: number;
  generationId?: string;
  revisedPrompt?: string;
  upstreamRevisedPrompt?: string;
  promptRepairNotice?: string;
  error?: string;
  upstreamResetAt?: string;
  retryAfterSeconds?: number;
}

export interface GeneratedImageOutput {
  imageBase64?: string;
  imageUrl?: string;
  imageFileId?: string;
  generationId?: string;
  size?: string;
  revisedPrompt?: string;
  upstreamRevisedPrompt?: string;
  promptRepairNotice?: string;
  index?: number;
  outputRole?: "final" | "choice";
}

export interface PartialImageResult {
  imageBase64?: string;
  imageUrl?: string;
  index?: number;
  partialImageIndex?: number;
  final?: boolean;
}

export interface ImageGenerationCallbacks {
  onPartialImage?: (image: PartialImageResult) => Promise<void> | void;
}

export type ImageQuality = "auto" | "low" | "medium" | "high";
export type ImageModeration = "auto" | "low";
export type ImageOutputFormat = "png" | "jpeg" | "webp";
export type ImageBackground = "transparent" | "opaque" | "auto";
export interface ImageInputFile {
  data: Buffer;
  name: string;
  type: string;
  url?: string;
  storageBucket?: string;
  storageKey?: string;
  imageFileId?: string;
}

export type ThinkingLevel =
  | "minimal"
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export interface EditImageParams {
  prompt: string;
  apiPrompt?: string;
  promptOptimization?: boolean;
  signal?: AbortSignal;
  images: ImageInputFile[];
  mask?: ImageInputFile;
  size?: string;
  model?: string;
  gptModel?: string;
  thinking?: ThinkingLevel;
  quality?: ImageQuality;
  n?: number;
  moderation?: ImageModeration;
  outputFormat?: ImageOutputFormat;
  outputCompression?: number;
  background?: ImageBackground;
  /** 透明背景抠图回退(显式开关,issue #27):仅 true 且 background=transparent 时,后端不支持
   * 透明则"不透明重生成 + 服务端 ISNet 抠图"得到透明结果;不开则透明直接透传、不支持即返回真实错误。 */
  transparentMatte?: boolean;
  /** 审核改写重试:显式 false 时本次失败不自动改写提示词重试,直接返回真实错误(issue #24)。 */
  moderationPromptRepair?: boolean;
  /** 高清修复:true 时对最终图用 SCUNet 盲复原(去噪/去压缩块/增强质感,不改分辨率);仅在主开关
   *  IMAGE_RESTORATION_ENABLED 开时生效,默认关(见 operations.ts / image-restoration.ts)。 */
  hdRepair?: boolean;
  /** 分块修复:true 时把最终图切成 2×2 web 尺寸块,逐块 gpt-image-2 img2img 重绘(重点修文字)
   *  再拼接、超分到目标。逐块单独计费。仅在主开关 IMAGE_BLOCK_REPAIR_ENABLED 开时生效。 */
  blockRepair?: boolean;
  /** 分块修复每块提示词(覆盖管理端默认);为空用默认。 */
  repairPrompt?: string;
}

export interface ApiConfig {
  baseUrl: string;
  apiKey: string;
  signal?: AbortSignal;
  model?: string;
  useStream?: boolean;
  contentSafetyEnabled?: boolean;
  headers?: Record<string, string>;
  backend?: {
    type: "platform" | "pool-api" | "pool-adobe";
    id?: string;
    groupId?: string | null;
    userId?: string;
    apiKeyId?: string;
    // 仅 pool-api 使用：发送前把标准请求字段复制或重命名为上游字段。
    parameterMappings?: RequestParameterMapping[];
    // adobe（pool-adobe）专属：暴露的 Firefly 模型家族、默认宽高比/分辨率、是否支持
    // 视频。供 image-generation 派发 adobe 请求时选择 family 与映射缺省值。
    // gateway：调外部 adobe2api；direct：用顶层成员的一对一凭据直连 Firefly。
    adobeMode?: "gateway" | "direct";
    adobeEnabledModels?: string[] | null;
    adobeDefaultRatio?: string;
    adobeDefaultResolution?: string;
    adobeSupportsVideo?: boolean;
    // gpt-image 质量(系统级,low/medium/high → detailLevel 1/3/5);缺省走 high。
    adobeGptImageQuality?: string;
    billingGroupId?: string | null;
    imageCreditOverrides?: ImageCreditOverrides;
    /** 所选计费分组的稀疏视频模型族每秒积分覆盖。 */
    videoCreditOverrides?: Record<string, number>;
  };
}

export interface GenerationRecord {
  id: string;
  prompt: string;
  revisedPrompt: string | null;
  model: string;
  size: string;
  status: "pending" | "completed" | "failed";
  imageUrl: string | null;
  creditsConsumed: number;
  createdAt: Date;
}
