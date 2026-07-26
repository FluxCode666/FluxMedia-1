/**
 * 模型广场自定义封面的安全处理与内容寻址 key 构造。
 *
 * 管理保存服务把不可信上传字节交给本模块；本模块只负责体积、解码、格式、动画、像素、
 * 裁切、重编码和哈希，不读取数据库、存储配置或客户端提供的文件名与 MIME。
 */
import { createHash } from "node:crypto";

import {
  MAX_MODEL_MARKETPLACE_CONFIG_KEY_LENGTH,
  MAX_MODEL_MARKETPLACE_COVER_BYTES,
  type ModelMarketplacePublicCategory,
} from "@repo/shared/model-marketplace";
import sharp, { type Metadata } from "sharp";

const MAX_COVER_INPUT_PIXELS = 40_000_000;
const MAX_COVER_OUTPUT_WIDTH = 1_200;
const MAX_COVER_OUTPUT_HEIGHT = 800;
const COVER_WEBP_QUALITY = 82;
const CONTENT_SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COVER_ASPECT_RATIO_WIDTH_UNITS = 3;
const COVER_ASPECT_RATIO_HEIGHT_UNITS = 2;

/** 封面校验失败的稳定错误码，传输层可据此映射友好提示。 */
export type ModelMarketplaceCoverImageErrorCode =
  | "empty"
  | "too_large"
  | "invalid_image"
  | "unsupported_format"
  | "animated_image"
  | "invalid_config_key"
  | "invalid_category"
  | "invalid_content_hash";

/** 处理成功后的唯一 WebP 资产及其内容哈希。 */
export type ProcessedModelMarketplaceCoverImage = {
  bytes: Uint8Array;
  sha256: string;
  contentType: "image/webp";
};

/**
 * 表示封面输入或内容寻址参数不满足安全契约。
 *
 * 错误消息可以面向管理员展示；cause 仅供服务端日志定位，调用方不得原样返回底层异常。
 */
export class ModelMarketplaceCoverImageError extends Error {
  readonly code: ModelMarketplaceCoverImageErrorCode;

  /**
   * 创建带稳定错误码的封面错误。
   *
   * @param code - 供服务与传输层识别的机器可读错误码。
   * @param message - 不包含图片字节或 Sharp 内部细节的管理员提示。
   * @param options - 可选底层异常，仅用于服务端日志和调试。
   */
  constructor(
    code: ModelMarketplaceCoverImageErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ModelMarketplaceCoverImageError";
    this.code = code;
  }
}

/**
 * 判断 Sharp 识别出的实际编码是否在模型广场白名单中。
 *
 * @param format - Sharp metadata 返回的实际格式，不信任文件扩展名或浏览器 MIME。
 * @returns 仅 JPEG、PNG、WebP 返回 true。
 */
function isAllowedCoverFormat(
  format: string | undefined
): format is "jpeg" | "png" | "webp" {
  return format === "jpeg" || format === "png" || format === "webp";
}

/**
 * 在严格警告与像素上限下读取图片元数据。
 *
 * @param input - 已通过原始字节体积检查的上传 Buffer。
 * @returns Sharp 安全解析出的格式、尺寸和页数信息。
 * @throws ModelMarketplaceCoverImageError - 损坏、截断或超过像素上限时统一失败。
 */
async function readSafeCoverMetadata(input: Buffer): Promise<Metadata> {
  try {
    return await sharp(input, {
      failOn: "warning",
      limitInputPixels: MAX_COVER_INPUT_PIXELS,
    }).metadata();
  } catch (cause) {
    throw new ModelMarketplaceCoverImageError(
      "invalid_image",
      "封面必须是可安全解码的 JPEG、PNG 或 WebP 静态图片，且总像素不得超过 40,000,000。",
      { cause }
    );
  }
}

/**
 * 根据自动旋转后的原图尺寸计算严格 3:2 且不会放大的输出尺寸。
 *
 * @param width - 自动旋转后的原图宽度。
 * @param height - 自动旋转后的原图高度。
 * @returns 不超过原图裁切区域和 1200×800 的 3:2 整数尺寸。
 * @throws ModelMarketplaceCoverImageError - 图片小于可形成 3×2 裁切区域时拒绝处理。
 */
function getCoverOutputDimensions(
  width: number,
  height: number
): { width: number; height: number } {
  const sourceUnit = Math.floor(
    Math.min(
      width / COVER_ASPECT_RATIO_WIDTH_UNITS,
      height / COVER_ASPECT_RATIO_HEIGHT_UNITS
    )
  );
  const maximumOutputUnit = Math.floor(
    Math.min(
      MAX_COVER_OUTPUT_WIDTH / COVER_ASPECT_RATIO_WIDTH_UNITS,
      MAX_COVER_OUTPUT_HEIGHT / COVER_ASPECT_RATIO_HEIGHT_UNITS
    )
  );
  const outputUnit = Math.min(sourceUnit, maximumOutputUnit);
  if (outputUnit < 1) {
    throw new ModelMarketplaceCoverImageError(
      "invalid_image",
      "封面图片尺寸过小，无法裁切为 3:2。"
    );
  }

  return {
    width: outputUnit * COVER_ASPECT_RATIO_WIDTH_UNITS,
    height: outputUnit * COVER_ASPECT_RATIO_HEIGHT_UNITS,
  };
}

