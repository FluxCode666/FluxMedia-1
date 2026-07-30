/**
 * Adobe 视频具名输入校验、预处理与上传。
 *
 * 使用方：Adobe direct 视频提交适配器。所有模式和数量校验在上传前完成；上传结果继续
 * 保持 firstFrame、lastFrame、referenceImages 的语义和调用者顺序。
 */
import type { VideoFrameInputCapability } from "@repo/shared/video-generation";
import sharp from "sharp";

export type AdobeVideoSourceImageMode = "original" | "target-cover";
export type AdobeVideoSourceMimeType =
  | "image/jpeg"
  | "image/png"
  | "image/webp";

/** Adobe 适配器尚未上传的单张视频输入图。 */
export type AdobeVideoSourceInput = {
  data: Buffer;
  type?: string | null;
};

/** Adobe 适配器消费的具名视频输入图。 */
export type AdobeVideoSourceInputs = {
  firstFrame?: AdobeVideoSourceInput;
  lastFrame?: AdobeVideoSourceInput;
  referenceImages?: readonly AdobeVideoSourceInput[];
};

/** Adobe 上传端点返回的具名素材 ID。 */
export type AdobeUploadedVideoSourceIds = {
  firstFrameId?: string;
  lastFrameId?: string;
  referenceImageIds?: string[];
};

/**
 * 将 Sharp 图片格式收窄为 Adobe 上传端点接受的 MIME 类型。
 *
 * @param format Sharp 解码后的图片格式。
 * @returns 支持的 MIME 类型；不支持的格式返回 null。
 * @sideEffects 无。
 * @failure 不抛错，由调用方决定如何报告不支持的输入。
 */
function resolveAdobeVideoSourceMimeType(
  format: string | undefined
): AdobeVideoSourceMimeType | null {
  if (format === "jpeg") return "image/jpeg";
  if (format === "png") return "image/png";
  if (format === "webp") return "image/webp";
  return null;
}

/**
 * 将输入图按 Adobe 视频目标尺寸等比缩放并居中裁剪。
 *
 * @param imageBytes 原始图片字节
 * @param size Adobe 视频目标尺寸（宽高必须为正整数）
 * @param mode 保留原始图片字节，或按目标尺寸 cover 裁剪
 * @returns 可直接上传的图片字节及由真实格式推导的 MIME 类型
 * @throws 输入为空、目标尺寸非法或图片无法解码时抛出明确错误
 */
export async function prepareAdobeVideoSourceImage(
  imageBytes: Buffer,
  size: { width: number; height: number },
  mode: AdobeVideoSourceImageMode = "target-cover"
): Promise<{ data: Buffer; type: AdobeVideoSourceMimeType }> {
  if (!imageBytes || imageBytes.length === 0) {
    throw new Error("video source image is empty");
  }
  if (
    !Number.isInteger(size.width) ||
    !Number.isInteger(size.height) ||
    size.width <= 0 ||
    size.height <= 0
  ) {
    throw new Error("invalid Adobe video target size");
  }

  try {
    if (mode === "original") {
      const metadata = await sharp(imageBytes).metadata();
      const type = resolveAdobeVideoSourceMimeType(metadata.format);
      if (!type) {
        throw new Error(`unsupported image format: ${metadata.format}`);
      }
      return { data: Buffer.from(imageBytes), type };
    }
    const data = await sharp(imageBytes)
      .removeAlpha()
      .resize(size.width, size.height, {
        fit: "cover",
        position: "centre",
        kernel: sharp.kernel.lanczos3,
      })
      .png()
      .toBuffer();
    return { data, type: "image/png" };
  } catch (error) {
    throw new Error(
      `invalid image for Adobe video: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * 校验具名视频输入的模式、帧能力与创建时参考图上限。
 *
 * @param input - 具名图片、静态帧能力和任务创建时参考图上限。
 * @returns 无返回；合法输入可继续预处理和上传。
 * @sideEffects 无。
 * @throws Error - 输入混合、缺少首帧、不支持对应模式、超出快照上限或快照损坏时抛出。
 */
function assertAdobeVideoSourceInputs(input: {
  inputs: AdobeVideoSourceInputs;
  frameCapability: VideoFrameInputCapability;
  maxReferenceImages: number;
}): void {
  if (
    !Number.isSafeInteger(input.maxReferenceImages) ||
    input.maxReferenceImages < 0
  ) {
    throw new Error("视频任务的参考图能力快照无效");
  }
  const referenceCount = input.inputs.referenceImages?.length ?? 0;
  if ((input.inputs.firstFrame || input.inputs.lastFrame) && referenceCount) {
    throw new Error("首尾帧和参考图不能同时提交");
  }
  if (input.inputs.lastFrame && !input.inputs.firstFrame) {
    throw new Error("尾帧必须与首帧一起提交");
  }
  if (input.inputs.firstFrame && input.frameCapability === "none") {
    throw new Error("该视频模型不支持首尾帧输入");
  }
  if (
    input.inputs.lastFrame &&
    input.frameCapability !== "first-and-optional-last"
  ) {
    throw new Error("该视频模型不支持尾帧输入");
  }
  if (referenceCount > 0 && input.maxReferenceImages === 0) {
    throw new Error("该视频模型不支持参考图输入");
  }
  if (referenceCount > input.maxReferenceImages) {
    throw new Error(`该视频模型最多支持 ${input.maxReferenceImages} 张参考图`);
  }
}

/**
 * 在任何上游调用前校验全部具名输入，再按语义和调用者顺序完成预处理与上传。
 *
 * @param input - 任务创建时能力、目标尺寸、上传策略、具名图片和上传回调。
 * @returns 只包含实际输入模式的具名 Adobe 素材 ID。
 * @sideEffects 顺序调用 uploadImage；校验失败时不会解码或上传任何图片。
 * @throws Error - 能力校验、图片解码、预处理或上传失败时原样上抛。
 */
export async function prepareAndUploadAdobeVideoSourceInputs(input: {
  inputs: AdobeVideoSourceInputs;
  frameCapability: VideoFrameInputCapability;
  maxReferenceImages: number;
  size: { width: number; height: number };
  mode: AdobeVideoSourceImageMode;
  uploadImage: (
    data: Buffer,
    type: AdobeVideoSourceMimeType
  ) => Promise<string>;
}): Promise<AdobeUploadedVideoSourceIds> {
  assertAdobeVideoSourceInputs(input);

  /** 预处理并上传单张图片，保证所有模式复用同一格式边界。 */
  const uploadOne = async (source: AdobeVideoSourceInput): Promise<string> => {
    const prepared = await prepareAdobeVideoSourceImage(
      source.data,
      input.size,
      input.mode
    );
    return input.uploadImage(prepared.data, prepared.type);
  };

  const result: AdobeUploadedVideoSourceIds = {};
  if (input.inputs.firstFrame) {
    result.firstFrameId = await uploadOne(input.inputs.firstFrame);
  }
  if (input.inputs.lastFrame) {
    result.lastFrameId = await uploadOne(input.inputs.lastFrame);
  }
  if (input.inputs.referenceImages?.length) {
    const referenceImageIds: string[] = [];
    for (const source of input.inputs.referenceImages) {
      referenceImageIds.push(await uploadOne(source));
    }
    result.referenceImageIds = referenceImageIds;
  }
  return result;
}
