import { randomUUID } from "node:crypto";
import { withApiLogging } from "@repo/shared/api-logger";
import { auth } from "@repo/shared/auth";
import { getUserRoleById } from "@repo/shared/auth/role-server";
import { getMediaLimitDefaults } from "@repo/shared/image-generation/media-limit-service";
import { imageModelIdSchema } from "@repo/shared/image-generation/model-contract";
import { OperationError } from "@repo/shared/uol";
import { type NextRequest, NextResponse } from "next/server";
import { toClientErrorMessage } from "@/features/image-generation/error-sanitize";
import {
  normalizeImageBackground,
  normalizeOutputCompression,
  normalizeOutputFormat,
  VALID_IMAGE_BACKGROUNDS,
  VALID_OUTPUT_FORMATS,
} from "@/features/image-generation/output-format";
import { hasTrustedImageGenerationOrigin } from "@/features/image-generation/request-security";
import {
  filesToMediaInputReferences,
  formatMegabytes,
  getTotalUploadSize,
  validateImageFile,
  validateMaskMatchesSourceImage,
} from "@/features/image-generation/request-utils";
import {
  IMAGE_PROMPT_MAX_CHARACTERS,
  IMAGE_PROMPT_TOO_LONG_MESSAGE,
  parseImageSize,
  resolveImageRequestSize,
  validateImageSize,
} from "@/features/image-generation/resolution";
import type {
  ImageBackground,
  ImageModeration,
  ImageOutputFormat,
  ImageQuality,
  ThinkingLevel,
} from "@/features/image-generation/types";
import { invokeImageEnqueueAsyncOperation } from "@/features/image-generation/uol-client";

const VALID_QUALITIES = new Set<ImageQuality>([
  "auto",
  "low",
  "medium",
  "high",
]);
const VALID_MODERATION = new Set<ImageModeration>(["auto", "low"]);
const VALID_THINKING = new Set<ThinkingLevel>([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
]);
const IMAGE_EDIT_ERROR_FALLBACK = "Image editing failed. Please retry shortly.";

