/**
 * 网站 Logo 上传文件的真实格式校验。
 *
 * 职责：按文件魔数识别 PNG、SVG、ICO，限制解码资源并拒绝 SVG 主动内容；原始字节
 * 不在本模块中重编码，保存服务会把通过校验的字节原样写入内容寻址对象。
 * 使用方：管理员 Logo multipart Route 与网站品牌保存服务。
 * 关键依赖：Sharp 只用于读取 PNG 元数据，Saxes 用于受限 XML 结构解析。
 */
import { createHash } from "node:crypto";
import {
  MAX_SITE_LOGO_UPLOAD_BYTES,
  type SiteLogoUploadInput,
} from "@repo/shared/system-settings/site-branding";
import { SaxesParser } from "saxes";
import sharp from "sharp";

const MAX_SITE_LOGO_INPUT_PIXELS = 16_000_000;
const MAX_SITE_LOGO_DIMENSION = 4_096;
const MAX_SITE_LOGO_SVG_ELEMENTS = 5_000;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const ICO_SIGNATURE = [0x00, 0x00, 0x01, 0x00] as const;

/** Logo 文件校验的稳定错误码，Route 据此映射安全的管理员提示。 */
export type SiteLogoFileErrorCode =
  | "empty"
  | "too_large"
  | "invalid_image"
  | "unsupported_format"
  | "unsafe_svg"
  | "invalid_ico";

/** 校验成功后的原始 Logo 文件及其公开内容类型。 */
export type ValidatedSiteLogoFile = {
  bytes: Uint8Array;
  sha256: string;
  format: "png" | "svg" | "ico";
  contentType: "image/png" | "image/svg+xml" | "image/x-icon";
  extension: "png" | "svg" | "ico";
};

/** 表示上传文件不满足真实格式或安全资源限制。 */
export class SiteLogoFileError extends Error {
  readonly code: SiteLogoFileErrorCode;

  /**
   * 创建带稳定机器码的 Logo 文件错误。
   *
   * @param code - 供服务与 HTTP 传输层识别的错误类型。
   * @param message - 不包含原始字节、路径或底层 Sharp/Saxes 细节的提示。
   * @param options - 可选底层异常，仅用于服务端调试链路。
   */
  constructor(
    code: SiteLogoFileErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "SiteLogoFileError";
    this.code = code;
  }
}

/** 判断字节是否以 PNG 文件签名开头。 */
function hasPngSignature(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((value, index) => bytes[index] === value);
}

/** 判断字节是否以 Windows ICO 文件签名开头。 */
function hasIcoSignature(bytes: Uint8Array): boolean {
  return ICO_SIGNATURE.every((value, index) => bytes[index] === value);
}

