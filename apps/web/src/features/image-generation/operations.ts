/**
 * 图片生成统一管线与计费结算编排。
 *
 * 所有 generate、edit、Chat、Agent、审核和修复贡献均复用父 generation 的
 * 计费操作上下文；sourceRef 仅承担每笔账本写入幂等，不参与操作身份推断。
 */

import { db } from "@repo/database";
import { generation } from "@repo/database/schema";
import { isAdobeImageFamilyModelId } from "@repo/shared/adobe";
import { resolveImageOutputCount } from "@repo/shared/analytics/output-count";
import { GPT55_CHAT_MODEL } from "@repo/shared/config/subscription-plan";
import { consumeCredits } from "@repo/shared/credits/core";
import type { CreditOperationContext } from "@repo/shared/credits/usage-read-model";
import {
  IMAGE_GENERATION_PENDING_TIMEOUT_MS,
  refundGenerationCredits,
  resolveImageGenerationTimeoutError,
} from "@repo/shared/generation-maintenance";
import { getFailedGenerationTargetCredits } from "@repo/shared/generation-settlement";
import { logWarn } from "@repo/shared/logger";
import { isContentModerationEnabled } from "@repo/shared/moderation";
import { getStorageProvider } from "@repo/shared/storage/providers";
import { buildSignedStorageImageUrl } from "@repo/shared/storage/signed-url";
import {
  getPlanCapabilitySnapshot,
  getPlanQueueSettings,
} from "@repo/shared/subscription/services/plan-capabilities";
import { getUserPlan } from "@repo/shared/subscription/services/user-plan";
import {
  getRuntimeSettingBoolean,
  getRuntimeSettingNumber,
  getRuntimeSettingString,
} from "@repo/shared/system-settings";
import { and, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { completeImageGenerationWithUsage } from "@/features/dashboard/output-usage-read-model";
import {
  refundExternalApiKeyCredits,
  reserveExternalApiKeyCredits,
} from "@/features/external-api/quota";
import {
  ImageBackendPoolUnavailableError,
  releaseImageBackendInflightLease,
} from "@/features/image-backend-pool/service";
import type { ImageBackendRequestKind } from "@/features/image-backend-pool/types";
import {
  buildGenerationBillingPolicy,
  type GenerationBillingPolicy,
  getImageSuccessTargetCredits,
  getInitialGenerationCharge,
  getModerationFailureCharge,
  getTextChatSuccessTargetCredits,
} from "./billing-policy";
import { createImageCreditOperation } from "./credit-operation-context";
import { toClientErrorMessage } from "./error-sanitize";
import { buildInputImagesMetadata } from "./generation-metadata";
import { generativeRepairImage } from "./generative-repair";
import { restoreImage } from "./image-restoration";
import { maskedOutpaintImage } from "./masked-outpaint";
import {
  createGenerationModerationContext,
  type GenerationModerationContext,
} from "./moderation-policy";
import {
  detectImageOutputFormatFromBuffer,
  getOutputFormatContentType,
  getOutputFormatExtension,
  normalizeOutputFormat,
} from "./output-format";
import { getRuntimeImageCreditPricing } from "./pricing-settings";
import { withImageGenerationQueue } from "./queue";
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_IMAGE_SIZE,
  getImageBackendApiModel,
  getImageCreditCostBreakdown,
  getImageModel,
  getImageSizePixels,
  type ImageBaseCreditPricing,
  type ImageQualityLevel,
  type ImageThinkingLevel,
  isFireflyModel,
  isImageModel,
  isImageSizeWithinPixelRange,
  normalizeImageSize,
  parseImageSize,
  type ResolvedImageModerationCreditPricing,
  roundCreditAmount,
  roundUpCreditAmount,
} from "./resolution";
import { calibrateImageResolution } from "./resolution-calibration";
import { resolveImageResolutionSettlement } from "./resolution-settlement";
import {
  editImage,
  generateChatImage,
  generateImage,
  getEffectiveConfig,
  getResponsesModel,
  poolBackendMemberType,
  repairModerationBlockedPromptWithResponses,
} from "./service";
import { isContentSafetyRejection } from "./sla-classification";
import { superResolve } from "./super-resolution";
import {
  applyTransparentMatte,
  isTransparentUnsupportedError,
} from "./transparent-fallback";
import type {
  AgentRunEvent,
  ApiConfig,
  ChatHistoryMessage,
  ChatImageParams,
  EditImageParams,
  GenerateImageParams,
  GenerateImageResult,
  ImageGenerationCallbacks,
  ImageInputFile,
  PartialImageResult,
} from "./types";

type RunImageGenerationInput =
  | ({
      mode: "generate";
      userId: string;
      generationId?: string;
      apiKeyId?: string;
      backendGroupId?: string;
      backendRequestKind?: ImageBackendRequestKind;
      preferredBackendMemberId?: string;
      preferredBackendMemberType?: "api" | "account" | "adobe";
      stickyPreviousResponseId?: string;
      stickySessionKey?: string;
      mixWebFirst?: boolean;
      forceWebBackend?: boolean;
      forceFirefly?: boolean;
      requiresResponsesBackend?: boolean;
    } & GenerateImageParams)
  | ({
      mode: "edit";
      userId: string;
      generationId?: string;
      apiKeyId?: string;
      backendGroupId?: string;
      backendRequestKind?: ImageBackendRequestKind;
      preferredBackendMemberId?: string;
      preferredBackendMemberType?: "api" | "account" | "adobe";
      stickyPreviousResponseId?: string;
      stickySessionKey?: string;
      mixWebFirst?: boolean;
      forceWebBackend?: boolean;
      forceFirefly?: boolean;
      requiresResponsesBackend?: boolean;
    } & EditImageParams)
  | ({
      mode: "chat";
      userId: string;
      generationId?: string;
      apiKeyId?: string;
      backendGroupId?: string;
      backendRequestKind?: ImageBackendRequestKind;
      preferredBackendMemberId?: string;
      preferredBackendMemberType?: "api" | "account" | "adobe";
      stickyPreviousResponseId?: string;
      stickySessionKey?: string;
      maxChatContextChars?: number;
      mixWebFirst?: boolean;
      forceWebBackend?: boolean;
      forceFirefly?: boolean;
      requiresResponsesBackend?: boolean;
      webChat?: boolean;
    } & ChatImageParams);

const DEFAULT_FORCE_WEB_MIN_PIXELS = 660_000;
const DEFAULT_FORCE_WEB_MAX_PIXELS = 2_000_000;

type ForceWebPixelRange = {
  minPixels: number;
  maxPixels: number;
};

async function getForceWebPixelRange(): Promise<ForceWebPixelRange> {
  const [minPixels, maxPixels] = await Promise.all([
    getRuntimeSettingNumber(
      "IMAGE_FORCE_WEB_MIN_PIXELS",
      DEFAULT_FORCE_WEB_MIN_PIXELS,
      { nonNegative: true }
    ),
    getRuntimeSettingNumber(
      "IMAGE_FORCE_WEB_MAX_PIXELS",
      DEFAULT_FORCE_WEB_MAX_PIXELS,
      { positive: true }
    ),
  ]);

  return {
    minPixels: Math.min(minPixels, maxPixels),
    maxPixels: Math.max(minPixels, maxPixels),
  };
}

function shouldForceWebBackend(
  input: RunImageGenerationInput,
  size: string,
  range: ForceWebPixelRange
) {
  const requiresResponsesBackend = Boolean(
    input.requiresResponsesBackend || (input.mode === "chat" && input.agentMode)
  );
  if (requiresResponsesBackend) return false;

  // Web-first 默认开启:gen/edit 的 web_first/force_web 落到 input.forceWebBackend,
  // chat 的 mix_web_first 落到 input.mixWebFirst;任一被显式给出则取其值,均未给(默认)
  // 按 true 处理。这样 chat 的 mix_web_first 仍被纳入决策,不会因默认 web-first 失效。
  const webFirst = input.forceWebBackend ?? input.mixWebFirst ?? true;
  // web_first 显式 false → 不优先 Web(走正常调度)。
  if (!webFirst) return false;
  // web_first 为 true(含默认未传)→ Web-first 像素区间生效:尺寸可解析且落在区间内
  // 才优先 Web;超出区间(如 4K)则不优先,避免把 Web 出不了的大图塞给 Web。auto/无法
  // 解析的尺寸无从判断大小,视为可走 Web。该判定只对 mixed 分组生效(mixed-only)。
  if (getImageSizePixels(size) === null) return true;
  return isImageSizeWithinPixelRange(size, range.minPixels, range.maxPixels);
}

type ImageCreditCostBreakdown = ReturnType<typeof getImageCreditCostBreakdown>;

function getChatRoundCount(result: GenerateImageResult) {
  return Math.max(1, Math.floor(result.agentRoundCount || 1));
}

/**
 * 按最终选中的后端解析图像模型。
 *
 * 未知自定义模型只能在管理员配置的 pool-api 中透传；裸 Adobe 图像家族模型也允许
 * 在 pool-adobe 中解析后派发，其他后端继续使用既有 `gpt-image-*`/Firefly 白名单。
 *
 * @param config - 已完成池调度的上游配置。
 * @param requestedModel - 客户端显式模型或后端默认模型。
 * @returns 可用于当前后端的图像模型；非 API 后端的未知模型返回 null。
 */
function getImageModelForResolvedConfig(
  config: ApiConfig,
  requestedModel?: string | null
) {
  if (config.backend?.type === "pool-api") {
    return getImageBackendApiModel(requestedModel, config.model);
  }

  const imageModel = getImageModel(requestedModel, config.model);
  if (imageModel) return imageModel;

  // 裸 Adobe 家族模型（如 nano-banana-pro）允许在 pool-adobe 中按普通候选参与调度；
  // 其他非平台模型仍必须拒绝，避免把自定义模型错误发送给 OAuth 账号。
  if (
    config.backend?.type === "pool-adobe" &&
    isAdobeImageFamilyModelId(requestedModel)
  ) {
    return requestedModel?.trim();
  }

  return null;
}

/**
 * 选择后端时使用的模型标识。
 *
 * Chat/Responses 的顶层 `model` 通常是对话模型，真正的图像模型位于 `imageModel`。
 * 当该图像模型不是平台白名单时，必须把它交给调度器，以便只选择 pool-api 而不把
 * 请求错误地发到 OAuth 账号。
 *
 * @param input - 当前统一图像管线输入。
 * @returns 应参与后端选择的模型标识。
 */
function getRequestedModelForBackendSelection(input: RunImageGenerationInput) {
  if (
    input.mode === "chat" &&
    input.imageModel?.trim() &&
    !isImageModel(input.imageModel)
  ) {
    return input.imageModel;
  }
  return input.model;
}

function resolveOutputRole(params: {
  input: RunImageGenerationInput;
  outputRole?: "final" | "agent_draft" | "choice";
  index: number;
  total: number;
}) {
  if (params.outputRole === "choice") return "choice";
  // 分层生成:整图(index 0)=成品 final;背景/各元素=中间图 agent_draft。
  // 忽略 merge 标的"最后一张=final"(分层里最后一张是某个元素层,不该当成品)——否则图库会把
  // 整图归到中间图、把某个元素当成品,导致"原版在中间图、成品没导出按钮、导出缺层"等错位。
  if (
    params.input.mode === "chat" &&
    params.input.agentMode &&
    params.input.layeredGeneration
  ) {
    return params.index === 0 ? "final" : "agent_draft";
  }
  if (params.input.mode === "chat" && params.input.agentMode) {
    return (
      params.outputRole ||
      (params.index === params.total - 1 ? "final" : "agent_draft")
    );
  }
  return "final";
}

export type ImageGenerationOperationResult = {
  error?: string;
  generationId?: string;
  imageUrl?: string;
  /** 可选的内联 base64，供响应层直接产出 b64_json。 */
  imageBase64?: string;
  imageFileId?: string;
  imageOutputs?: GenerateImageResult["imageOutputs"];
  model?: string;
  size?: string;
  revisedPrompt?: string;
  promptRepairNotice?: string;
  responseText?: string;
  responseThinking?: string;
  responseAgent?: string;
  agentEvents?: GenerateImageResult["agentEvents"];
  agentRoundCount?: GenerateImageResult["agentRoundCount"];
  layered?: GenerateImageResult["layered"];
  webConversation?: GenerateImageResult["webConversation"];
  backendMember?: GenerateImageResult["backendMember"];
  responsesPreviousResponse?: GenerateImageResult["responsesPreviousResponse"];
  creditsConsumed?: number;
};

async function getStoredImageUrl(bucket: string, storageKey: string) {
  return buildSignedStorageImageUrl(storageKey, bucket) ?? "";
}