function errorResponse(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function getText(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getOptionalBoolean(formData: FormData, ...keys: string[]) {
  for (const key of keys) {
    const value = getText(formData, key).toLowerCase();
    if (!value) continue;
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
  }
  return undefined;
}

function getImageFiles(formData: FormData) {
  const images: File[] = [];

  for (const [key, value] of formData.entries()) {
    if (
      value instanceof File &&
      (key === "image" || key === "image[]" || key.startsWith("image_"))
    ) {
      images.push(value);
    }
  }

  return images;
}

export const POST = withApiLogging(async (request: NextRequest) => {
  const session = await auth.api.getSession({
    headers: request.headers,
  });

  if (!session?.user) {
    return errorResponse("Unauthorized", 401);
  }

  if (!hasTrustedImageGenerationOrigin(request)) {
    return errorResponse("Forbidden", 403);
  }

  const [role, mediaLimits] = await Promise.all([
    getUserRoleById(session.user.id),
    getMediaLimitDefaults(),
  ]);
  const maxImageBytes = mediaLimits.maxFileSizeBytes;
  const maxRequestBytes = mediaLimits.maxUploadSizeBytes;

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse(
      `Upload is too large or incomplete. Each source image must be ${formatMegabytes(maxImageBytes)} or smaller, and the total upload must be ${formatMegabytes(maxRequestBytes)} or smaller.`,
      413
    );
  }
  for (const field of ["count", "generationIds", "generation_ids"] as const) {
    if (formData.has(field)) {
      return errorResponse(
        `${field} is not supported; image requests generate exactly one image.`
      );
    }
  }
  const prompt = getText(formData, "prompt");
  if (!prompt) {
    return errorResponse("Prompt is required.");
  }

  if (prompt.length > IMAGE_PROMPT_MAX_CHARACTERS) {
    return errorResponse(IMAGE_PROMPT_TOO_LONG_MESSAGE);
  }
  const apiPrompt = getText(formData, "apiPrompt") || undefined;
  if (apiPrompt && apiPrompt.length > 8000) {
    return errorResponse("Context prompt exceeds the 8000 character limit.");
  }
  const promptOptimization = getOptionalBoolean(
    formData,
    "promptOptimization",
    "prompt_optimization"
  );
  const requestedGenerationId =
    getText(formData, "generationId") || getText(formData, "generation_id");
  if (requestedGenerationId.length > 128) {
    return errorResponse("generationId is too long.");
  }
  const backendGroupId =
    getText(formData, "backendGroupId") ||
    getText(formData, "backend_group_id") ||
    undefined;
  if (backendGroupId && backendGroupId.length > 128) {
    return errorResponse("backendGroupId is too long.");
  }
  const size = getText(formData, "size") || undefined;
  if (size) {
    const sizeCheck = validateImageSize(size);
    if (!sizeCheck.valid) {
      return errorResponse(sizeCheck.message);
    }
  }

  const qualityValue = getText(formData, "quality") || "auto";
  if (!VALID_QUALITIES.has(qualityValue as ImageQuality)) {
    return errorResponse("Invalid quality.");
  }
  const quality = qualityValue as ImageQuality;
  const moderationValue = getText(formData, "moderation") || "auto";
  if (!VALID_MODERATION.has(moderationValue as ImageModeration)) {
    return errorResponse("Invalid moderation.");
  }
  const moderation = moderationValue as ImageModeration;
  const outputFormatValue =
    getText(formData, "output_format") || getText(formData, "outputFormat");
  const outputFormat = normalizeOutputFormat(outputFormatValue);
  if (
    outputFormatValue &&
    !VALID_OUTPUT_FORMATS.has(outputFormat as ImageOutputFormat)
  ) {
    return errorResponse("Invalid output_format.");
  }
  const outputCompression = normalizeOutputCompression(
    getText(formData, "output_compression") ||
      getText(formData, "outputCompression")
  );
  const backgroundValue = getText(formData, "background");
  const background = normalizeImageBackground(backgroundValue);
  if (
    backgroundValue &&
    !VALID_IMAGE_BACKGROUNDS.has(background as ImageBackground)
  ) {
    return errorResponse("Invalid background.");
  }
  // 透明背景抠图回退显式开关(issue #27)。
  const transparentMatte = getOptionalBoolean(
    formData,
    "transparentMatte",
    "transparent_matte"
  );
  // 高清修复:显式 false 走轻量 general-x4v3;undefined/true 由后端选 SwinIR 超分。
  const hdRepair = getOptionalBoolean(formData, "hdRepair", "hd_repair");
  // 分块修复:切成 2×2 web 块逐块 gpt-image-2 重绘再拼接;逐块单独计费。默认关。
  const blockRepair = getOptionalBoolean(
    formData,
    "blockRepair",
    "block_repair"
  );
  const repairPromptRaw =
    formData.get("repairPrompt") ?? formData.get("repair_prompt");
  const repairPrompt =
    typeof repairPromptRaw === "string" ? repairPromptRaw : undefined;
  const parsedModel = imageModelIdSchema.safeParse(getText(formData, "model"));
  if (!parsedModel.success) {
    return errorResponse(
      parsedModel.error.issues[0]?.message || "Invalid model."
    );
  }
  const model = parsedModel.data;
  const thinkingValue = getText(formData, "thinking") || undefined;
  if (thinkingValue && !VALID_THINKING.has(thinkingValue as ThinkingLevel)) {
    return errorResponse("Invalid thinking level.");
  }
  const thinking = thinkingValue as ThinkingLevel | undefined;
  const displaySize = getText(formData, "displaySize") || undefined;
  if (displaySize && !parseImageSize(displaySize)) {
    return errorResponse("Invalid display size.");
  }
  const sourceFiles = getImageFiles(formData);
  if (sourceFiles.length === 0) {
    return errorResponse("At least one source image is required.");
  }

  if (sourceFiles.length > mediaLimits.maxEditReferenceImages) {
    return errorResponse(
      `No more than ${mediaLimits.maxEditReferenceImages} images are allowed.`
    );
  }

  try {
    for (const file of sourceFiles) {
      validateImageFile(file, { maxImageBytes });
    }
    const maskFile = formData.get("mask");
    if (maskFile !== null && !(maskFile instanceof File)) {
      return errorResponse("Mask must be a PNG file.");
    }
    if (maskFile instanceof File) {
      validateImageFile(maskFile, { mask: true, maxImageBytes });
    }
    if (
      getTotalUploadSize(
        sourceFiles,
        maskFile instanceof File ? maskFile : undefined
      ) > maxRequestBytes
    ) {
      return errorResponse(
        `Total upload size must be no more than ${formatMegabytes(maxRequestBytes)}.`,
        413
      );
    }
    if (maskFile instanceof File) {
      const firstSourceFile = sourceFiles[0];
      if (!firstSourceFile) {
        return errorResponse("At least one source image is required.");
      }
      await validateMaskMatchesSourceImage(firstSourceFile, maskFile);
    }

    const generationId = requestedGenerationId || randomUUID();
    const { cleanupStagedImageInputs, stageImageInputReferences } =
      await import("@/features/image-generation/image-input-storage");
    const sourceReferences = await filesToMediaInputReferences(sourceFiles);
    const mask =
      maskFile instanceof File
        ? (await filesToMediaInputReferences([maskFile]))[0]
        : undefined;
    const references = [...sourceReferences, ...(mask ? [mask] : [])];
    const staged = await stageImageInputReferences({
      userId: session.user.id,
      generationId,
      references,
    });
    const images = staged.references.slice(0, sourceReferences.length);
    const stagedMask = mask
      ? staged.references[sourceReferences.length]
      : undefined;
    const principal = {
      type: "user" as const,
      userId: session.user.id,
      role,
    };
    const requestId = request.headers.get("x-request-id") ?? undefined;
    try {
      const common = {
        generationId,
        backendGroupId,
        prompt,
        apiPrompt,
        promptOptimization,
        size: displaySize || resolveImageRequestSize(size),
        model,
        thinking,
        quality,
        moderation,
        outputFormat,
        outputCompression,
        background,
        transparentMatte,
        hdRepair,
        blockRepair,
        repairPrompt,
        images,
      };
      const task = await invokeImageEnqueueAsyncOperation(
        {
          taskId: `task_${randomUUID().replace(/-/g, "")}`,
          generationInput: stagedMask
            ? { operation: "mask", ...common, mask: stagedMask }
            : { operation: "edit", ...common },
          responseFormat: "url",
        },
        principal,
        requestId
      );
      return NextResponse.json(task, { status: 202 });
    } catch (error) {
      await cleanupStagedImageInputs(staged.objects).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    if (error instanceof OperationError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          ...(error.details ? { details: error.details } : {}),
        },
        { status: error.httpStatus }
      );
    }
    return errorResponse(
      toClientErrorMessage(
        error,
        { source: "image-edit-route" },
        IMAGE_EDIT_ERROR_FALLBACK
      )
    );
  }
});
