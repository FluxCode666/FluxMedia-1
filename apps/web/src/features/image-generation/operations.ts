/**
 * 图片生成统一管线与计费结算编排。
 *
 * 所有 generate、edit、审核和修复贡献均复用父 generation 的
 * 计费操作上下文；sourceRef 仅承担每笔账本写入幂等，不参与操作身份推断。
 */

import { db } from "@repo/database";
import { generation } from "@repo/database/schema";
import { resolveImageOutputCount } from "@repo/shared/analytics/output-count";
import { consumeCredits } from "@repo/shared/credits/core";
import type { CreditOperationContext } from "@repo/shared/credits/usage-read-model";
import {
  IMAGE_GENERATION_PENDING_TIMEOUT_MS,
  refundGenerationCredits,
} from "@repo/shared/generation-maintenance";
import { IMAGE_GENERATION_TIMEOUT_ERROR } from "@repo/shared/generation-timeout";
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
  getRuntimeSettingString,
} from "@repo/shared/system-settings";
import { and, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { completeImageGenerationWithUsage } from "@/features/dashboard/output-usage-read-model";
import {
  refundExternalApiKeyCredits,
  reserveExternalApiKeyCredits,
} from "@/features/external-api/quota";
import { fetchMediaUpstreamDownload } from "@/features/image-backend-pool/media-upstream-fetch";
import {
  createRuntimeBackendSession,
  type RuntimeBackendSession,
} from "@/features/image-backend-pool/runtime-service";
import {
  buildGenerationBillingPolicy,
  type GenerationBillingPolicy,
  getImageSuccessTargetCredits,
  getInitialGenerationCharge,
  getModerationFailureCharge,
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
  getImageCreditCostBreakdown,
  type ImageBaseCreditPricing,
  type ImageQualityLevel,
  type ImageThinkingLevel,
  normalizeImageSize,
  parseImageSize,
  type ResolvedImageModerationCreditPricing,
  roundCreditAmount,
  roundUpCreditAmount,
} from "./resolution";
import { calibrateImageResolution } from "./resolution-calibration";
import { resolveImageResolutionSettlement } from "./resolution-settlement";
import { editImage, generateImage } from "./service";
import { classifyGenerationError } from "./sla-classification";
import { superResolve } from "./super-resolution";
import {
  applyTransparentMatte,
  isTransparentUnsupportedError,
} from "./transparent-fallback";
import type {
  ApiConfig,
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
    } & GenerateImageParams)
  | ({
      mode: "edit";
      userId: string;
      generationId?: string;
      apiKeyId?: string;
      backendGroupId?: string;
    } & EditImageParams);

type ImageCreditCostBreakdown = ReturnType<typeof getImageCreditCostBreakdown>;