async function toImageBuffer(result: {
  imageBase64?: string;
  imageUrl?: string;
}) {
  if (result.imageBase64) {
    const base64 = result.imageBase64.includes(",")
      ? result.imageBase64.split(",").pop() || result.imageBase64
      : result.imageBase64;
    return Buffer.from(base64, "base64");
  }

  if (!result.imageUrl) {
    throw new Error("Missing image data");
  }

  const response = await fetch(result.imageUrl);
  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

function stripTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function getImageFileName(params: {
  generationId: string;
  contentType: string;
}) {
  const extension =
    params.contentType === "image/jpeg"
      ? "jpg"
      : params.contentType === "image/webp"
        ? "webp"
        : "png";
  return `${params.generationId}.${extension}`;
}

function toBlobPart(buffer: Buffer): BlobPart {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  ) as ArrayBuffer;
}

function getOutputFileCacheBackend(config: ApiConfig) {
  const backend = config.backend;
  if (
    !backend ||
    backend.type !== "pool-account" ||
    backend.accountBackend !== "responses"
  ) {
    return null;
  }
  if (process.env.IMAGE_CODEX_FILES_API_ENABLED !== "true") {
    return null;
  }
  return backend;
}

function getMultipartHeaders(config: ApiConfig) {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(config.headers || {})) {
    if (key.toLowerCase() === "content-type") continue;
    headers[key] = value;
  }
  headers.Authorization = `Bearer ${config.apiKey}`;
  return headers;
}