/**
 * 把已验证的静态图片重编码为固定模型广场封面。
 *
 * @param input - 与读取元数据时相同的上传 Buffer。
 * @param dimensions - 根据自动旋转后的原图计算出的最终 3:2 尺寸。
 * @returns 自动旋转、中心裁成 3:2、限制在 1200×800 且不放大的无元数据 WebP。
 * @throws ModelMarketplaceCoverImageError - 实际像素解码失败时统一拒绝，不产出部分结果。
 */
async function encodeSafeCoverWebp(
  input: Buffer,
  dimensions: { width: number; height: number }
): Promise<Buffer> {
  try {
    return await sharp(input, {
      failOn: "warning",
      limitInputPixels: MAX_COVER_INPUT_PIXELS,
    })
      .rotate()
      .resize({
        width: dimensions.width,
        height: dimensions.height,
        fit: "cover",
        position: "centre",
        withoutEnlargement: true,
      })
      // 不调用 keepMetadata/withMetadata，确保 EXIF、ICC、XMP 等输入元数据被移除。
      .webp({ quality: COVER_WEBP_QUALITY })
      .toBuffer();
  } catch (cause) {
    throw new ModelMarketplaceCoverImageError(
      "invalid_image",
      "封面图片无法安全解码，请重新导出为静态 JPEG、PNG 或 WebP 后重试。",
      { cause }
    );
  }
}

/**
 * 安全处理管理员上传的模型广场封面。
 *
 * @param bytes - multipart 适配器读取的原始字节；不读取文件名或声明 MIME。
 * @returns 最终 WebP 字节、其小写 SHA-256 和固定 image/webp 内容类型。
 * @throws ModelMarketplaceCoverImageError - 空文件、超限、格式非法、动画或解码失败时抛出。
 */
export async function processModelMarketplaceCoverImage(
  bytes: Uint8Array
): Promise<ProcessedModelMarketplaceCoverImage> {
  if (bytes.byteLength === 0) {
    throw new ModelMarketplaceCoverImageError("empty", "封面文件不能为空。");
  }
  if (bytes.byteLength > MAX_MODEL_MARKETPLACE_COVER_BYTES) {
    throw new ModelMarketplaceCoverImageError(
      "too_large",
      "封面原文件不能超过 5 MB。"
    );
  }

  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metadata = await readSafeCoverMetadata(input);
  if (!isAllowedCoverFormat(metadata.format)) {
    throw new ModelMarketplaceCoverImageError(
      "unsupported_format",
      "封面只支持静态 JPEG、PNG 或 WebP。"
    );
  }
  if ((metadata.pages ?? 1) !== 1) {
    throw new ModelMarketplaceCoverImageError(
      "animated_image",
      "封面不支持多页或动画图片。"
    );
  }
  if (!metadata.width || !metadata.height) {
    throw new ModelMarketplaceCoverImageError(
      "invalid_image",
      "无法读取封面图片尺寸。"
    );
  }

  const orientedWidth = metadata.autoOrient?.width ?? metadata.width;
  const orientedHeight = metadata.autoOrient?.height ?? metadata.height;
  const dimensions = getCoverOutputDimensions(orientedWidth, orientedHeight);
  const output = await encodeSafeCoverWebp(input, dimensions);
  return {
    bytes: output,
    sha256: createHash("sha256").update(output).digest("hex"),
    contentType: "image/webp",
  };
}

/**
 * 使用模型类别、规范配置键哈希和最终内容哈希生成对象存储 key。
 *
 * @param category - 真实公开模型类别，只允许 image 或 video。
 * @param configKey - 已由目录规范化的非空配置键；原值只参与哈希，不进入对象路径。
 * @param contentSha256 - 处理后 WebP 字节的小写 SHA-256。
 * @returns `<category>/<config-key-sha256>/<content-sha256>.webp`。
 * @throws ModelMarketplaceCoverImageError - 参数不满足规范时拒绝构造存储路径。
 */
export function buildModelMarketplaceCoverObjectKey(
  category: ModelMarketplacePublicCategory,
  configKey: string,
  contentSha256: string
): string {
  if (category !== "image" && category !== "video") {
    throw new ModelMarketplaceCoverImageError(
      "invalid_category",
      "封面只适用于图像或视频模型。"
    );
  }
  if (
    configKey.length === 0 ||
    configKey.length > MAX_MODEL_MARKETPLACE_CONFIG_KEY_LENGTH ||
    configKey.trim() !== configKey
  ) {
    throw new ModelMarketplaceCoverImageError(
      "invalid_config_key",
      "模型配置键无效。"
    );
  }
  if (!CONTENT_SHA256_PATTERN.test(contentSha256)) {
    throw new ModelMarketplaceCoverImageError(
      "invalid_content_hash",
      "封面内容哈希无效。"
    );
  }

  const configKeySha256 = createHash("sha256").update(configKey).digest("hex");
  return `${category}/${configKeySha256}/${contentSha256}.webp`;
}
