/**
 * Adobe 视频输入图预处理：按目标视频尺寸居中裁剪并输出无透明通道 PNG。
 * 该步骤在上传到 Firefly 前执行，确保各视频模型收到统一的 RGB 图像格式。
 */
import sharp from "sharp";

/**
 * 将输入图按 Adobe 视频目标尺寸等比缩放并居中裁剪。
 *
 * @param imageBytes 原始图片字节
 * @param size Adobe 视频目标尺寸（宽高必须为正整数）
 * @returns 可直接上传的 PNG 字节及 MIME 类型
 * @throws 输入为空、目标尺寸非法或图片无法解码时抛出明确错误
 */
export async function prepareAdobeVideoSourceImage(
  imageBytes: Buffer,
  size: { width: number; height: number }
): Promise<{ data: Buffer; type: "image/png" }> {
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
