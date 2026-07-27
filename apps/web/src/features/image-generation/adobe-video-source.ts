/**
 * Adobe 视频输入图预处理：按目标视频尺寸居中裁剪并输出无透明通道 PNG。
 * 该步骤在上传到 Firefly 前执行，确保各视频模型收到统一的 RGB 图像格式。
 */
import sharp from "sharp";

export type AdobeVideoSourceImageMode = "original" | "target-cover";
export type AdobeVideoSourceMimeType =
  | "image/jpeg"
  | "image/png"
  | "image/webp";

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