/** 解析 UTF-8 SVG 文本；非法编码不能交给 XML 解析器猜测。 */
function decodeSvgText(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** 返回 SVG 中允许的自包含矢量元素白名单。 */
function isAllowedSvgElement(name: string): boolean {
  return new Set([
    "svg",
    "g",
    "defs",
    "title",
    "desc",
    "path",
    "rect",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "text",
    "tspan",
    "textPath",
    "symbol",
    "use",
    "linearGradient",
    "radialGradient",
    "stop",
    "clipPath",
    "mask",
    "pattern",
    "marker",
  ]).has(name);
}

/** 校验 SVG 属性中的引用只能指向文档内片段，阻止外部资源和脚本协议。 */
function assertSafeSvgAttribute(name: string, value: string): void {
  const localName = name.includes(":") ? (name.split(":").pop() ?? name) : name;
  if (localName.toLowerCase().startsWith("on") || localName === "style") {
    throw new SiteLogoFileError(
      "unsafe_svg",
      "SVG 不允许脚本事件或 style 属性"
    );
  }
  if (localName === "href") {
    const normalized = value.trim();
    if (!normalized.startsWith("#") || normalized.length === 1) {
      throw new SiteLogoFileError("unsafe_svg", "SVG 只能引用文档内部资源");
    }
  }

  for (const match of value.matchAll(/url\s*\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
    const target = match[2]?.trim() ?? "";
    if (!target.startsWith("#") || target.length === 1) {
      throw new SiteLogoFileError("unsafe_svg", "SVG 只能引用文档内部资源");
    }
  }

  if (
    /(?:javascript:|vbscript:|data:|file:|https?:|\/\/|@import|expression\s*\()/i.test(
      value
    )
  ) {
    throw new SiteLogoFileError("unsafe_svg", "SVG 包含不允许的外部或脚本引用");
  }
}

/**
 * 使用 XML 解析器校验 SVG 的元素、命名空间、属性引用和资源规模。
 *
 * @param source - 已通过 UTF-8 解码的 SVG 文本。
 * @returns 无返回值；通过后原文仍保持不变。
 * @throws SiteLogoFileError - XML 非法、元素不在白名单或包含主动内容时失败。
 */
function assertSafeSvg(source: string): void {
  if (source.length === 0 || source.length > MAX_SITE_LOGO_UPLOAD_BYTES) {
    throw new SiteLogoFileError("unsafe_svg", "SVG 文件大小无效");
  }

  let elementCount = 0;
  let rootSeen = false;
  let rootWidth: string | undefined;
  let rootHeight: string | undefined;
  let rootViewBox: string | undefined;
  const parser = new SaxesParser({ xmlns: true, fragment: false });
  parser.on("doctype", () => {
    throw new SiteLogoFileError("unsafe_svg", "SVG 不允许 DOCTYPE 或实体声明");
  });
  parser.on("processinginstruction", () => {
    throw new SiteLogoFileError("unsafe_svg", "SVG 不允许处理指令");
  });
  parser.on("opentag", (tag) => {
    elementCount += 1;
    if (elementCount > MAX_SITE_LOGO_SVG_ELEMENTS) {
      throw new SiteLogoFileError("unsafe_svg", "SVG 元素数量超过安全上限");
    }
    if (!isAllowedSvgElement(tag.local)) {
      throw new SiteLogoFileError("unsafe_svg", "SVG 包含不允许的元素");
    }
    if (tag.uri !== SVG_NAMESPACE) {
      throw new SiteLogoFileError(
        "unsafe_svg",
        "SVG 元素必须使用标准 SVG 命名空间"
      );
    }
    if (!rootSeen) {
      rootSeen = true;
      if (tag.local !== "svg") {
        throw new SiteLogoFileError("unsafe_svg", "SVG 根元素无效");
      }
    }
    for (const attribute of Object.values(tag.attributes)) {
      if (attribute.name === "xmlns" || attribute.prefix === "xmlns") continue;
      assertSafeSvgAttribute(attribute.name, attribute.value);
      if (tag.local === "svg") {
        if (attribute.local === "width") rootWidth = attribute.value;
        if (attribute.local === "height") rootHeight = attribute.value;
        if (attribute.local === "viewBox") rootViewBox = attribute.value;
      }
    }
  });
  try {
    parser.write(source).close();
  } catch (cause) {
    if (cause instanceof SiteLogoFileError) throw cause;
    throw new SiteLogoFileError("unsafe_svg", "SVG XML 结构无效", { cause });
  }
  if (!rootSeen) {
    throw new SiteLogoFileError("unsafe_svg", "SVG 缺少根元素");
  }

  const hasViewBox = Boolean(rootViewBox?.trim());
  const hasValidSize = [rootWidth, rootHeight].every(
    (value) =>
      value === undefined ||
      /^(?:\d+(?:\.\d+)?(?:px)?|\d+(?:\.\d+)?%)$/.test(value.trim())
  );
  if (!hasValidSize || (!hasViewBox && (!rootWidth || !rootHeight))) {
    throw new SiteLogoFileError(
      "unsafe_svg",
      "SVG 必须使用像素或 viewBox 尺寸"
    );
  }
}

/** 使用 Sharp 读取 PNG 或 SVG 的真实尺寸和静态页数。 */
async function assertStaticImageMetadata(
  bytes: Buffer,
  format: "png" | "svg"
): Promise<{ width: number; height: number }> {
  try {
    const metadata = await sharp(bytes, {
      failOn: "warning",
      ...(format === "svg" ? { density: 72 } : {}),
      limitInputPixels: MAX_SITE_LOGO_INPUT_PIXELS,
    }).metadata();
    if (metadata.format !== format || (metadata.pages ?? 1) !== 1) {
      throw new SiteLogoFileError("invalid_image", "Logo 必须是单页静态图片");
    }
    if (
      !metadata.width ||
      !metadata.height ||
      metadata.width > MAX_SITE_LOGO_DIMENSION ||
      metadata.height > MAX_SITE_LOGO_DIMENSION ||
      metadata.width * metadata.height > MAX_SITE_LOGO_INPUT_PIXELS
    ) {
      throw new SiteLogoFileError("invalid_image", "Logo 图片尺寸超过安全上限");
    }
    return { width: metadata.width, height: metadata.height };
  } catch (cause) {
    if (cause instanceof SiteLogoFileError) throw cause;
    throw new SiteLogoFileError(
      "invalid_image",
      `Logo ${format.toUpperCase()} 无法解码`,
      { cause }
    );
  }
}

/** 读取小端无符号 16 位整数，越界时返回 null。 */
function readUInt16(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 2 > bytes.byteLength) return null;
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

/** 读取小端无符号 32 位整数，越界时返回 null。 */
function readUInt32(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 4 > bytes.byteLength) return null;
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

/**
 * 校验 ICO 目录和每个帧的边界；不解码、不重排帧，确保浏览器收到原始 ICO。
 *
 * @param bytes - ICO 原始字节。
 * @returns 无返回值；至少一个 PNG 或标准 DIB 帧通过结构校验。
 * @throws SiteLogoFileError - 目录越界、帧声明溢出或没有可识别帧时失败。
 */
async function assertValidIco(bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength < 6) {
    throw new SiteLogoFileError("invalid_ico", "ICO 文件头不完整");
  }
  const count = readUInt16(bytes, 4);
  if (!count || count > 64) {
    throw new SiteLogoFileError("invalid_ico", "ICO 帧数量超出安全上限");
  }
  const directoryEnd = 6 + count * 16;
  if (directoryEnd > bytes.byteLength) {
    throw new SiteLogoFileError("invalid_ico", "ICO 目录超出文件范围");
  }
  let supportedFrame = false;
  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16;
    const width = bytes[entry] === 0 ? 256 : (bytes[entry] ?? 0);
    const height = bytes[entry + 1] === 0 ? 256 : (bytes[entry + 1] ?? 0);
    const size = readUInt32(bytes, entry + 8);
    const offset = readUInt32(bytes, entry + 12);
    if (!size || offset === null || width > 256 || height > 256) {
      throw new SiteLogoFileError("invalid_ico", "ICO 帧目录无效");
    }
    if (offset < directoryEnd || size > bytes.byteLength - offset) {
      throw new SiteLogoFileError("invalid_ico", "ICO 帧超出文件范围");
    }
    const frame = bytes.subarray(offset, offset + size);
    if (hasPngSignature(frame)) {
      const metadata = await assertStaticImageMetadata(
        Buffer.from(frame),
        "png"
      );
      if (metadata.width !== width || metadata.height !== height) {
        throw new SiteLogoFileError(
          "invalid_ico",
          "ICO PNG 帧尺寸与目录不一致"
        );
      }
      supportedFrame = true;
      continue;
    }
    const headerSize = readUInt32(frame, 0);
    const dibWidth = readUInt32(frame, 4);
    const dibHeight = readUInt32(frame, 8);
    const planes = readUInt16(frame, 12);
    const bitCount = readUInt16(frame, 14);
    const compression = readUInt32(frame, 16);
    if (
      headerSize !== 40 ||
      dibWidth !== width ||
      dibHeight !== height * 2 ||
      planes !== 1 ||
      !bitCount ||
      ![1, 4, 8, 24, 32].includes(bitCount) ||
      compression !== 0
    ) {
      throw new SiteLogoFileError("invalid_ico", "ICO 仅支持标准未压缩帧");
    }
    const paletteBytes = bitCount <= 8 ? (1 << bitCount) * 4 : 0;
    const xorStride = Math.ceil((width * bitCount) / 32) * 4;
    const maskStride = Math.ceil(width / 32) * 4;
    const required =
      headerSize + paletteBytes + (xorStride + maskStride) * height;
    if (required > frame.byteLength) {
      throw new SiteLogoFileError("invalid_ico", "ICO DIB 帧数据不完整");
    }
    supportedFrame = true;
  }
  if (!supportedFrame) {
    throw new SiteLogoFileError(
      "unsupported_format",
      "ICO 不包含可识别的图像帧"
    );
  }
}

/**
 * 校验管理员上传的 Logo，并返回原始字节的内容寻址信息。
 *
 * @param input - 已通过 UOL schema 的文件输入；声明 MIME 不决定实际格式。
 * @returns 原始文件字节、SHA-256、格式、扩展名和固定响应 MIME。
 * @throws SiteLogoFileError - 空文件、超限、伪造格式、危险 SVG 或损坏 ICO 时失败。
 * @sideEffects 仅在 Sharp 中读取内存字节，不写数据库或对象存储。
 */
export async function validateSiteLogoFile(
  input: Pick<SiteLogoUploadInput, "bytes">
): Promise<ValidatedSiteLogoFile> {
  if (input.bytes.byteLength === 0) {
    throw new SiteLogoFileError("empty", "Logo 文件不能为空");
  }
  if (input.bytes.byteLength > MAX_SITE_LOGO_UPLOAD_BYTES) {
    throw new SiteLogoFileError("too_large", "Logo 文件不能超过 5 MB");
  }
  const bytes = Uint8Array.from(input.bytes);
  if (hasPngSignature(bytes)) {
    await assertStaticImageMetadata(Buffer.from(bytes), "png");
    return {
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      format: "png",
      contentType: "image/png",
      extension: "png",
    };
  }
  if (hasIcoSignature(bytes)) {
    await assertValidIco(bytes);
    return {
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      format: "ico",
      contentType: "image/x-icon",
      extension: "ico",
    };
  }
  const source = decodeSvgText(bytes);
  if (source !== null && /<svg(?:\s|>)/i.test(source)) {
    assertSafeSvg(source);
    await assertStaticImageMetadata(Buffer.from(bytes), "svg");
    return {
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      format: "svg",
      contentType: "image/svg+xml",
      extension: "svg",
    };
  }
  throw new SiteLogoFileError(
    "unsupported_format",
    "Logo 仅支持 PNG、SVG 或 ICO"
  );
}