async function uploadResponsesImageFile(params: {
  config: ApiConfig;
  buffer: Buffer;
  contentType: string;
  generationId: string;
}): Promise<ResponsesUploadedImageFile | undefined> {
  if (!getOutputFileCacheBackend(params.config)) return undefined;

  const formData = new FormData();
  const fileName = getImageFileName({
    generationId: params.generationId,
    contentType: params.contentType,
  });
  formData.append(
    "file",
    new Blob([toBlobPart(params.buffer)], { type: params.contentType }),
    fileName
  );
  formData.append("purpose", "vision");

  try {
    const response = await fetch(
      `${stripTrailingSlash(params.config.baseUrl)}/files`,
      {
        method: "POST",
        headers: getMultipartHeaders(params.config),
        body: formData,
      }
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      logWarn("Responses 输出图片上传 Files 失败", {
        status: response.status,
        generationId: params.generationId,
        body: body.slice(0, 500),
      });
      return undefined;
    }
    const payload = (await response.json().catch(() => null)) as {
      id?: unknown;
    } | null;
    const fileId = typeof payload?.id === "string" ? payload.id : undefined;
    if (!fileId) {
      logWarn("Responses 输出图片上传 Files 未返回 file id", {
        generationId: params.generationId,
      });
      return undefined;
    }
    return { fileId, source: "files_api" };
  } catch (error) {
    logWarn("Responses 输出图片上传 Files 异常", {
      generationId: params.generationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

type StoredGeneratedImageOutput = {
  generationId: string;
  imageUrl: string;
  /** 可选的内联图片数据。 */
  imageBase64?: string;
  imageFileId?: string;
  webImageMessageId?: string;
  webImageGroupId?: string;
  storageKey: string;
  fileSize: number;
  size: string;
  revisedPrompt?: string;
  upstreamRevisedPrompt?: string;
  actualSizeDetected: boolean;
  actualOutputFormat: string | null;
  actualOutputFormatDetected: boolean;
  outputRole?: "final" | "agent_draft" | "choice";
};

type ResponsesUploadedImageFile = {
  fileId: string;
  source: "files_api";
};

function resolveStoredImageFormat(buffer: Buffer, requestedFormat?: string) {
  const detectedFormat = detectImageOutputFormatFromBuffer(buffer);
  const fallbackFormat = normalizeOutputFormat(requestedFormat) || "png";
  const format = detectedFormat || fallbackFormat;
  return {
    format,
    contentType: getOutputFormatContentType(format),
    extension: getOutputFormatExtension(format),
    detected: Boolean(detectedFormat),
  };
}

function isPendingGeneration(generationId: string) {
  return and(eq(generation.id, generationId), eq(generation.status, "pending"));
}

function readUInt24LE(buffer: Buffer, offset: number) {
  return buffer.readUIntLE(offset, 3);
}

function getPngDimensions(buffer: Buffer) {
  if (
    buffer.length < 24 ||
    buffer.readUInt32BE(0) !== 0x89504e47 ||
    buffer.readUInt32BE(4) !== 0x0d0a1a0a
  ) {
    return null;
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function getJpegDimensions(buffer: Buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }

    const marker = buffer.readUInt8(offset + 1);
    offset += 2;
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 2 > buffer.length) break;

    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;

    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame && length >= 7) {
      return {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
      };
    }
    offset += length;
  }

  return null;
}

function getWebpDimensions(buffer: Buffer) {
  if (
    buffer.length < 30 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return null;
  }

  const chunk = buffer.toString("ascii", 12, 16);
  if (chunk === "VP8 " && buffer.length >= 30) {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === "VP8L" && buffer.length >= 25) {
    const bits = buffer.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  if (chunk === "VP8X" && buffer.length >= 30) {
    return {
      width: readUInt24LE(buffer, 24) + 1,
      height: readUInt24LE(buffer, 27) + 1,
    };
  }

  return null;
}

function getImageDimensionsFromBuffer(buffer: Buffer) {
  const dimensions =
    getPngDimensions(buffer) ||
    getJpegDimensions(buffer) ||
    getWebpDimensions(buffer);
  if (!dimensions?.width || !dimensions.height) return null;
  return dimensions;
}

function getInputImages(input: RunImageGenerationInput): ImageInputFile[] {
  if (input.mode === "generate") return [];
  return input.images || [];
}

function getChatHistoryText(message: ChatHistoryMessage) {
  if (message.error) return "";
  if (message.role === "user") return message.text || "";

  const variants = message.variants || [];
  const variant = variants[message.activeVariant || 0] || variants[0];
  const imageNote = variant?.imageUrl
    ? `\nGenerated image: ${variant.imageUrl}`
    : "";
  return `${variant?.text || message.text || ""}${imageNote}`;
}

function getChatContextLength(params: {
  prompt: string;
  apiPrompt?: string;
  fileContext?: string;
  promptOptimization?: boolean;
  history?: ChatHistoryMessage[];
}) {
  const basePrompt =
    params.promptOptimization === false
      ? params.prompt
      : params.apiPrompt || params.prompt;
  const currentPrompt = params.fileContext
    ? `${basePrompt}\n\n${params.fileContext}`
    : basePrompt;

  return (
    currentPrompt.length +
    (params.history || []).reduce(
      (total, message) => total + getChatHistoryText(message).length,
      0
    )
  );
}

function buildPromptOptimizationMetadata(params: {
  input: RunImageGenerationInput;
  promptOptimization: boolean;
  apiPrompt: string;
}) {
  const requestedApiPrompt = params.input.apiPrompt || "";
  return {
    promptOptimization: {
      enabled: params.promptOptimization,
      explicit: params.input.promptOptimization !== undefined,
      apiPromptProvided: Boolean(requestedApiPrompt),
      apiPromptUsed:
        params.promptOptimization && params.apiPrompt !== params.input.prompt,
      platformPromptRewriteDisabled: !params.promptOptimization,
      originalPromptInstructionInjected: false,
      effectivePromptChanged: params.apiPrompt !== params.input.prompt,
      effectivePromptKind: !params.promptOptimization
        ? "original"
        : params.apiPrompt !== params.input.prompt
          ? "api_prompt"
          : "original",
      originalPromptLength: params.input.prompt.length,
      effectivePromptLength: params.apiPrompt.length,
    },
  };
}

function buildRevisedPromptMetadata(params: {
  input: RunImageGenerationInput;
  apiPrompt: string;
  result: { revisedPrompt?: string; upstreamRevisedPrompt?: string };
}) {
  const upstreamRevisedPrompt =
    params.result.upstreamRevisedPrompt?.trim() ||
    params.result.revisedPrompt?.trim() ||
    "";
  return {
    promptOptimizationResult: {
      hasRevisedPrompt: Boolean(params.result.revisedPrompt?.trim()),
      hasUpstreamRevisedPrompt: Boolean(upstreamRevisedPrompt),
      upstreamRevisedPromptChangedFromOriginal:
        Boolean(upstreamRevisedPrompt) &&
        upstreamRevisedPrompt !== params.input.prompt,
      upstreamRevisedPromptChangedFromEffective:
        Boolean(upstreamRevisedPrompt) &&
        upstreamRevisedPrompt !== params.apiPrompt,
      upstreamRevisedPromptLength: upstreamRevisedPrompt.length,
      upstreamRevisedPromptSuppressed:
        params.input.promptOptimization === false &&
        Boolean(upstreamRevisedPrompt),
    },
  };
}

function buildResponseOutputMetadata(result: GenerateImageResult) {
  const agentEvents = sanitizeAgentEventsForMetadata(result.agentEvents);

  return {
    responseOutput: {
      responseText: result.responseText,
      responseThinking: result.responseThinking,
      responseAgent: result.responseAgent,
      agentEvents,
      agentRoundCount: result.agentRoundCount,
      webConversation: result.webConversation,
      backendMember: result.backendMember,
      responsesPreviousResponse: result.responsesPreviousResponse,
    },
  };
}

function sanitizeAgentEventsForMetadata(
  events: GenerateImageResult["agentEvents"] | undefined
) {
  return events?.map((event) => {
    const next = { ...event };
    delete next.imageBase64;
    if (next.imageUrl?.startsWith("data:image/")) {
      delete next.imageUrl;
    }
    return next;
  });
}

function getResultImageOutputs(result: GenerateImageResult) {
  const outputs = (result.imageOutputs || []).filter(
    (item) => item.imageBase64 || item.imageUrl
  );
  if (outputs.length > 0) return outputs;
  if (!result.imageBase64 && !result.imageUrl) return [];
  return [
    {
      imageBase64: result.imageBase64,
      imageUrl: result.imageUrl,
      revisedPrompt: result.revisedPrompt,
      upstreamRevisedPrompt: result.upstreamRevisedPrompt,
      index: 0,
    },
  ] satisfies NonNullable<GenerateImageResult["imageOutputs"]>;
}

const MAX_MODERATION_PROMPT_REPAIR_RETRIES = 5;
const MODERATION_PROMPT_REPAIR_NOTICE =
  "The original prompt was rejected by safety checks, so this request was generated after additional prompt adjustments.";

type ModerationPromptRepairAttempt = {
  attempt: number;
  phase: "pre_moderation" | "upstream_generation" | "missing_image_output";
  status: "attempted" | "retrying" | "succeeded" | "failed" | "skipped";
  reason: string;
  originalPrompt: string;
  repairedPrompt?: string;
  error?: string;
  backendMember?: GenerateImageResult["backendMember"];
  createdAt: string;
};

function truncateMetadataText(value: string, maxLength = 1000) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}...`
    : normalized;
}

function buildModerationPromptRepairMetadata(
  attempts: ModerationPromptRepairAttempt[]
) {
  return {
    moderationPromptRepair: {
      enabled: true,
      totalAttempts: attempts.length,
      succeeded: attempts.some((attempt) => attempt.status === "succeeded"),
      notice: attempts.some((attempt) => attempt.status === "succeeded")
        ? MODERATION_PROMPT_REPAIR_NOTICE
        : undefined,
      attempts,
    },
  };
}

function withPromptRepairMetadata(
  metadata: Record<string, unknown>,
  attempts: ModerationPromptRepairAttempt[]
) {
  return attempts.length
    ? { ...metadata, ...buildModerationPromptRepairMetadata(attempts) }
    : metadata;
}

function hasImageOutput(result: GenerateImageResult) {
  return Boolean(
    result.imageBase64 ||
      result.imageUrl ||
      result.imageOutputs?.some((item) => item.imageBase64 || item.imageUrl)
  );
}

function hasSuccessfulPromptRepairAttempt(
  attempts: ModerationPromptRepairAttempt[]
) {
  return attempts.some((attempt) => attempt.status === "succeeded");
}

function getPromptRepairNotice(attempts: ModerationPromptRepairAttempt[]) {
  return hasSuccessfulPromptRepairAttempt(attempts)
    ? MODERATION_PROMPT_REPAIR_NOTICE
    : undefined;
}

function getModerationRepairFailureMessage(
  result: GenerateImageResult,
  isChatInput: boolean
) {
  if (result.error && isContentSafetyRejection(result.error)) {
    return result.error;
  }
  if (hasImageOutput(result)) return null;
  const message =
    result.responseText?.trim() ||
    result.responseAgent?.trim() ||
    "Image generation completed without an image output";
  if (isContentSafetyRejection(message)) return message;
  if (isChatInput) return null;
  return null;
}

function getLastRetryingRepairAttempt(
  attempts: ModerationPromptRepairAttempt[]
) {
  return attempts
    .slice()
    .reverse()
    .find((attempt) => attempt.status === "retrying");
}

function resolveOutputGenerationId(
  parentGenerationId: string,
  index: number,
  total: number
) {
  return index === total - 1
    ? parentGenerationId
    : `${parentGenerationId}-${index + 1}`;
}

// 生成式修复默认提示词：整图重绘、只修不改（请求级 repair_prompt 可覆盖）。
// 也用于掩码外绘的首块（种子块，无邻居、整块基于原图内容重绘）。
const DEFAULT_BLOCK_REPAIR_PROMPT =
  "Redraw this entire image to restore and sharpen it: fix blurry or garbled text and fine details, keep the exact same composition, layout, colors and content unchanged. Do not add, remove, move or reinterpret anything.";

/** 块在网格中的方位词（如 top-left / top-right / bottom / center）。 */
function describeOutpaintRegion(
  col: number,
  row: number,
  cols: number,
  rows: number
): string {
  const h =
    cols <= 1 ? "" : col === 0 ? "left" : col === cols - 1 ? "right" : "center";
  const v =
    rows <= 1 ? "" : row === 0 ? "top" : row === rows - 1 ? "bottom" : "middle";
  return [v, h].filter(Boolean).join("-") || "whole";
}

/**
 * 掩码外绘「自主拓展」位置提示词：不喂原图/参考,只按块方位告诉模型「根据四周已渲染内容补出该方位」。
 * 首块(无左/上邻)=修复种子;其余=从已提交的非黑边缘往黑区补,且强调只画本方位、勿把整幅画塞进一块。
 */
function buildOutpaintPrompt(pos: {
  col: number;
  row: number;
  cols: number;
  rows: number;
}): string {
  const region = describeOutpaintRegion(pos.col, pos.row, pos.cols, pos.rows);
  const hasLeft = pos.col > 0;
  const hasTop = pos.row > 0;
  if (!hasLeft && !hasTop) {
    return `This picture is the ${region} region of a larger complete image. Restore and sharpen only this ${region} region — fix blurry or garbled text and fine details, keep the same content. Render only what belongs in this ${region} region at its true scale; do NOT zoom out or squeeze the whole scene into this frame.`;
  }
  const edges = hasLeft && hasTop ? "left and top" : hasLeft ? "left" : "top";
  return `This tile is the ${region} region of a larger image. The non-black pixels along the ${edges} edge(s) are the already-rendered neighbouring region. Using those surroundings as context, extend the scene into the black area — fill in only the ${region} direction so it continues seamlessly from the ${edges} edge(s), matching style, lighting, colours and perspective. Render only this ${region} region at its true scale; do NOT zoom out or draw the whole scene, and change nothing outside the black area.`;
}

async function storeGeneratedImageOutput(params: {
  output: {
    imageBase64?: string;
    imageUrl?: string;
    imageFileId?: string;
    webImageMessageId?: string;
    webImageGroupId?: string;
    revisedPrompt?: string;
    upstreamRevisedPrompt?: string;
    outputRole?: "final" | "agent_draft" | "choice";
  };
  config: ApiConfig;
  userId: string;
  generationId: string;
  bucket: string;
  requestedSize: string;
  requestedFormat?: string;
  /** 高清修复开关(请求级):true 且主开关开时用 SCUNet 盲复原最终图(不改分辨率);其余不修复。 */
  hdRepair?: boolean;
  /** 分块修复开关(请求级):true 时把图切成 2×2 web 尺寸块逐块 gpt-image-2 重绘再拼接。 */
  blockRepair?: boolean;
  /** 分块修复的每块提示词(请求级覆盖);为空则用管理端默认。 */
  repairPrompt?: string;
  /** 逐块计费回调(由调用点注入,携带 chargeAdditionalCredits+定价);每成功重绘一块调一次。 */
  chargeTile?: (tileSize: string, tileIndex: number) => Promise<void>;
}) {
  let imageBuffer: Buffer = await toImageBuffer(params.output);
  // 出图后处理（仅对最终图）：修复与超分两个独立步骤，各自主开关门控、失败回退不阻断。
  // 顺序=先修复再超分（修复在原分辨率上跑更省算力，超分再放大到目标）。
  const isFinalImage =
    !params.output.outputRole || params.output.outputRole === "final";
  if (isFinalImage) {
    // 修复（手动勾选 hdRepair + 主开关 IMAGE_RESTORATION_ENABLED）：SCUNet 盲复原、不改尺寸。
    // 重模型、CPU 慢，故默认关、需用户显式勾选；内部有全局串行闸防并发打满机器。
    if (
      params.hdRepair === true &&
      (await getRuntimeSettingBoolean("IMAGE_RESTORATION_ENABLED", false))
    ) {
      const restored = await restoreImage(imageBuffer);
      imageBuffer = restored.buffer;
    }
    // 生成式修复（手动 blockRepair）：两种技术二选一，由管理端主开关决定，均自带到目标分辨率
    // （启用成功时替代下面独立超分）、逐块/次计费(chargeTile)、失败回退不阻断：
    //  - IMAGE_MASK_OUTPAINT_ENABLED：掩码顺序外绘（1K tile + mask，路由 codex，无缝，见 masked-outpaint.ts）
    //  - IMAGE_BLOCK_REPAIR_ENABLED ：整图一次重绘 + general 超分（见 generative-repair.ts）
    let blockRepaired = false;
    if (params.blockRepair === true) {
      const target = parseImageSize(params.requestedSize || DEFAULT_IMAGE_SIZE);
      // 提示词:请求级 repairPrompt 覆盖 > 内置默认(无需管理端配置)。
      const repairPrompt =
        params.repairPrompt?.trim() || DEFAULT_BLOCK_REPAIR_PROMPT;
      const maskOutpaint = await getRuntimeSettingBoolean(
        "IMAGE_MASK_OUTPAINT_ENABLED",
        false
      );
      const wholeRepair = await getRuntimeSettingBoolean(
        "IMAGE_BLOCK_REPAIR_ENABLED",
        false
      );
      if (target && maskOutpaint) {
        // 掩码顺序外绘（留黑真外绘）:在目标尺寸上切 1K 重叠块,逐块把待补区留黑、
        // 只留已提交邻块的边,让模型「从边缘往黑区外绘」,并严格照整幅原图参考还原该处内容。
        // 每块都单独解析支持 image_edit + mask 的后端，不能复用主生图配置：主配置可能是
        // Web/Adobe 或仅支持 image_generation 的成员，它们会静默忽略蒙版。每块重新解析也让
        // 租约与实际一次上游调用一一对应，避免复用已释放的 lease。
        // 诊断日志(临时):开始/每块失败/完成都打点,便于确认外绘是否跑、每块成败(见 tileref 复盘)。
        logWarn("掩码外绘开始", {
          generationId: params.generationId,
          target: `${target.width}x${target.height}`,
        });
        try {
          const res = await maskedOutpaintImage(
            imageBuffer,
            Math.max(target.width, target.height),
            async (tileCanvas, mask, pos, w, h, i) => {
              let maskEditConfig: ApiConfig | null = null;
              try {
                const backend = params.config.backend;
                const resolvedMaskEditConfig = await getEffectiveConfig({
                  userId: params.userId,
                  apiKeyId: backend?.apiKeyId,
                  // 显式选择仍要重新执行用户授权；隐式默认组则固定首次实际计费分组，
                  // 以免管理员在分块期间切换默认组后发生跨组路由或计费漂移。
                  backendGroupId: backend?.requestedBackendGroupId,
                  pinnedImplicitGroupId:
                    backend?.requestedBackendGroupId?.trim()
                      ? undefined
                      : (backend?.billingGroupId ?? undefined),
                  requestKind: "image_edit",
                  requestedModel: DEFAULT_IMAGE_MODEL,
                  requiresMask: true,
                });
                maskEditConfig = resolvedMaskEditConfig.config;
                const edited = await editImage(maskEditConfig, {
                  // 自主拓展:按块方位给位置提示词(「根据四周已渲染内容补出该方位」),
                  // 不喂原图/参考。首块=修复种子;其余=从已提交边缘往黑区补该方位。
                  prompt: buildOutpaintPrompt(pos),
                  // images[0]=待补块（已提交邻块边缘 + 黑色待补区，mask 标黑区为重绘）；不再给参考图。
                  images: [
                    { data: tileCanvas, name: "tile.png", type: "image/png" },
                  ],
                  mask: { data: mask, name: "mask.png", type: "image/png" },
                  size: `${w}x${h}`,
                  model: DEFAULT_IMAGE_MODEL,
                  outputFormat: "png",
                });
                if (edited.error || !edited.imageBase64) {
                  throw new Error(edited.error || "该块无输出");
                }
                await params.chargeTile?.(`${w}x${h}`, i);
                return Buffer.from(edited.imageBase64, "base64");
              } catch (tileError) {
                // 每块失败原本被 maskedOutpaintImage 静默吞掉;这里显式打点便于诊断。
                logWarn("掩码外绘该块失败", {
                  generationId: params.generationId,
                  tile: i,
                  size: `${w}x${h}`,
                  error:
                    tileError instanceof Error
                      ? tileError.message
                      : String(tileError),
                });
                throw tileError;
              } finally {
                await releasePoolBackendConfigLease(maskEditConfig);
              }
            },
            superResolve
          );
          imageBuffer = res.buffer;
          blockRepaired = res.tilesRepaired > 0;
          logWarn("掩码外绘完成", {
            generationId: params.generationId,
            tilesRepaired: res.tilesRepaired,
            tilesTotal: res.tilesTotal,
            blockRepaired,
          });
        } catch (error) {
          logWarn("掩码外绘修复失败，回退原图", {
            generationId: params.generationId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } else if (target && wholeRepair) {
        const targetLongEdge = Math.max(target.width, target.height);
        try {
          const repairedResult = await generativeRepairImage(
            imageBuffer,
            targetLongEdge,
            // 整图重绘:gpt-image-2 img2img(强制 web 后端,尺寸较稳),成功后计费一次。
            async (whole, w, h) => {
              const edited = await editImage(params.config, {
                prompt: repairPrompt,
                images: [{ data: whole, name: "image.png", type: "image/png" }],
                size: `${w}x${h}`,
                model: DEFAULT_IMAGE_MODEL,
                outputFormat: "png",
                forceWebBackend: true,
              });
              if (edited.error || !edited.imageBase64) {
                throw new Error(edited.error || "生成式修复:无输出");
              }
              await params.chargeTile?.(`${w}x${h}`, 0);
              return Buffer.from(edited.imageBase64, "base64");
            },
            superResolve
          );
          imageBuffer = repairedResult.buffer;
          blockRepaired = repairedResult.repaired;
        } catch (error) {
          logWarn("生成式修复失败，回退原图", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    // 超分（自动 + 主开关 IMAGE_SUPER_RESOLUTION_ENABLED）：上游图较长边 < 目标 2/3 时用
    // 轻量 general-x4v3 放大到目标尺寸（快，见 resolution-calibration.ts）。生成式修复已管到
    // 目标分辨率时跳过（避免二次超分）。
    if (
      !blockRepaired &&
      (await getRuntimeSettingBoolean("IMAGE_SUPER_RESOLUTION_ENABLED", false))
    ) {
      const calibrated = await calibrateImageResolution(
        imageBuffer,
        params.requestedSize || DEFAULT_IMAGE_SIZE
      );
      imageBuffer = calibrated.buffer;
    }
  }
  const storedFormat = resolveStoredImageFormat(
    imageBuffer,
    params.requestedFormat
  );
  const storageKey = `${params.userId}/${nanoid(32)}.${storedFormat.extension}`;
  let actualSize = params.requestedSize || DEFAULT_IMAGE_SIZE;
  let actualSizeDetected = false;
  const actualDimensions = getImageDimensionsFromBuffer(imageBuffer);
  if (actualDimensions) {
    actualSizeDetected = true;
    actualSize = normalizeImageSize(
      actualDimensions.width,
      actualDimensions.height
    );
  }
  const storage = await getStorageProvider();
  await storage.putObject(
    storageKey,
    params.bucket,
    imageBuffer,
    storedFormat.contentType
  );
  const uploadedImageFile =
    params.output.imageFileId ||
    (
      await uploadResponsesImageFile({
        config: params.config,
        buffer: imageBuffer,
        contentType: storedFormat.contentType,
        generationId: params.generationId,
      })
    )?.fileId;

  return {
    generationId: params.generationId,
    imageUrl: await getStoredImageUrl(params.bucket, storageKey),
    imageFileId: uploadedImageFile,
    webImageMessageId: params.output.webImageMessageId,
    webImageGroupId: params.output.webImageGroupId,
    storageKey,
    fileSize: imageBuffer.length,
    size: actualSize,
    revisedPrompt:
      params.output.revisedPrompt || params.output.upstreamRevisedPrompt,
    upstreamRevisedPrompt: params.output.upstreamRevisedPrompt,
    actualSizeDetected,
    actualOutputFormat: storedFormat.format,
    actualOutputFormatDetected: storedFormat.detected,
    outputRole: params.output.outputRole,
  } satisfies StoredGeneratedImageOutput;
}

async function emitAgentOperationEvent(
  callbacks: ImageGenerationCallbacks | undefined,
  event: NonNullable<GenerateImageResult["agentEvents"]>[number]
) {
  await callbacks?.onAgentEvent?.({
    ...event,
    timestamp: event.timestamp || new Date().toISOString(),
  });
}

type UpstreamStreamTelemetry = {
  startedAt: string;
  lastEventAt?: string;
  lastEventElapsedMs?: number;
  lastEvent?: {
    kind: string;
    title: string;
    status?: string;
    detail?: string;
    toolType?: string;
  };
  eventCount: number;
  partialImageCount: number;
  finalImageCount: number;
};

function createUpstreamStreamTelemetryTracker(params: {
  startedAtMs: number;
  callbacks?: ImageGenerationCallbacks;
}) {
  const telemetry: UpstreamStreamTelemetry = {
    startedAt: new Date(params.startedAtMs).toISOString(),
    eventCount: 0,
    partialImageCount: 0,
    finalImageCount: 0,
  };

  const recordEvent = (event: AgentRunEvent) => {
    const now = Date.now();
    telemetry.eventCount += 1;
    telemetry.lastEventAt = new Date(now).toISOString();
    telemetry.lastEventElapsedMs = now - params.startedAtMs;
    telemetry.lastEvent = {
      kind: event.kind,
      title: event.title,
      status: event.status,
      detail: event.detail,
      toolType: event.toolType,
    };
  };

  const recordPartialImage = (image: PartialImageResult) => {
    telemetry.partialImageCount += 1;
    if (image.final) telemetry.finalImageCount += 1;
  };

  const callbacks: ImageGenerationCallbacks = {
    ...params.callbacks,
    onPartialImage: async (image) => {
      recordPartialImage(image);
      await params.callbacks?.onPartialImage?.(image);
    },
    onTextDelta: async (delta) => {
      await params.callbacks?.onTextDelta?.(delta);
    },
    onThinkingDelta: async (delta) => {
      await params.callbacks?.onThinkingDelta?.(delta);
    },
    onAgentDelta: async (delta) => {
      await params.callbacks?.onAgentDelta?.(delta);
    },
    onAgentEvent: async (event) => {
      recordEvent(event);
      await params.callbacks?.onAgentEvent?.(event);
    },
  };

  return {
    callbacks,
    snapshot: () => ({ ...telemetry }),
  };
}

function buildBackendExecutionMetadata(params: {
  config: ApiConfig;
  useCredits: boolean;
  billingPolicy: GenerationBillingPolicy;
}) {
  const backend = params.config.backend || { type: "platform" as const };
  return {
    backend: {
      type: backend.type,
      id: backend.id,
      groupId: backend.groupId,
      requestKind: backend.requestKind,
      accountBackend: backend.accountBackend,
      apiInterfaceMode: backend.apiInterfaceMode,
      imagesUpstreamMode: backend.imagesUpstreamMode,
      apiForceResponsesEndpoint: backend.apiForceResponsesEndpoint,
      useCredits: params.useCredits,
      baseUrl: params.config.baseUrl,
      model: params.config.model,
      apiKeyId: backend.apiKeyId,
      billingGroupId: backend.billingGroupId,
      chargeImageCredits: params.billingPolicy.chargeImageCredits,
      chargeModerationCredits: params.billingPolicy.chargeModerationCredits,
      billingMode: params.billingPolicy.mode,
    },
  };
}

async function releasePoolBackendConfigLease(config?: ApiConfig | null) {
  const backend = config?.backend;
  if (
    !backend?.inflightLease ||
    (backend.type !== "pool-api" &&
      backend.type !== "pool-account" &&
      backend.type !== "pool-adobe")
  ) {
    return;
  }
  await releaseImageBackendInflightLease({
    memberType: poolBackendMemberType(backend.type),
    memberId: backend.id,
    leaseId: backend.inflightLeaseId,
    leasePersisted: backend.inflightLeasePersisted,
  });
  backend.inflightLease = false;
}

function usesPoolAccountBackend(config: ApiConfig) {
  return config.backend?.type === "pool-account";
}

async function resolveRequestedPoolGptModel(params: {
  config: ApiConfig;
  model?: string;
  allowGpt55: boolean;
}) {
  const requested = params.model?.trim();
  if (!usesPoolAccountBackend(params.config)) return undefined;
  if (params.config.backend?.accountBackend === "web") {
    if (!requested) {
      const configured = params.config.model?.trim();
      if (configured === GPT55_CHAT_MODEL && !params.allowGpt55) {
        return undefined;
      }
      return configured || undefined;
    }
    if (requested.startsWith("gpt-image-")) {
      throw new Error("Unsupported GPT model. Use a non-image model.");
    }
    if (requested === GPT55_CHAT_MODEL && !params.allowGpt55) {
      throw new Error("GPT-5.5 chat model requires Ultra plan.");
    }
    return requested;
  }
  return await getResponsesModel(params.config, requested, {
    allowGpt55: params.allowGpt55,
  });
}

function buildModelMetadata(params: {
  imageModel: string;
  gptModel?: string;
  recordModel: string;
}) {
  return {
    models: {
      imageModel: params.imageModel,
      gptModel: params.gptModel || null,
      recordModel: params.recordModel,
    },
  };
}

export async function runImageGenerationForUser(
  input: RunImageGenerationInput,
  callbacks?: ImageGenerationCallbacks
): Promise<ImageGenerationOperationResult> {
  const generationId = input.generationId || nanoid();
  const operationCreatedAt = new Date();
  const creditOperation = createImageCreditOperation(
    generationId,
    operationCreatedAt
  );
  const size = input.size || DEFAULT_IMAGE_SIZE;
  const requiresResponsesBackend = Boolean(
    input.requiresResponsesBackend || (input.mode === "chat" && input.agentMode)
  );
  const forceWebPixelRange = await getForceWebPixelRange();
  // 统一的 Web-first 偏好(默认开启,详见 shouldForceWebBackend)。两个变量同值,
  // 分别供 gen/edit 路径(forceWebBackend)与 chat 路径(mixWebFirst)透传到 service 层;
  // chat 的 mix_web_first 已并入该决策,不再单独走像素区间判定。
  // Firefly(adobe)模型按前缀路由,永远走 adobe 后端,绝不参与 Web-first 调度;否则会被
  // 导向 web/codex 账号 → "分组无可用后端"。force_firefly 强制走 adobe 同理。故二者一律
  // 关闭 Web-first 偏好,确保 firefly 路径不被 Web-first 覆盖。
  const preferWebFirst =
    !isFireflyModel(input.model) &&
    !input.forceFirefly &&
    shouldForceWebBackend(input, size, forceWebPixelRange);
  const forceWebBackend = preferWebFirst;
  const mixWebFirst = preferWebFirst;
  const preferWebWithFallback = preferWebFirst;
  const inputImages = getInputImages(input);
  const isChatInput = input.mode === "chat";
  const bucket =
    (await getRuntimeSettingString("NEXT_PUBLIC_GENERATIONS_BUCKET_NAME")) ||
    "generations";
  const userPlan = await getUserPlan(input.userId);
  const planCapabilities = await getPlanCapabilitySnapshot(userPlan.plan);
  const queueSettings = await getPlanQueueSettings(userPlan.plan);
  const moderationBlockingEnabled =
    planCapabilities.features["moderation.blocking"];
  const promptOptimizationAllowed =
    planCapabilities.features["promptOptimization.control"];
  const explicitPromptOptimization =
    input.promptOptimization !== undefined || Boolean(input.apiPrompt);

  if (explicitPromptOptimization && !promptOptimizationAllowed) {
    return {
      error: "Prompt optimization control requires Pro plan or higher.",
      generationId,
    };
  }

  const promptOptimization = input.promptOptimization ?? true;
  const apiPrompt = promptOptimization
    ? input.apiPrompt || input.prompt
    : input.prompt;
  const moderationPrompt =
    input.mode === "chat" || !promptOptimization ? input.prompt : apiPrompt;

  if (
    input.mode === "generate" &&
    !planCapabilities.features["imageGeneration.text"]
  ) {
    return {
      error: "Text image generation is not enabled for this plan.",
      generationId,
    };
  }
  if (
    input.mode === "edit" &&
    !planCapabilities.features["imageGeneration.edit"]
  ) {
    return {
      error: "Image editing is not enabled for this plan.",
      generationId,
    };
  }
  if (input.mode === "chat" && input.backendRequestKind !== "responses") {
    const chatCapability = input.agentMode
      ? input.apiKeyId
        ? "externalApi.agent"
        : "imageGeneration.agent"
      : input.waterfallMode
        ? "imageGeneration.waterfall"
        : input.apiKeyId
          ? "externalApi.chat.completions"
          : "imageGeneration.chat";
    const chatLabel = input.agentMode
      ? input.apiKeyId
        ? "External Agent API"
        : "Agent mode"
      : input.waterfallMode
        ? "Waterfall mode"
        : input.apiKeyId
          ? "External Chat Completions API"
          : "Chat mode";
    if (!planCapabilities.features[chatCapability]) {
      return {
        error: `${chatLabel} is not enabled for this plan.`,
        generationId,
      };
    }
  }
  if (
    input.mode === "chat" &&
    input.backendRequestKind === "responses" &&
    !planCapabilities.features["externalApi.responses"]
  ) {
    return {
      error: "External Responses API is not enabled for this plan.",
      generationId,
    };
  }
  const requestedCount =
    input.mode === "generate" || input.mode === "edit" || input.mode === "chat"
      ? input.n || 1
      : 1;
  if (
    requestedCount > 1 &&
    !planCapabilities.features["imageGeneration.batch"]
  ) {
    return {
      error: "Batch image generation is not enabled for this plan.",
      generationId,
    };
  }
  if (requestedCount > planCapabilities.limits.maxBatchCount) {
    return {
      error: `Image count must be no more than ${planCapabilities.limits.maxBatchCount}.`,
      generationId,
    };
  }
  const maxChatContextChars =
    input.mode === "chat"
      ? input.maxChatContextChars || planCapabilities.limits.maxChatContextChars
      : planCapabilities.limits.maxChatContextChars;
  if (
    input.mode === "chat" &&
    getChatContextLength({
      prompt: input.prompt,
      apiPrompt,
      fileContext: input.fileContext,
      promptOptimization,
      history: input.history,
    }) > maxChatContextChars
  ) {
    return {
      error: `Chat input context must be no more than ${maxChatContextChars} characters.`,
      generationId,
    };
  }
  if (
    requiresResponsesBackend &&
    input.mode !== "chat" &&
    input.backendRequestKind !== "image_edit"
  ) {
    return {
      error: "Exact image references require image edit or Chat/Agent mode.",
      generationId,
    };
  }

  const backendRequestKind =
    input.backendRequestKind ??
    (input.mode === "generate"
      ? "image_generation"
      : input.mode === "edit"
        ? "image_edit"
        : "chat");
  // 仅以实际存在的蒙版文件作为调度条件，不能信任客户端额外声明的能力字段。
  const requiresMask = input.mode === "edit" && Boolean(input.mask);
  const moderationContext = await createGenerationModerationContext(
    input.userId
  );

  try {
    return await withImageGenerationQueue(
      {
        userId: input.userId,
        priority: queueSettings.priority,
        userConcurrency: queueSettings.userConcurrency,
      },
      async () => {
        let leasedConfig: ApiConfig | null = null;
        try {
          let effectiveConfig: Awaited<ReturnType<typeof getEffectiveConfig>>;
          try {
            try {
              effectiveConfig = await getEffectiveConfig({
                userId: input.userId,
                apiKeyId: input.apiKeyId,
                backendGroupId: input.backendGroupId,
                requestKind: backendRequestKind,
                requestedModel: getRequestedModelForBackendSelection(input),
                preferredMemberId: input.preferredBackendMemberId,
                preferredMemberType: input.preferredBackendMemberType,
                stickyPreviousResponseId: input.stickyPreviousResponseId,
                stickySessionKey: input.stickySessionKey,
                accountBackendPreference: requiresResponsesBackend
                  ? "responses"
                  : preferWebWithFallback
                    ? "web"
                    : undefined,
                accountBackendPreferenceMode: forceWebBackend
                  ? "mixed-only"
                  : undefined,
                forceFirefly: input.forceFirefly,
                requiresMask,
              });
            } catch (error) {
              if (
                !preferWebWithFallback ||
                !(error instanceof ImageBackendPoolUnavailableError)
              ) {
                throw error;
              }
              effectiveConfig = await getEffectiveConfig({
                userId: input.userId,
                apiKeyId: input.apiKeyId,
                backendGroupId: input.backendGroupId,
                requestKind: backendRequestKind,
                requestedModel: getRequestedModelForBackendSelection(input),
                preferredMemberId: input.preferredBackendMemberId,
                preferredMemberType: input.preferredBackendMemberType,
                stickyPreviousResponseId: input.stickyPreviousResponseId,
                stickySessionKey: input.stickySessionKey,
                accountBackendPreference: "responses",
                accountBackendPreferenceMode: forceWebBackend
                  ? "mixed-only"
                  : undefined,
                forceFirefly: input.forceFirefly,
                requiresMask,
              });
            }
          } catch (error) {
            return {
              error:
                error instanceof Error
                  ? error.message
                  : "当前没有可用的生图后端",
              generationId,
            };
          }

          const { config, useCredits } = effectiveConfig;
          leasedConfig = config;
          let imageModel: string;
          let gptModel: string | undefined;
          let recordModel: string;
          try {
            if (input.mode === "chat") {
              if (
                config.backend?.type === "pool-account" &&
                config.backend.accountBackend === "web"
              ) {
                gptModel = await resolveRequestedPoolGptModel({
                  config,
                  model: input.model,
                  allowGpt55: planCapabilities.features["models.gpt55"],
                });
              } else {
                gptModel = await getResponsesModel(config, input.model, {
                  allowGpt55: planCapabilities.features["models.gpt55"],
                });
              }
              const requestedImageModel = getImageModelForResolvedConfig(
                config,
                input.imageModel
              );
              if (!requestedImageModel) {
                throw new Error(
                  "Unsupported model for image generation. Use a gpt-image-* model."
                );
              }
              imageModel = requestedImageModel;
              recordModel = gptModel || imageModel;
            } else {
              const requestedImageModel = getImageModelForResolvedConfig(
                config,
                input.model
              );
              if (!requestedImageModel) {
                throw new Error(
                  "Unsupported model for image generation. Use a gpt-image-* model."
                );
              }
              imageModel = requestedImageModel;
              gptModel = await resolveRequestedPoolGptModel({
                config,
                model: input.gptModel,
                allowGpt55: planCapabilities.features["models.gpt55"],
              });
              recordModel = imageModel;
            }
          } catch (error) {
            return {
              error: error instanceof Error ? error.message : "Invalid model.",
              generationId,
            };
          }

          if (!imageModel || !recordModel) {
            return {
              error: "Invalid model.",
              generationId,
            };
          }

          const moderationEnabled =
            (await isContentModerationEnabled()) &&
            moderationBlockingEnabled &&
            config.contentSafetyEnabled !== false;
          const moderationImageCount = moderationEnabled
            ? inputImages.length
            : 0;
          // WHY: 先解析实际图像模型，再按“所选分组覆盖 → 全局模型价”合并完整
          // 价格，保证 Chat 顶层文本模型不会误选生图价格。
          const {
            basePricing: imageBasePricing,
            moderationPricing: imageModerationPricing,
          } = await getRuntimeImageCreditPricing(
            imageModel,
            config.backend?.imageCreditOverrides
          );
          const creditCost = getImageCreditCostBreakdown(size, {
            textModerationCount: moderationEnabled ? undefined : 0,
            imageModerationCount: moderationImageCount,
            basePricing: imageBasePricing,
            moderationPricing: imageModerationPricing,
            quality: input.quality as ImageQualityLevel | undefined,
            thinking: input.thinking as ImageThinkingLevel | undefined,
          });
          const creditsPerImage = creditCost.totalCredits;
          const chatRoundCredits = isChatInput
            ? input.agentMode
              ? planCapabilities.billing.agentRoundCredits
              : planCapabilities.billing.chatRoundCredits
            : 0;
          const billingPolicy = buildGenerationBillingPolicy({
            useSiteImageCredits: useCredits,
            moderationEnabled,
          });
          const initialCreditCharge = getInitialGenerationCharge({
            policy: billingPolicy,
            isChatInput,
            chatRoundCredits,
            creditCost,
          });
          const chatModerationOnlyCredits = roundUpCreditAmount(
            imageModerationPricing.textModerationCredits
          );
          const moderationFailureCredits = moderationEnabled
            ? getModerationFailureCharge({
                policy: billingPolicy,
                moderationOnlyFailureSettlement:
                  planCapabilities.features["moderation.onlyFailureSettlement"],
                isChatInput,
                chatRoundCredits,
                chatModerationOnlyCredits,
                creditCost,
                initialCreditCharge,
              })
            : 0;
          return await runQueuedImageGenerationForUser({
            input,
            callbacks,
            generationId,
            operationCreatedAt,
            creditOperation,
            size,
            inputImages,
            creditCost,
            creditsPerImage,
            isChatInput,
            initialCreditCharge,
            chatRoundCredits,
            bucket,
            moderationContext,
            moderationFailureCredits,
            promptOptimization,
            apiPrompt,
            moderationPrompt,
            imageBasePricing,
            imageModerationPricing,
            config,
            useCredits,
            billingPolicy,
            imageModel,
            gptModel,
            recordModel,
            allowGpt55: planCapabilities.features["models.gpt55"],
            moderationEnabled,
            mixWebFirst,
            forceWebBackend,
          });
        } finally {
          await releasePoolBackendConfigLease(leasedConfig);
        }
      }
    );
  } catch (error) {
    // 兜底:DB/内部异常不得把裸 SQL/内部细节回给前端（issue #35:池查询失败的
    // Drizzle "Failed query: ..." 曾原样显示在用户 toast）。脱敏 + 记日志。
    return {
      error: toClientErrorMessage(
        error,
        { source: "image-generation", generationId },
        "Image generation queue is busy. Please retry shortly."
      ),
      generationId,
    };
  }
}

async function runQueuedImageGenerationForUser({
  input,
  callbacks,
  generationId,
  operationCreatedAt,
  creditOperation,
  size,
  inputImages,
  creditCost,
  creditsPerImage,
  isChatInput,
  initialCreditCharge,
  chatRoundCredits,
  bucket,
  moderationContext,
  moderationFailureCredits,
  promptOptimization,
  apiPrompt,
  moderationPrompt,
  imageBasePricing,
  imageModerationPricing,
  config,
  useCredits,
  billingPolicy,
  imageModel,
  gptModel,
  recordModel,
  allowGpt55,
  moderationEnabled,
  mixWebFirst,
  forceWebBackend,
}: {
  input: RunImageGenerationInput;
  callbacks?: ImageGenerationCallbacks;
  generationId: string;
  operationCreatedAt: Date;
  creditOperation: CreditOperationContext;
  size: string;
  inputImages: ImageInputFile[];
  creditCost: ImageCreditCostBreakdown;
  creditsPerImage: number;
  isChatInput: boolean;
  initialCreditCharge: number;
  chatRoundCredits: number;
  bucket: string;
  moderationContext: GenerationModerationContext;
  moderationFailureCredits: number;
  promptOptimization: boolean;
  apiPrompt: string;
  moderationPrompt: string;
  imageBasePricing: ImageBaseCreditPricing;
  imageModerationPricing: ResolvedImageModerationCreditPricing;
  config: Awaited<ReturnType<typeof getEffectiveConfig>>["config"];
  useCredits: boolean;
  billingPolicy: GenerationBillingPolicy;
  imageModel: string;
  gptModel?: string;
  recordModel: string;
  allowGpt55: boolean;
  moderationEnabled: boolean;
  mixWebFirst: boolean;
  forceWebBackend: boolean;
}): Promise<ImageGenerationOperationResult> {
  const startedAt = Date.now();
  const promptOptimizationMetadata = buildPromptOptimizationMetadata({
    input,
    promptOptimization,
    apiPrompt,
  });
  const backendMetadata = buildBackendExecutionMetadata({
    config,
    useCredits,
    billingPolicy,
  });
  const billingMetadata = {
    billingGroupId: config.backend?.billingGroupId ?? null,
    chargeImageCredits: billingPolicy.chargeImageCredits,
    chargeModerationCredits: billingPolicy.chargeModerationCredits,
    billingMode: billingPolicy.mode,
  };
  const modelMetadata = buildModelMetadata({
    imageModel,
    gptModel,
    recordModel,
  });
  const inputImagesMetadata = buildInputImagesMetadata(inputImages);
  const isAgentChatInput = input.mode === "chat" && input.agentMode === true;
  const streamTelemetry = createUpstreamStreamTelemetryTracker({
    startedAtMs: startedAt,
    callbacks,
  });
  const generationCallbacks = streamTelemetry.callbacks;
  const buildStreamTelemetryMetadata = () => ({
    upstreamStream: streamTelemetry.snapshot(),
  });

  await db.insert(generation).values({
    id: generationId,
    userId: input.userId,
    usageLogVisible: true,
    prompt: input.prompt,
    model: recordModel,
    size,
    status: "pending",
    creditsConsumed: initialCreditCharge,
    storageBucket: bucket,
    createdAt: operationCreatedAt,
    metadata:
      input.mode === "edit"
        ? {
            mode: "edit",
            ...backendMetadata,
            ...modelMetadata,
            ...promptOptimizationMetadata,
            ...inputImagesMetadata,
            imageCount: input.images.length,
            hasMask: Boolean(input.mask),
            quality: input.quality || "auto",
            outputFormat: input.outputFormat || null,
            outputCompression: input.outputCompression ?? null,
            background: input.background || null,
            batchCount: input.n || 1,
            forceWebBackend,
            creditCost,
            ...billingMetadata,
            chatRoundCredits: billingPolicy.chargeImageCredits
              ? chatRoundCredits
              : 0,
            moderationBlockingEnabled: moderationEnabled,
            moderationFailureCredits,
            ...(input.apiKeyId ? { externalApiKeyId: input.apiKeyId } : {}),
          }
        : input.mode === "chat"
          ? {
              mode: input.agentMode
                ? "agent"
                : input.waterfallMode
                  ? "waterfall"
                  : "chat",
              action: "auto",
              ...backendMetadata,
              ...modelMetadata,
              ...promptOptimizationMetadata,
              ...inputImagesMetadata,
              imageCount: input.images?.length || 0,
              fileContextChars: input.fileContext?.length || 0,
              quality: input.quality || "auto",
              moderation: input.moderation || "auto",
              outputFormat: input.outputFormat || null,
              outputCompression: input.outputCompression ?? null,
              batchCount: input.n || 1,
              forceWebBackend,
              creditCost,
              ...billingMetadata,
              moderationBlockingEnabled: moderationEnabled,
              moderationFailureCredits,
              ...(input.apiKeyId ? { externalApiKeyId: input.apiKeyId } : {}),
            }
          : {
              mode: "generate",
              ...backendMetadata,
              ...modelMetadata,
              ...promptOptimizationMetadata,
              quality: input.quality || "auto",
              moderation: input.moderation || "auto",
              outputFormat: input.outputFormat || null,
              outputCompression: input.outputCompression ?? null,
              background: input.background || null,
              batchCount: input.n || 1,
              forceWebBackend,
              creditCost,
              ...billingMetadata,
              moderationBlockingEnabled: moderationEnabled,
              moderationFailureCredits,
              ...(input.apiKeyId ? { externalApiKeyId: input.apiKeyId } : {}),
            },
  });

  let chargedCredits = 0;
  const refundChargedCredits = async (
    amount: number,
    sourceRef: string,
    description: string
  ) => {
    if (!billingPolicy.chargesCredits || amount <= 0) return;
    const roundedAmount = roundCreditAmount(amount);
    await refundGenerationCredits({
      generationId,
      userId: input.userId,
      amount: roundedAmount,
      sourceRef,
      description,
      operation: creditOperation,
    });
    await refundExternalApiKeyCredits({
      apiKeyId: input.apiKeyId,
      userId: input.userId,
      amount: roundedAmount,
    });
    chargedCredits = roundCreditAmount(
      Math.max(0, chargedCredits - roundedAmount)
    );
  };
  const chargeAdditionalCredits = async (
    amount: number,
    serviceName: string,
    description: string,
    metadata?: Record<string, unknown>,
    sourceRef?: string
  ) => {
    if (!billingPolicy.chargesCredits || amount <= 0) return;
    const roundedAmount = roundCreditAmount(amount);
    await reserveExternalApiKeyCredits({
      apiKeyId: input.apiKeyId,
      userId: input.userId,
      amount: roundedAmount,
    });
    let userCreditsConsumed = false;
    try {
      await consumeCredits({
        userId: input.userId,
        amount: roundedAmount,
        serviceName,
        description,
        ...(sourceRef !== undefined ? { sourceRef } : {}),
        operation: creditOperation,
        metadata: {
          ...metadata,
          externalApiKeyId: input.apiKeyId,
        },
      });
      userCreditsConsumed = true;
    } finally {
      if (!userCreditsConsumed) {
        await refundExternalApiKeyCredits({
          apiKeyId: input.apiKeyId,
          userId: input.userId,
          amount: roundedAmount,
        });
      }
    }
    chargedCredits = roundCreditAmount(chargedCredits + roundedAmount);
  };
  const settleChargedCredits = async (
    targetCredits: number,
    serviceName: string,
    sourceRef: string,
    description: string,
    metadata?: Record<string, unknown>
  ) => {
    if (!billingPolicy.chargesCredits) return;

    const roundedTarget = roundCreditAmount(Math.max(0, targetCredits));
    const delta = roundCreditAmount(roundedTarget - chargedCredits);
    if (delta > 0) {
      // 结算补扣用独立 sourceRef，避免与初始扣费 / 退款 sourceRef 冲突而被误判重复。
      await chargeAdditionalCredits(
        delta,
        serviceName,
        description,
        {
          ...metadata,
          previousCredits: chargedCredits,
          targetCredits: roundedTarget,
        },
        `${sourceRef}:charge`
      );
      return;
    }

    if (delta < 0) {
      await refundChargedCredits(Math.abs(delta), sourceRef, description);
    }
  };

  if (initialCreditCharge > 0) {
    try {
      await chargeAdditionalCredits(
        initialCreditCharge,
        billingPolicy.chargeImageCredits
          ? isChatInput
            ? "chat-input"
            : "image-generation"
          : "content-moderation",
        billingPolicy.chargeImageCredits
          ? isChatInput
            ? `Chat input: ${input.prompt.substring(0, 50)}`
            : `Image generation: ${input.prompt.substring(0, 50)}`
          : `Content moderation: ${input.prompt.substring(0, 50)}`,
        {
          generationId,
          mode: input.mode,
          size,
          creditCost,
          billingGroupId: config.backend?.billingGroupId ?? null,
          initialCredits: initialCreditCharge,
          targetImageCredits: creditsPerImage,
          billingMode: billingPolicy.mode,
        },
        `${generationId}:charge`
      );
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Insufficient credits";
      await db
        .update(generation)
        .set({
          status: "failed",
          error: message,
          creditsConsumed: chargedCredits,
        })
        .where(isPendingGeneration(generationId));
      return { error: message, generationId };
    }
  }

  const repairAttempts: ModerationPromptRepairAttempt[] = [];
  const isTimedOut = () =>
    Date.now() - startedAt > IMAGE_GENERATION_PENDING_TIMEOUT_MS;
  const failTimedOutGeneration =
    async (): Promise<ImageGenerationOperationResult> => {
      const targetCredits = getFailedGenerationTargetCredits({
        reason: "generation_error",
        moderationFailureCredits,
        moderationOnlyCredits: creditCost.moderationOnlyCredits,
      });
      const creditsToRefund = Math.max(0, chargedCredits - targetCredits);
      const refundSourceRef = `${generationId}:timeout-refund`;

      const [updated] = await db
        .update(generation)
        .set({
          status: "failed",
          error: resolveImageGenerationTimeoutError(config.backend),
          creditsConsumed: chargedCredits,
          completedAt: new Date(),
          metadata: sql`COALESCE(${generation.metadata}, '{}'::json)::jsonb || ${JSON.stringify(
            withPromptRepairMetadata(
              {
                ...buildStreamTelemetryMetadata(),
                timeout: {
                  reason: "runtime_timeout",
                  timeoutMs: IMAGE_GENERATION_PENDING_TIMEOUT_MS,
                  elapsedMs: Date.now() - startedAt,
                  targetCredits,
                  refundCredits: creditsToRefund,
                  refundSourceRef,
                },
              },
              repairAttempts
            )
          )}::jsonb`,
        })
        .where(isPendingGeneration(generationId))
        .returning({ id: generation.id });

      if (updated && creditsToRefund > 0) {
        try {
          await refundChargedCredits(
            creditsToRefund,
            refundSourceRef,
            `Refund timed out image generation charge: ${input.prompt.slice(
              0,
              50
            )}`
          );
          await db
            .update(generation)
            .set({
              creditsConsumed: chargedCredits,
              metadata: sql`COALESCE(${generation.metadata}, '{}'::json)::jsonb || ${JSON.stringify(
                {
                  timeoutRefund: {
                    sourceRef: refundSourceRef,
                    creditsRefunded: creditsToRefund,
                    settledAt: new Date().toISOString(),
                  },
                }
              )}::jsonb`,
            })
            .where(eq(generation.id, generationId));
        } catch {
          /* best effort settlement */
        }
      }

      return {
        error: resolveImageGenerationTimeoutError(config.backend),
        generationId,
        creditsConsumed: chargedCredits,
      };
    };

  // 审核改写重试开关:请求显式传 moderationPromptRepair=false 时,该次生成不做"审核拦截→自动改写
  // 提示词→重试",失败直接返回真实错误(见 issue #24:用户希望可关闭、避免反复重试耗时、看到真实原因)。
  // 未显式指定则沿用全局 IMAGE_MODERATION_PROMPT_REPAIR_ENABLED。
  const repairEnabled =
    input.moderationPromptRepair === false
      ? false
      : await getRuntimeSettingBoolean(
          "IMAGE_MODERATION_PROMPT_REPAIR_ENABLED",
          true
        );
  const configuredRepairRetries = await getRuntimeSettingNumber(
    "IMAGE_MODERATION_PROMPT_REPAIR_MAX_RETRIES",
    1,
    { nonNegative: true }
  );
  const maxRepairRetries = repairEnabled
    ? Math.min(
        MAX_MODERATION_PROMPT_REPAIR_RETRIES,
        Math.floor(configuredRepairRetries)
      )
    : 0;
  let currentPrompt = input.prompt;
  let currentApiPrompt = apiPrompt;
  let currentModerationPrompt = moderationPrompt;
  let result: GenerateImageResult;

  const repairPrompt = async (
    phase: ModerationPromptRepairAttempt["phase"],
    reason: string
  ) => {
    if (repairAttempts.length >= maxRepairRetries) return false;
    const attemptNumber = repairAttempts.length + 1;
    const attempt: ModerationPromptRepairAttempt = {
      attempt: attemptNumber,
      phase,
      status: "attempted",
      reason: truncateMetadataText(reason),
      originalPrompt: truncateMetadataText(currentPrompt),
      createdAt: new Date().toISOString(),
    };
    repairAttempts.push(attempt);

    let repairConfig: Awaited<ReturnType<typeof getEffectiveConfig>> | null =
      null;
    try {
      repairConfig = await getEffectiveConfig({
        userId: input.userId,
        apiKeyId: input.apiKeyId,
        requestKind: "responses",
        accountBackendPreference: "responses",
        allowAnyResponsesBackend: true,
      });
      const repaired = await repairModerationBlockedPromptWithResponses(
        repairConfig.config,
        {
          prompt: currentApiPrompt || currentPrompt,
          failureReason: reason,
          mode: input.mode,
          size,
          signal: AbortSignal.timeout(IMAGE_GENERATION_PENDING_TIMEOUT_MS),
        }
      );
      if (repaired.error || !repaired.prompt?.trim()) {
        attempt.status = "failed";
        attempt.error = truncateMetadataText(
          repaired.error || "Responses prompt repair returned empty text"
        );
        return false;
      }
      currentPrompt = repaired.prompt.trim();
      currentApiPrompt = currentPrompt;
      currentModerationPrompt = currentPrompt;
      attempt.status = "retrying";
      attempt.repairedPrompt = truncateMetadataText(currentPrompt);
      return true;
    } catch (error) {
      attempt.status = "failed";
      attempt.error = truncateMetadataText(
        error instanceof Error ? error.message : "Prompt repair failed"
      );
      return false;
    } finally {
      await releasePoolBackendConfigLease(repairConfig?.config);
      await db
        .update(generation)
        .set({
          metadata: sql`COALESCE(${generation.metadata}, '{}'::json)::jsonb || ${JSON.stringify(
            buildModerationPromptRepairMetadata(repairAttempts)
          )}::jsonb`,
        })
        .where(isPendingGeneration(generationId));
    }
  };

  const attemptGeneration = async (background: typeof input.background) => {
    const commonSignal = AbortSignal.timeout(
      IMAGE_GENERATION_PENDING_TIMEOUT_MS
    );
    return input.mode === "edit"
      ? await editImage(
          config,
          {
            prompt: currentPrompt,
            apiPrompt: currentApiPrompt,
            promptOptimization,
            signal: commonSignal,
            images: input.images,
            mask: input.mask,
            size: input.size,
            model: imageModel,
            gptModel,
            thinking: input.thinking,
            quality: input.quality,
            n: input.n,
            moderation: input.moderation,
            outputFormat: input.outputFormat,
            outputCompression: input.outputCompression,
            background,
            mixWebFirst,
            forceWebBackend,
            requiresResponsesBackend: input.requiresResponsesBackend,
          },
          generationCallbacks
        )
      : input.mode === "chat"
        ? await generateChatImage(
            config,
            {
              prompt: currentPrompt,
              apiPrompt: currentApiPrompt,
              fileContext: input.fileContext,
              files: input.files,
              promptOptimization,
              signal: commonSignal,
              images: input.images,
              history: input.history,
              size,
              model: gptModel,
              imageModel,
              allowGpt55,
              quality: input.quality,
              n: input.n,
              moderation: input.moderation,
              outputFormat: input.outputFormat,
              outputCompression: input.outputCompression,
              stream: input.stream,
              thinking: input.thinking,
              agentMode: input.agentMode,
              agentMaxRounds: input.agentMaxRounds,
              agentForceMaxRounds: input.agentForceMaxRounds,
              layeredGeneration: input.layeredGeneration,
              rawResponsesBody: input.rawResponsesBody,
              mixWebFirst,
              requiresResponsesBackend: input.requiresResponsesBackend,
              webChat: input.webChat,
            },
            generationCallbacks
          )
        : await generateImage(
            config,
            {
              prompt: currentPrompt,
              apiPrompt: currentApiPrompt,
              promptOptimization,
              signal: commonSignal,
              size,
              model: imageModel,
              gptModel,
              thinking: input.thinking,
              n: input.n,
              quality: input.quality,
              moderation: input.moderation,
              outputFormat: input.outputFormat,
              outputCompression: input.outputCompression,
              background,
              mixWebFirst,
              forceWebBackend,
              requiresResponsesBackend: input.requiresResponsesBackend,
            },
            generationCallbacks
          );
  };

  // 透明背景抠图回退(显式开关,issue #27):仅当请求显式 transparentMatte=true 且 background=transparent
  // 时,后端不支持透明(400)则在同一 generationId 内不透明重生成 + 服务端 ISNet 抠图得到透明结果
  // (不额外扣费)。覆盖文生图/图生图/chat/瀑布流;agent(chat+agentMode)除外。未开启则透明直接透传,
  // 不支持时返回真实错误(不再自动回退)。
  const transparentMatteEnabled =
    input.background === "transparent" &&
    input.transparentMatte === true &&
    !(input.mode === "chat" && input.agentMode === true);
  // 不透明重生成 + 服务端 ISNet 抠图。opaque 自身失败则原样返回其错误,不去 matte。
  const fallbackToOpaqueMatte = async () => {
    const opaque = await attemptGeneration(undefined);
    if (opaque.error) {
      return opaque;
    }
    return applyTransparentMatte(opaque);
  };
  const runGenerationAttempt = async () => {
    if (!transparentMatteEnabled) {
      return attemptGeneration(input.background);
    }
    // 后端不支持透明有两条出口:generateImage/editImage 吞错后以 result.error 返回(主路径),
    // 少数路径会 throw。两条都要触发回退,否则用户仍只看到 400。
    try {
      const first = await attemptGeneration(input.background);
      if (first.error && isTransparentUnsupportedError(first.error)) {
        return fallbackToOpaqueMatte();
      }
      return first;
    } catch (error) {
      if (!isTransparentUnsupportedError(error)) {
        throw error;
      }
      return fallbackToOpaqueMatte();
    }
  };

  while (true) {
    const moderation = !moderationEnabled
      ? ({ decision: "skipped" } as const)
      : await moderationContext.moderate({
          prompt: currentModerationPrompt,
          images: inputImages,
          mode: inputImages.length > 0 ? "image" : "text",
          userId: input.userId,
          generationId,
        });

    if (isTimedOut()) {
      return failTimedOutGeneration();
    }

    if (moderation.decision === "block" || moderation.decision === "error") {
      const message =
        moderation.decision === "block"
          ? "Content failed moderation"
          : "Content moderation is temporarily unavailable";
      const responseMessage = moderation.reason || message;
      if (
        moderation.decision === "block" &&
        (await repairPrompt("pre_moderation", responseMessage))
      ) {
        continue;
      }
      const retryingRepairAttempt =
        getLastRetryingRepairAttempt(repairAttempts);
      if (retryingRepairAttempt) {
        retryingRepairAttempt.status = "failed";
        retryingRepairAttempt.error = truncateMetadataText(responseMessage);
      }

      const targetCredits = getFailedGenerationTargetCredits({
        reason:
          moderation.decision === "block"
            ? "moderation_block"
            : "moderation_error",
        moderationFailureCredits,
        moderationOnlyCredits: creditCost.moderationOnlyCredits,
      });
      try {
        await settleChargedCredits(
          targetCredits,
          "content-moderation",
          `${generationId}:moderation`,
          `Settle after moderation stop: ${input.prompt.substring(0, 50)}`,
          {
            generationId,
            moderationDecision: moderation.decision,
            creditCost,
          }
        );
      } catch {
        /* best effort settlement */
      }
      await db
        .update(generation)
        .set({
          status: "failed",
          error: responseMessage,
          creditsConsumed: chargedCredits,
          metadata: sql`COALESCE(${generation.metadata}, '{}'::json)::jsonb || ${JSON.stringify(
            repairAttempts.length
              ? buildModerationPromptRepairMetadata(repairAttempts)
              : {}
          )}::jsonb`,
        })
        .where(isPendingGeneration(generationId));
      return {
        error: responseMessage,
        generationId,
        creditsConsumed: chargedCredits,
      };
    }

    try {
      result = await runGenerationAttempt();
    } catch (error) {
      // 同上:生成尝试阶段的 DB/内部异常也脱敏,避免裸 SQL 漏到前端。
      const message = toClientErrorMessage(
        error,
        { source: "image-generation-attempt", generationId },
        "Image generation failed"
      );
      const retryingRepairAttempt =
        getLastRetryingRepairAttempt(repairAttempts);
      if (retryingRepairAttempt) {
        retryingRepairAttempt.status = "failed";
        retryingRepairAttempt.error = truncateMetadataText(message);
      }
      const targetCredits = getFailedGenerationTargetCredits({
        reason: "generation_error",
        moderationFailureCredits,
        moderationOnlyCredits: creditCost.moderationOnlyCredits,
      });
      try {
        await settleChargedCredits(
          targetCredits,
          "content-moderation",
          `${generationId}:generation-exception`,
          `Settle failed generation exception: ${input.prompt.substring(0, 50)}`,
          {
            generationId,
            creditCost,
            error: message,
          }
        );
      } catch {
        /* best effort settlement */
      }
      await db
        .update(generation)
        .set({
          status: "failed",
          error: message,
          creditsConsumed: chargedCredits,
          metadata: sql`COALESCE(${generation.metadata}, '{}'::json)::jsonb || ${JSON.stringify(
            repairAttempts.length
              ? buildModerationPromptRepairMetadata(repairAttempts)
              : {}
          )}::jsonb`,
        })
        .where(isPendingGeneration(generationId));
      return {
        error: message,
        generationId,
        creditsConsumed: chargedCredits,
      };
    }

    if (isTimedOut()) {
      return failTimedOutGeneration();
    }

    const repairFailureMessage = getModerationRepairFailureMessage(
      result,
      isChatInput
    );
    if (
      repairFailureMessage &&
      (await repairPrompt(
        result.error ? "upstream_generation" : "missing_image_output",
        repairFailureMessage
      ))
    ) {
      continue;
    }

    break;
  }

  const successfulRepairAttempt = getLastRetryingRepairAttempt(repairAttempts);
  if (successfulRepairAttempt) {
    const finalRepairFailure = getModerationRepairFailureMessage(
      result,
      isChatInput
    );
    if (
      !result.error &&
      !finalRepairFailure &&
      (hasImageOutput(result) || isChatInput)
    ) {
      successfulRepairAttempt.status = "succeeded";
    } else {
      successfulRepairAttempt.status = "failed";
      successfulRepairAttempt.error = truncateMetadataText(
        result.error ||
          finalRepairFailure ||
          "Retry completed without an image output"
      );
    }
  }
  const metadataWithPromptRepair = (metadata: Record<string, unknown>) =>
    withPromptRepairMetadata(
      {
        ...buildStreamTelemetryMetadata(),
        ...metadata,
      },
      repairAttempts
    );

  if (result.error) {
    const failureTargetCredits = getFailedGenerationTargetCredits({
      reason: "generation_error",
      moderationFailureCredits,
      moderationOnlyCredits: creditCost.moderationOnlyCredits,
    });
    try {
      await settleChargedCredits(
        failureTargetCredits,
        "content-moderation",
        `${generationId}:generation-error`,
        `Settle failed generation: ${input.prompt.substring(0, 50)}`,
        {
          generationId,
          creditCost,
          fullRefund: failureTargetCredits === 0,
          error: result.error,
        }
      );
    } catch {
      /* best effort settlement */
    }
    await db
      .update(generation)
      .set({
        status: "failed",
        error: result.error,
        creditsConsumed: chargedCredits,
        metadata: sql`COALESCE(${generation.metadata}, '{}'::json)::jsonb || ${JSON.stringify(
          metadataWithPromptRepair({})
        )}::jsonb`,
      })
      .where(isPendingGeneration(generationId));
    return {
      error: result.error,
      generationId,
      creditsConsumed: chargedCredits,
    };
  }

  if (!hasImageOutput(result)) {
    if (!isChatInput) {
      const message =
        result.responseText?.trim() ||
        result.responseAgent?.trim() ||
        "Image generation completed without an image output";
      const failureTargetCredits = getFailedGenerationTargetCredits({
        reason: "generation_error",
        moderationFailureCredits,
        moderationOnlyCredits: creditCost.moderationOnlyCredits,
      });
      try {
        await settleChargedCredits(
          failureTargetCredits,
          "content-moderation",
          `${generationId}:missing-image-output`,
          `Settle missing image output: ${input.prompt.substring(0, 50)}`,
          {
            generationId,
            creditCost,
            fullRefund: failureTargetCredits === 0,
            error: message,
          }
        );
      } catch {
        /* best effort settlement */
      }
      await db
        .update(generation)
        .set({
          status: "failed",
          error: message,
          creditsConsumed: chargedCredits,
          metadata: sql`COALESCE(${generation.metadata}, '{}'::json)::jsonb || ${JSON.stringify(
            metadataWithPromptRepair({
              ...buildResponseOutputMetadata(result),
              missingImageOutput: true,
            })
          )}::jsonb`,
          completedAt: new Date(),
        })
        .where(isPendingGeneration(generationId));
      return {
        error: message,
        generationId,
        creditsConsumed: chargedCredits,
      };
    }

    let finalChargedCredits = chargedCredits;
    const textChatRoundCount = isChatInput ? getChatRoundCount(result) : 0;
    const targetChatTextCredits = getTextChatSuccessTargetCredits({
      policy: billingPolicy,
      chatRoundCredits,
      chatRoundCount: textChatRoundCount,
      creditCost,
    });
    if (isChatInput) {
      try {
        await settleChargedCredits(
          targetChatTextCredits,
          "chat-text-only",
          `${generationId}:chat-text-only`,
          `Settle chat text response: ${input.prompt.substring(0, 50)}`,
          {
            generationId,
            creditCost,
            chatRoundCredits,
            chatRoundCount: textChatRoundCount,
          }
        );
        finalChargedCredits = chargedCredits;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Insufficient credits";
        await db
          .update(generation)
          .set({
            status: "failed",
            error: message,
            creditsConsumed: chargedCredits,
          })
          .where(isPendingGeneration(generationId));
        return {
          error: "Insufficient credits",
          generationId,
          creditsConsumed: chargedCredits,
        };
      }
    }

    await completeImageGenerationWithUsage({
      generationId,
      output: { kind: "none", reason: "chatTextOnly" },
      update: {
        revisedPrompt: result.revisedPrompt,
        creditsConsumed: finalChargedCredits,
        metadata: sql`COALESCE(${generation.metadata}, '{}'::json)::jsonb || ${JSON.stringify(
          metadataWithPromptRepair({
            ...buildRevisedPromptMetadata({
              input,
              apiPrompt: currentApiPrompt,
              result,
            }),
            ...buildResponseOutputMetadata(result),
            ...(isChatInput
              ? {
                  chatTextOnlyCharge: {
                    credits: targetChatTextCredits,
                    chatRoundCredits: billingPolicy.chargeImageCredits
                      ? chatRoundCredits
                      : 0,
                    chatRoundCount: textChatRoundCount,
                    billingMode: billingPolicy.mode,
                  },
                }
              : {}),
          })
        )}::jsonb`,
        completedAt: new Date(),
      },
    });

    return {
      generationId,
      imageOutputs: result.imageOutputs,
      model: recordModel,
      size,
      revisedPrompt: result.revisedPrompt,
      promptRepairNotice: getPromptRepairNotice(repairAttempts),
      responseText: result.responseText,
      responseThinking: result.responseThinking,
      responseAgent: result.responseAgent,
      agentEvents: result.agentEvents,
      agentRoundCount: result.agentRoundCount,
      webConversation: result.webConversation,
      backendMember: result.backendMember,
      responsesPreviousResponse: result.responsesPreviousResponse,
      creditsConsumed: finalChargedCredits,
    };
  }

  let storedOutputs: StoredGeneratedImageOutput[] = [];
  try {
    const imageOutputs = getResultImageOutputs(result).map(
      (output, index, items) => ({
        ...output,
        outputRole: resolveOutputRole({
          input,
          outputRole: output.outputRole,
          index,
          total: items.length,
        }),
      })
    ) satisfies NonNullable<GenerateImageResult["imageOutputs"]>;
    if (imageOutputs.length === 0) {
      throw new Error("Missing image data");
    }
    if (isAgentChatInput) {
      await emitAgentOperationEvent(callbacks, {
        kind: "tool",
        status: "running",
        title: "保存生成图片",
        detail: `正在保存 ${imageOutputs.length} 张图片并生成站内访问地址`,
        toolType: "image_storage",
      });
    }
    storedOutputs = [];
    for (const [index, output] of imageOutputs.entries()) {
      const outputGenerationId = resolveOutputGenerationId(
        generationId,
        index,
        imageOutputs.length
      );
      storedOutputs.push(
        await storeGeneratedImageOutput({
          output,
          config,
          userId: input.userId,
          generationId: outputGenerationId,
          bucket,
          requestedSize: size,
          requestedFormat: input.outputFormat,
          hdRepair: input.hdRepair,
          blockRepair: input.blockRepair,
          repairPrompt: input.repairPrompt,
          // 生成式修复计费:重绘一次按尺寸扣一次,幂等 sourceRef 防重试重复扣。
          chargeTile: async (tileSize, tileIndex) => {
            const tileCost = getImageCreditCostBreakdown(tileSize, {
              textModerationCount: 0,
              imageModerationCount: 0,
              basePricing: imageBasePricing,
              moderationPricing: imageModerationPricing,
              quality: input.quality as ImageQualityLevel | undefined,
              thinking: input.thinking as ImageThinkingLevel | undefined,
            }).totalCredits;
            await chargeAdditionalCredits(
              tileCost,
              "image-generation",
              `生成式修复 (${tileSize})`,
              { blockRepair: true, tileSize, index: tileIndex },
              `${outputGenerationId}:blockrepair-${tileIndex}`
            );
          },
        })
      );
      if (isAgentChatInput) {
        await emitAgentOperationEvent(callbacks, {
          kind: "tool",
          status: index === imageOutputs.length - 1 ? "completed" : "running",
          title:
            index === imageOutputs.length - 1 ? "图片保存完成" : "保存生成图片",
          detail: `已保存 ${index + 1}/${imageOutputs.length} 张图片`,
          toolType: "image_storage",
        });
      }
    }
  } catch (storageError: unknown) {
    const message =
      storageError instanceof Error
        ? storageError.message
        : "Unknown storage error";
    // 先结算积分，再写库。settleChargedCredits 可能修改 chargedCredits，
    // 必须在 UPDATE 之前完成，这样 creditsConsumed 才能拿到结算后的值。
    try {
      await settleChargedCredits(
        getFailedGenerationTargetCredits({
          reason: "storage_error",
          moderationFailureCredits,
          moderationOnlyCredits: creditCost.moderationOnlyCredits,
        }),
        "content-moderation",
        `${generationId}:storage-error`,
        `Settle storage failure: ${input.prompt.substring(0, 50)}`,
        {
          generationId,
          creditCost,
        }
      );
    } catch {
      /* best effort settlement */
    }
    // 必须在单次 UPDATE 中同时写入 status、error、metadata 和
    // creditsConsumed：isPendingGeneration 要求 status='pending'，
    // 若先把 status 改为 'failed'，后续以同一 WHERE 条件写
    // creditsConsumed 的 UPDATE 将匹配不到任何行，导致积分消耗
    // 永远不会落库。
    await db
      .update(generation)
      .set({
        status: "failed",
        error: `Storage error: ${message}`,
        metadata: sql`COALESCE(${generation.metadata}, '{}'::json)::jsonb || ${JSON.stringify(
          metadataWithPromptRepair({})
        )}::jsonb`,
        creditsConsumed: chargedCredits,
      })
      .where(isPendingGeneration(generationId));
    return {
      error: "Failed to save image",
      generationId,
      creditsConsumed: chargedCredits,
    };
  }

  // 分层生成("生成即分层"):agent 产出顺序为 [整图合成, 背景, 元素...]。
  // 按生成顺序标注角色,供后续 PSD 组装识别(背景层不透明铺满、元素层需抠白底转透明)。
  // 仅 chat+agent+layered 且至少有"整图+背景"两张时记录。
  const isLayeredRun =
    input.mode === "chat" &&
    Boolean(input.agentMode) &&
    Boolean(input.layeredGeneration) &&
    storedOutputs.length >= 2;

  const selectedWebChoiceId = result.webConversation?.selectedImageMessageId;
  const selectedOutputIndex =
    selectedWebChoiceId && storedOutputs.length > 1
      ? storedOutputs.findIndex(
          (output) => output.webImageMessageId === selectedWebChoiceId
        )
      : -1;
  // 分层生成的主图应为整图合成(第 0 张),而非最后一张元素;否则画廊缩略图/下载会变成单个元素。
  const primaryOutput =
    storedOutputs[
      selectedOutputIndex >= 0
        ? selectedOutputIndex
        : isLayeredRun
          ? 0
          : storedOutputs.length - 1
    ]!;
  const upstreamImageOutputCount = Math.max(
    Math.floor(result.imageOutputCount || 0),
    storedOutputs.length
  );
  const hasChoiceOutputs = storedOutputs.some(
    (output) => output.outputRole === "choice"
  );
  // 分层生成:每一轮的图(整图 + 背景 + 各元素)都是可交付的 PSD 图层,逐张计费(而非只计成品)。
  const billableOutputs = hasChoiceOutputs
    ? [primaryOutput]
    : isLayeredRun
      ? storedOutputs
      : storedOutputs.filter((output) => output.outputRole !== "agent_draft");
  const billableImageOutputCount = billableOutputs.length;
  const perOutputCreditCosts = storedOutputs.map((output) =>
    // 分层运行:每张图都计费(不把层当作免费 agent_draft 草稿)。
    (!isLayeredRun && output.outputRole === "agent_draft") ||
    (hasChoiceOutputs && output.generationId !== primaryOutput.generationId)
      ? {
          baseCredits: 0,
          effectiveBaseCredits: 0,
          totalCredits: 0,
          imageModerationCount: 0,
          moderationCny: 0,
          moderationCredits: 0,
          moderationOnlyCredits: 0,
          qualityMultiplier: 1,
          textModerationCredits: 0,
          textModerationCount: 0,
          thinkingMultiplier: 1,
          pixels: 0,
        }
      : getImageCreditCostBreakdown(output.size, {
          textModerationCount: moderationEnabled ? undefined : 0,
          imageModerationCount: moderationEnabled ? inputImages.length : 0,
          basePricing: imageBasePricing,
          moderationPricing: imageModerationPricing,
          quality: input.quality as ImageQualityLevel | undefined,
          thinking: input.thinking as ImageThinkingLevel | undefined,
        })
  );
  const billableOutputCreditCosts = billableOutputs.map((output) =>
    getImageCreditCostBreakdown(output.size, {
      textModerationCount: moderationEnabled ? undefined : 0,
      imageModerationCount: moderationEnabled ? inputImages.length : 0,
      basePricing: imageBasePricing,
      moderationPricing: imageModerationPricing,
      quality: input.quality as ImageQualityLevel | undefined,
      thinking: input.thinking as ImageThinkingLevel | undefined,
    })
  );
  const actualCreditCost =
    billableOutputCreditCosts[billableOutputCreditCosts.length - 1] ||
    getImageCreditCostBreakdown(primaryOutput.size, {
      textModerationCount: moderationEnabled ? undefined : 0,
      imageModerationCount: moderationEnabled ? inputImages.length : 0,
      basePricing: imageBasePricing,
      moderationPricing: imageModerationPricing,
      quality: input.quality as ImageQualityLevel | undefined,
      thinking: input.thinking as ImageThinkingLevel | undefined,
    });
  const actualImageCredits = perOutputCreditCosts.reduce(
    (total, item) => roundCreditAmount(total + item.totalCredits),
    0
  );
  const chatRoundCount = isChatInput ? getChatRoundCount(result) : 0;
  const targetSuccessCredits = getImageSuccessTargetCredits({
    policy: billingPolicy,
    isChatInput,
    chatRoundCredits,
    chatRoundCount,
    actualImageCredits,
    creditCost,
  });
  try {
    if (isAgentChatInput) {
      await emitAgentOperationEvent(callbacks, {
        kind: "tool",
        status: "running",
        title: "结算本次生成",
        detail: `正在按 ${billableImageOutputCount} 张成品图结算积分`,
        toolType: "billing",
      });
    }
    await settleChargedCredits(
      targetSuccessCredits,
      "image-generation",
      `${generationId}:image-actual-size`,
      `Settle image generation: ${input.prompt.substring(0, 50)}`,
      {
        generationId,
        mode: input.mode,
        requestedSize: size,
        actualSize: primaryOutput.size,
        requestedResolution: resolveImageResolutionSettlement(size),
        settledResolution: resolveImageResolutionSettlement(primaryOutput.size),
        requestedCreditCost: creditCost,
        actualCreditCost,
        perOutputCreditCosts,
        chatRoundCredits:
          isChatInput && billingPolicy.chargeImageCredits
            ? chatRoundCredits
            : 0,
        chatRoundCount,
        billableImageOutputCount,
        upstreamImageOutputCount,
        billingMode: billingPolicy.mode,
      }
    );
    if (isAgentChatInput) {
      await emitAgentOperationEvent(callbacks, {
        kind: "tool",
        status: "completed",
        title: "结算完成",
        detail: `本次实际消耗 ${targetSuccessCredits} 积分`,
        toolType: "billing",
      });
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Insufficient credits";
    try {
      await settleChargedCredits(
        getFailedGenerationTargetCredits({
          reason: "settlement_error",
          moderationFailureCredits,
          moderationOnlyCredits: creditCost.moderationOnlyCredits,
        }),
        "content-moderation",
        `${generationId}:settlement-error`,
        `Settle image generation settlement failure: ${input.prompt.substring(
          0,
          50
        )}`,
        {
          generationId,
          creditCost,
          error: message,
        }
      );
    } catch {
      /* best effort settlement */
    }
    await db
      .update(generation)
      .set({
        status: "failed",
        error: message,
        creditsConsumed: chargedCredits,
        metadata: sql`COALESCE(${generation.metadata}, '{}'::json)::jsonb || ${JSON.stringify(
          metadataWithPromptRepair({})
        )}::jsonb`,
      })
      .where(isPendingGeneration(generationId));
    return {
      error: "Insufficient credits",
      generationId,
      creditsConsumed: chargedCredits,
    };
  }

  if (isTimedOut()) {
    return failTimedOutGeneration();
  }

  const resolvedOutputCount = resolveImageOutputCount({
    status: "completed",
    storageKey: primaryOutput.storageKey,
    metadata: {
      outputImage: { billableImageOutputCount },
    },
  });
  if (resolvedOutputCount.status === "insufficientEvidence") {
    throw new Error("持久化图片完成后缺少可验证的产物证据");
  }
  await completeImageGenerationWithUsage({
    generationId,
    output:
      resolvedOutputCount.status === "counted"
        ? { kind: "image", imageCount: resolvedOutputCount.count }
        : { kind: "none", reason: "noBillableImageOutput" },
    update: {
      storageKey: primaryOutput.storageKey,
      fileSize: primaryOutput.fileSize,
      size: primaryOutput.size,
      revisedPrompt: result.revisedPrompt || primaryOutput.revisedPrompt,
      creditsConsumed: chargedCredits,
      metadata: sql`COALESCE(${generation.metadata}, '{}'::json)::jsonb || ${JSON.stringify(
        metadataWithPromptRepair({
          ...buildRevisedPromptMetadata({
            input,
            apiPrompt: currentApiPrompt,
            result,
          }),
          ...buildResponseOutputMetadata(result),
          webConversation: result.webConversation || null,
          outputImage: {
            requestedSize: size,
            actualSize: primaryOutput.size,
            requestedResolution: resolveImageResolutionSettlement(size),
            settledResolution: resolveImageResolutionSettlement(
              primaryOutput.size
            ),
            actualSizeDetected: primaryOutput.actualSizeDetected,
            actualSizeMatchesRequested: primaryOutput.size === size,
            requestedFormat: input.outputFormat || null,
            requestedCompression: input.outputCompression ?? null,
            actualFormat: primaryOutput.actualOutputFormat,
            actualFormatDetected: primaryOutput.actualOutputFormatDetected,
            requestedCreditCost: creditCost,
            actualCreditCost,
            perOutputCreditCosts,
            chatRoundCredits: isChatInput ? chatRoundCredits : 0,
            chatRoundCount,
            billableImageOutputCount,
            upstreamImageOutputCount,
            imageOutputs: storedOutputs.map((output, index) => ({
              generationId: output.generationId,
              imageUrl: output.imageUrl,
              imageFileId: output.imageFileId,
              webImageMessageId: output.webImageMessageId,
              webImageGroupId: output.webImageGroupId,
              storageKey: output.storageKey,
              size: output.size,
              revisedPrompt: output.revisedPrompt,
              upstreamRevisedPrompt: output.upstreamRevisedPrompt,
              actualFormat: output.actualOutputFormat,
              actualFormatDetected: output.actualOutputFormatDetected,
              actualSizeDetected: output.actualSizeDetected,
              role: resolveOutputRole({
                input,
                outputRole: output.outputRole,
                index,
                total: storedOutputs.length,
              }),
              primary: output.generationId === primaryOutput.generationId,
            })),
            layered: isLayeredRun
              ? {
                  version: 1,
                  layers: storedOutputs.map((output, index) => ({
                    storageKey: output.storageKey,
                    size: output.size,
                    // 0=整图合成(预览),1=背景(不透明),>=2=前景元素(抠白底)
                    role:
                      index === 0
                        ? "composite"
                        : index === 1
                          ? "background"
                          : "element",
                    order: index,
                  })),
                }
              : undefined,
          },
        })
      )}::jsonb`,
      completedAt: new Date(),
    },
  });

  return {
    generationId,
    imageUrl: primaryOutput.imageUrl,
    imageBase64: primaryOutput.imageBase64,
    imageFileId: primaryOutput.imageFileId,
    imageOutputs: storedOutputs.map((output, index) => ({
      generationId: output.generationId,
      imageUrl: output.imageUrl,
      imageBase64: output.imageBase64,
      imageFileId: output.imageFileId,
      webImageMessageId: output.webImageMessageId,
      webImageGroupId: output.webImageGroupId,
      size: output.size,
      revisedPrompt: output.revisedPrompt,
      upstreamRevisedPrompt: output.upstreamRevisedPrompt,
      promptRepairNotice: getPromptRepairNotice(repairAttempts),
      index,
      outputRole: resolveOutputRole({
        input,
        outputRole: output.outputRole,
        index,
        total: storedOutputs.length,
      }),
    })),
    model: recordModel,
    size: primaryOutput.size,
    revisedPrompt: result.revisedPrompt || primaryOutput.revisedPrompt,
    promptRepairNotice: getPromptRepairNotice(repairAttempts),
    responseText: result.responseText,
    responseThinking: result.responseThinking,
    responseAgent: result.responseAgent,
    agentEvents: result.agentEvents,
    agentRoundCount: result.agentRoundCount,
    layered: isLayeredRun,
    webConversation: result.webConversation,
    backendMember: result.backendMember,
    responsesPreviousResponse: result.responsesPreviousResponse,
    creditsConsumed: chargedCredits,
  };
}