function resolveOutputRole(params: { outputRole?: "final" | "choice" }) {
  if (params.outputRole === "choice") return "choice";
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

  const response = await fetchMediaUpstreamDownload(result.imageUrl);
  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

type StoredGeneratedImageOutput = {
  generationId: string;
  imageUrl: string;
  /** 可选的内联图片数据。 */
  imageBase64?: string;
  imageFileId?: string;
  storageKey: string;
  fileSize: number;
  size: string;
  revisedPrompt?: string;
  upstreamRevisedPrompt?: string;
  actualSizeDetected: boolean;
  actualOutputFormat: string | null;
  actualOutputFormatDetected: boolean;
  outputRole?: "final" | "choice";
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

function hasImageOutput(result: GenerateImageResult) {
  return Boolean(
    result.imageBase64 ||
      result.imageUrl ||
      result.imageOutputs?.some((item) => item.imageBase64 || item.imageUrl)
  );
}

/** 将空值与公开 `default` 别名收敛到平台默认图片模型能力键。 */
function resolveRequestedImageModel(model: string | null | undefined): string {
  const requestedModel = model?.trim();
  if (!requestedModel || requestedModel.toLowerCase() === "default") {
    return DEFAULT_IMAGE_MODEL;
  }
  return requestedModel;
}

/**
 * 在主生成所属分组内为一次附加编辑独立获租并执行无粘性失败切换。
 *
 * @param input 服务端固定分组、模型、审核资格和编辑载荷。
 * @returns 首个成功媒体结果，或候选耗尽时最后一个可定位错误。
 */
async function runAuxiliaryImageEdit(input: {
  userId: string;
  apiKeyId?: string;
  pinnedGroupId: string;
  modelId: string;
  requiresContentSafety: boolean;
  params: EditImageParams;
}): Promise<GenerateImageResult> {
  const session = await createRuntimeBackendSession({
    userId: input.userId,
    apiKeyId: input.apiKeyId,
    pinnedGroupId: input.pinnedGroupId,
    modelId: input.modelId,
    requestKind: "image",
    requiresContentSafety: input.requiresContentSafety,
    requiresMask: Boolean(input.params.mask),
  });

  try {
    let lease = await session.acquireNext();
    for (;;) {
      const attemptStartedAt = Date.now();
      let result: GenerateImageResult;
      try {
        result = await editImage(lease.config, input.params);
      } catch (error) {
        result = {
          error: toClientErrorMessage(
            error,
            { source: "auxiliary-image-edit" },
            "Image repair failed"
          ),
        };
      }

      if (!result.error && hasImageOutput(result)) {
        await session.completeCurrent({
          success: true,
          durationMs: Date.now() - attemptStartedAt,
        });
        return result;
      }

      const failedResult = result.error
        ? result
        : {
            ...result,
            error: "Image repair completed without an image output",
          };
      const errorMessage =
        failedResult.error || "Image repair completed without an image output";
      if (classifyGenerationError(errorMessage) !== "platform") {
        await session.completeCurrent({
          success: false,
          terminal: true,
          error: errorMessage,
          durationMs: Date.now() - attemptStartedAt,
        });
        return failedResult;
      }

      try {
        lease = await session.switchAfterFailure(
          errorMessage,
          Date.now() - attemptStartedAt
        );
      } catch {
        return failedResult;
      }
    }
  } finally {
    await session.close();
  }
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
    revisedPrompt?: string;
    upstreamRevisedPrompt?: string;
    outputRole?: "final" | "choice";
  };
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
  /** 每次修复调用都通过统一号池独立获租，禁止复用主生成已释放的成员配置。 */
  runAuxiliaryEdit: (params: EditImageParams) => Promise<GenerateImageResult>;
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
    //  - IMAGE_MASK_OUTPAINT_ENABLED：掩码顺序外绘（1K tile + mask，见 masked-outpaint.ts）
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
        // 每块都独立获取支持 mask 的统一成员租约；租约与一次上游调用一一对应。
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
              try {
                const edited = await params.runAuxiliaryEdit({
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
            // 整图重绘同样独立获租，成功后计费一次。
            async (whole, w, h) => {
              const edited = await params.runAuxiliaryEdit({
                prompt: repairPrompt,
                images: [{ data: whole, name: "image.png", type: "image/png" }],
                size: `${w}x${h}`,
                model: DEFAULT_IMAGE_MODEL,
                outputFormat: "png",
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
  return {
    generationId: params.generationId,
    imageUrl: await getStoredImageUrl(params.bucket, storageKey),
    imageFileId: params.output.imageFileId,
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

type UpstreamStreamTelemetry = {
  startedAt: string;
  partialImageCount: number;
  finalImageCount: number;
};

function createUpstreamStreamTelemetryTracker(params: {
  startedAtMs: number;
  callbacks?: ImageGenerationCallbacks;
}) {
  const telemetry: UpstreamStreamTelemetry = {
    startedAt: new Date(params.startedAtMs).toISOString(),
    partialImageCount: 0,
    finalImageCount: 0,
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

function buildModelMetadata(params: {
  imageModel: string;
  recordModel: string;
}) {
  return {
    models: {
      imageModel: params.imageModel,
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
  const inputImages = getInputImages(input);
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
  const moderationPrompt = !promptOptimization ? input.prompt : apiPrompt;

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
  const requestedCount = input.n || 1;
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
  // 仅以实际存在的蒙版文件作为调度条件，不能信任客户端额外声明的能力字段。
  const requiresMask = input.mode === "edit" && Boolean(input.mask);
  const imageModel = resolveRequestedImageModel(input.model);
  const recordModel = imageModel;
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
        let session: RuntimeBackendSession | null = null;
        try {
          const moderationRequired =
            (await isContentModerationEnabled()) && moderationBlockingEnabled;
          let initialConfig: ApiConfig;
          try {
            session = await createRuntimeBackendSession({
              userId: input.userId,
              apiKeyId: input.apiKeyId,
              requestedGroupId: input.backendGroupId,
              modelId: imageModel,
              requestKind: "image",
              requiresContentSafety: moderationRequired,
              requiresMask,
            });
            initialConfig = (await session.acquireNext()).config;
          } catch (error) {
            return {
              error: toClientErrorMessage(
                error,
                { source: "image-backend-acquire", generationId },
                "当前没有可用的生图后端"
              ),
              generationId,
            };
          }

          const moderationEnabled =
            moderationRequired && initialConfig.contentSafetyEnabled !== false;
          const moderationImageCount = moderationEnabled
            ? inputImages.length
            : 0;
          // WHY: 计价固定使用本次会话已授权分组的覆盖值；成员切换不得造成价格漂移。
          const {
            basePricing: imageBasePricing,
            moderationPricing: imageModerationPricing,
          } = await getRuntimeImageCreditPricing(
            imageModel,
            session.group.imageCreditOverrides
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
          const billingPolicy = buildGenerationBillingPolicy({
            useSiteImageCredits: true,
            moderationEnabled,
          });
          const initialCreditCharge = getInitialGenerationCharge({
            policy: billingPolicy,
            isChatInput: false,
            chatRoundCredits: 0,
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
                isChatInput: false,
                chatRoundCredits: 0,
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
            initialCreditCharge,
            bucket,
            moderationContext,
            moderationFailureCredits,
            promptOptimization,
            apiPrompt,
            moderationPrompt,
            imageBasePricing,
            imageModerationPricing,
            initialConfig,
            session,
            useCredits: true,
            billingPolicy,
            imageModel,
            recordModel,
            moderationEnabled,
          });
        } finally {
          await session?.close();
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
  initialCreditCharge,
  bucket,
  moderationContext,
  moderationFailureCredits,
  promptOptimization,
  apiPrompt,
  moderationPrompt,
  imageBasePricing,
  imageModerationPricing,
  initialConfig,
  session,
  useCredits,
  billingPolicy,
  imageModel,
  recordModel,
  moderationEnabled,
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
  initialCreditCharge: number;
  bucket: string;
  moderationContext: GenerationModerationContext;
  moderationFailureCredits: number;
  promptOptimization: boolean;
  apiPrompt: string;
  moderationPrompt: string;
  imageBasePricing: ImageBaseCreditPricing;
  imageModerationPricing: ResolvedImageModerationCreditPricing;
  initialConfig: ApiConfig;
  session: RuntimeBackendSession;
  useCredits: boolean;
  billingPolicy: GenerationBillingPolicy;
  imageModel: string;
  recordModel: string;
  moderationEnabled: boolean;
}): Promise<ImageGenerationOperationResult> {
  const startedAt = Date.now();
  let activeConfig = initialConfig;
  const promptOptimizationMetadata = buildPromptOptimizationMetadata({
    input,
    promptOptimization,
    apiPrompt,
  });
  const backendMetadata = buildBackendExecutionMetadata({
    config: activeConfig,
    useCredits,
    billingPolicy,
  });
  const billingMetadata = {
    billingGroupId: session.group.id,
    chargeImageCredits: billingPolicy.chargeImageCredits,
    chargeModerationCredits: billingPolicy.chargeModerationCredits,
    billingMode: billingPolicy.mode,
  };
  const modelMetadata = buildModelMetadata({
    imageModel,
    recordModel,
  });
  const inputImagesMetadata = buildInputImagesMetadata(inputImages);
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
          ? "image-generation"
          : "content-moderation",
        billingPolicy.chargeImageCredits
          ? `Image generation: ${input.prompt.substring(0, 50)}`
          : `Content moderation: ${input.prompt.substring(0, 50)}`,
        {
          generationId,
          mode: input.mode,
          size,
          creditCost,
          billingGroupId: session.group.id,
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
          error: IMAGE_GENERATION_TIMEOUT_ERROR,
          creditsConsumed: chargedCredits,
          completedAt: new Date(),
          metadata: sql`COALESCE(${generation.metadata}, '{}'::json)::jsonb || ${JSON.stringify(
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
            }
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
        error: IMAGE_GENERATION_TIMEOUT_ERROR,
        generationId,
        creditsConsumed: chargedCredits,
      };
    };

  const currentPrompt = input.prompt;
  const currentApiPrompt = apiPrompt;
  const currentModerationPrompt = moderationPrompt;
  let result: GenerateImageResult;

  const attemptGeneration = async (background: typeof input.background) => {
    const remainingMs = Math.max(
      1,
      IMAGE_GENERATION_PENDING_TIMEOUT_MS - (Date.now() - startedAt)
    );
    const commonSignal = AbortSignal.timeout(remainingMs);
    return input.mode === "edit"
      ? await editImage(
          activeConfig,
          {
            prompt: currentPrompt,
            apiPrompt: currentApiPrompt,
            promptOptimization,
            signal: commonSignal,
            images: input.images,
            mask: input.mask,
            size: input.size,
            model: imageModel,
            thinking: input.thinking,
            quality: input.quality,
            n: input.n,
            moderation: input.moderation,
            outputFormat: input.outputFormat,
            outputCompression: input.outputCompression,
            background,
          },
          generationCallbacks
        )
      : await generateImage(
          activeConfig,
          {
            prompt: currentPrompt,
            apiPrompt: currentApiPrompt,
            promptOptimization,
            signal: commonSignal,
            size,
            model: imageModel,
            thinking: input.thinking,
            n: input.n,
            quality: input.quality,
            moderation: input.moderation,
            outputFormat: input.outputFormat,
            outputCompression: input.outputCompression,
            background,
          },
          generationCallbacks
        );
  };

  // 透明背景抠图回退(显式开关,issue #27):仅当请求显式 transparentMatte=true 且 background=transparent
  // 时,后端不支持透明(400)则在同一 generationId 内不透明重生成 + 服务端 ISNet 抠图得到透明结果
  // (不额外扣费)。覆盖文生图与图生图；未开启则透明直接透传，
  // 不支持时返回真实错误(不再自动回退)。
  const transparentMatteEnabled =
    input.background === "transparent" && input.transparentMatte === true;
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

  {
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
            buildStreamTelemetryMetadata()
          )}::jsonb`,
        })
        .where(isPendingGeneration(generationId));
      return {
        error: responseMessage,
        generationId,
        creditsConsumed: chargedCredits,
      };
    }

    for (;;) {
      const attemptStartedAt = Date.now();
      try {
        result = await runGenerationAttempt();
      } catch (error) {
        result = {
          error: toClientErrorMessage(
            error,
            { source: "image-generation-attempt", generationId },
            "Image generation failed"
          ),
        };
      }

      const durationMs = Date.now() - attemptStartedAt;
      if (isTimedOut()) {
        await session.completeCurrent({
          success: false,
          error: result.error || "Image generation timed out",
          durationMs,
        });
        return failTimedOutGeneration();
      }

      if (!result.error && hasImageOutput(result)) {
        await session.completeCurrent({ success: true, durationMs });
        break;
      }

      if (!result.error) {
        result = {
          ...result,
          error: "Image generation completed without an image output",
        };
      }
      const errorMessage = result.error || "Image generation failed";
      if (classifyGenerationError(errorMessage) !== "platform") {
        await session.completeCurrent({
          success: false,
          terminal: true,
          error: errorMessage,
          durationMs,
        });
        break;
      }

      try {
        activeConfig = (
          await session.switchAfterFailure(errorMessage, durationMs)
        ).config;
      } catch {
        break;
      }
    }
  }
  const buildExecutionMetadata = (metadata: Record<string, unknown>) => ({
    ...buildStreamTelemetryMetadata(),
    ...buildBackendExecutionMetadata({
      config: activeConfig,
      useCredits,
      billingPolicy,
    }),
    ...metadata,
  });

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
          buildExecutionMetadata({})
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
    const message = "Image generation completed without an image output";
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
          buildExecutionMetadata({ missingImageOutput: true })
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

  let storedOutputs: StoredGeneratedImageOutput[] = [];
  try {
    const imageOutputs = getResultImageOutputs(result).map((output) => ({
      ...output,
      outputRole: resolveOutputRole({
        outputRole: output.outputRole,
      }),
    })) satisfies NonNullable<GenerateImageResult["imageOutputs"]>;
    if (imageOutputs.length === 0) {
      throw new Error("Missing image data");
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
          userId: input.userId,
          generationId: outputGenerationId,
          bucket,
          requestedSize: size,
          requestedFormat: input.outputFormat,
          hdRepair: input.hdRepair,
          blockRepair: input.blockRepair,
          repairPrompt: input.repairPrompt,
          runAuxiliaryEdit: (params) =>
            runAuxiliaryImageEdit({
              userId: input.userId,
              apiKeyId: input.apiKeyId,
              pinnedGroupId: session.group.id,
              modelId: DEFAULT_IMAGE_MODEL,
              requiresContentSafety: moderationEnabled,
              params,
            }),
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
          buildExecutionMetadata({})
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

  const primaryOutput = storedOutputs.at(-1);
  if (!primaryOutput) {
    throw new Error("持久化图片完成后缺少主产物");
  }
  const upstreamImageOutputCount = Math.max(
    Math.floor(result.imageOutputCount || 0),
    storedOutputs.length
  );
  const billableOutputs = storedOutputs;
  const billableImageOutputCount = billableOutputs.length;
  const perOutputCreditCosts = storedOutputs.map((output) =>
    getImageCreditCostBreakdown(output.size, {
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
  const targetSuccessCredits = getImageSuccessTargetCredits({
    policy: billingPolicy,
    isChatInput: false,
    chatRoundCredits: 0,
    chatRoundCount: 0,
    actualImageCredits,
    creditCost,
  });
  try {
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
        billableImageOutputCount,
        upstreamImageOutputCount,
        billingMode: billingPolicy.mode,
      }
    );
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
          buildExecutionMetadata({})
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
        buildExecutionMetadata({
          ...buildRevisedPromptMetadata({
            input,
            apiPrompt: currentApiPrompt,
            result,
          }),
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
            billableImageOutputCount,
            upstreamImageOutputCount,
            imageOutputs: storedOutputs.map((output) => ({
              generationId: output.generationId,
              imageUrl: output.imageUrl,
              imageFileId: output.imageFileId,
              storageKey: output.storageKey,
              size: output.size,
              revisedPrompt: output.revisedPrompt,
              upstreamRevisedPrompt: output.upstreamRevisedPrompt,
              actualFormat: output.actualOutputFormat,
              actualFormatDetected: output.actualOutputFormatDetected,
              actualSizeDetected: output.actualSizeDetected,
              role: resolveOutputRole({
                outputRole: output.outputRole,
              }),
              primary: output.generationId === primaryOutput.generationId,
            })),
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
      size: output.size,
      revisedPrompt: output.revisedPrompt,
      upstreamRevisedPrompt: output.upstreamRevisedPrompt,
      index,
      outputRole: resolveOutputRole({
        outputRole: output.outputRole,
      }),
    })),
    model: recordModel,
    size: primaryOutput.size,
    revisedPrompt: result.revisedPrompt || primaryOutput.revisedPrompt,
    creditsConsumed: chargedCredits,
  };
}
