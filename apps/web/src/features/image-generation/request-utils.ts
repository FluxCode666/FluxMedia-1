import {
  type MediaInputReference,
  mediaInputReferenceSchema,
} from "@repo/shared/image-generation/media-contract";
import { logWarn } from "@repo/shared/logger";
import { getStorageProvider } from "@repo/shared/storage/providers";
import { getRuntimeSettingString } from "@repo/shared/system-settings";
import sharp from "sharp";
import type { ImageInputFile } from "./types";

export const DEFAULT_MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const TEMP_IMAGE_UPLOAD_URL_EXPIRES = 15 * 60;
export const VALID_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export type TemporaryUploadedImage = {
  bucket: string;
  key: string;
  url: string;
};

type ImageDimensions = {
  width: number;
  height: number;
};

export async function getImagePublicBaseUrl() {
  return (
    (await getRuntimeSettingString("CONTENT_MODERATION_PUBLIC_BASE_URL")) ||
    (await getRuntimeSettingString("NEXT_PUBLIC_APP_URL")) ||
    (await getRuntimeSettingString("BETTER_AUTH_URL")) ||
    ""
  ).replace(/\/$/, "");
}

function toAbsoluteImageUrl(url: string, publicBaseUrl: string) {
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (!publicBaseUrl) return url;
  return `${publicBaseUrl}${url.startsWith("/") ? "" : "/"}${url}`;
}

export function formatMegabytes(bytes: number) {
  return `${bytes / 1024 / 1024}MB`;
}

export function validateImageFile(
  file: File,
  options?: {
    mask?: boolean;
    maxImageBytes?: number;
    label?: string;
    invalidTypeMessage?: string;
  }
) {
  const label =
    options?.label || file.name || (options?.mask ? "Mask" : "Image");
  if (file.size <= 0) {
    throw new Error(`${label} is empty.`);
  }

  const maxImageBytes = options?.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  if (file.size > maxImageBytes) {
    throw new Error(
      `${label} exceeds the ${formatMegabytes(maxImageBytes)} limit.`
    );
  }

  if (options?.mask) {
    if (file.type !== "image/png") {
      throw new Error(options.invalidTypeMessage || "Mask must be a PNG file.");
    }
    return;
  }

  if (!VALID_IMAGE_TYPES.has(file.type)) {
    throw new Error(
      options?.invalidTypeMessage ||
        "Source images must be PNG, JPEG, or WebP files."
    );
  }
}

export function getTotalUploadSize(files: File[], maskFile?: File) {
  return (
    files.reduce((total, file) => total + file.size, 0) + (maskFile?.size || 0)
  );
}

/**
 * 解码上传图片并返回其原始像素尺寸。
 *
 * 只依赖 MIME 类型会允许伪造文件进入对象存储；读取元数据后再生成 1px 缩略图，
 * 既能取得原始尺寸，也会实际解码图像数据而不为尺寸校验分配整张图片的像素缓冲。
 *
 * @throws 当文件不能被安全解码，或图片未包含有效尺寸时抛出面向用户的错误。
 */
async function decodeImageDimensions(
  file: File,
  label: string
): Promise<ImageDimensions> {
  try {
    const input = Buffer.from(await file.arrayBuffer());
    const metadata = await sharp(input, { failOn: "warning" }).metadata();
    const width = metadata.width;
    const height = metadata.height;

    if (!width || !height) {
      throw new Error("Image dimensions are unavailable.");
    }

    await sharp(input, { failOn: "warning" })
      .resize({
        width: 1,
        height: 1,
        fit: "inside",
        withoutEnlargement: true,
      })
      .raw()
      .toBuffer();

    return { width, height };
  } catch {
    throw new Error(`${label} must be a decodable image file.`);
  }
}

/**
 * 校验局部重绘蒙版与第一张源图使用同一像素坐标系。
 *
 * 编辑接口允许历史多图编辑，因此只在调用方实际携带蒙版时比较第一张源图；
 * 其余源图不增加尺寸限制，维持既有多图编辑语义。
 *
 * @throws 当源图或蒙版不能解码，或二者宽高不一致时抛出错误。
 */
export async function validateMaskMatchesSourceImage(
  sourceFile: File,
  maskFile: File
) {
  const [sourceDimensions, maskDimensions] = await Promise.all([
    decodeImageDimensions(sourceFile, "First source image"),
    decodeImageDimensions(maskFile, "Mask"),
  ]);

  if (
    sourceDimensions.width !== maskDimensions.width ||
    sourceDimensions.height !== maskDimensions.height
  ) {
    throw new Error("Mask dimensions must match the first source image.");
  }
}

export async function toImageInput(
  file: File,
  options?: { publicUrl?: string; storageBucket?: string; storageKey?: string }
): Promise<ImageInputFile> {
  return {
    data: Buffer.from(await file.arrayBuffer()),
    name: file.name || "image.png",
    type: file.type || "image/png",
    url: options?.publicUrl,
    storageBucket: options?.storageBucket,
    storageKey: options?.storageKey,
  };
}

export async function uploadTemporaryImageUrls(
  userId: string,
  generationId: string,
  files: File[],
  options?: { scope?: string }
): Promise<TemporaryUploadedImage[] | undefined> {
  if (files.length === 0) return undefined;

  try {
    const publicBaseUrl = await getImagePublicBaseUrl();
    if (
      !(await getRuntimeSettingString("STORAGE_ENDPOINT")) &&
      !publicBaseUrl
    ) {
      return undefined;
    }

    const storage = await getStorageProvider();
    const bucket =
      (await getRuntimeSettingString("NEXT_PUBLIC_GENERATIONS_BUCKET_NAME")) ||
      "generations";

    return await Promise.all(
      files.map(async (file, index) => {
        const extension =
          file.type === "image/jpeg"
            ? "jpg"
            : file.type === "image/webp"
              ? "webp"
              : "png";
        const scope = options?.scope || "requests";
        const key = `${userId}/${scope}/${generationId}-${index}.${extension}`;
        await storage.putObject(
          key,
          bucket,
          Buffer.from(await file.arrayBuffer()),
          file.type || "image/png"
        );
        const url = await storage.getSignedUrl(
          key,
          bucket,
          TEMP_IMAGE_UPLOAD_URL_EXPIRES
        );
        return {
          bucket,
          key,
          url: toAbsoluteImageUrl(url, publicBaseUrl),
        };
      })
    );
  } catch (error) {
    logWarn("临时图片 URL 上传失败，回退到 base64 输入", {
      generationId,
      fileCount: files.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export const uploadModerationImages = uploadTemporaryImageUrls;

export async function deleteTemporaryImages(
  images: TemporaryUploadedImage[] | undefined
) {
  if (!images?.length) return;

  const storage = await getStorageProvider();
  await Promise.allSettled(
    images.map((image) => storage.deleteObject(image.key, image.bucket))
  );
}

export const deleteModerationImages = deleteTemporaryImages;

export async function filesToImageInputs(
  files: File[],
  uploadedImages?: TemporaryUploadedImage[]
) {
  return await Promise.all(
    files.map((file, index) =>
      toImageInput(file, {
        publicUrl: uploadedImages?.[index]?.url,
        storageBucket: uploadedImages?.[index]?.bucket,
        storageKey: uploadedImages?.[index]?.key,
      })
    )
  );
}

/**
 * 将已校验上传文件转换为 UOL JSON-safe 引用。
 *
 * 已上传临时对象优先使用 storage 引用，避免再次 base64 编解码并保留历史引用元数据；
 * 存储降级时才内联 data 引用。返回值再次经过共享 schema 校验。
 */
export async function filesToMediaInputReferences(
  files: File[],
  uploadedImages?: TemporaryUploadedImage[]
): Promise<MediaInputReference[]> {
  return Promise.all(
    files.map(async (file, index) => {
      const uploaded = uploadedImages?.[index];
      if (uploaded) {
        return mediaInputReferenceSchema.parse({
          source: "storage",
          mimeType: file.type || "image/png",
          storageKey: uploaded.key,
          storageBucket: uploaded.bucket,
          byteLength: file.size,
        });
      }
      const data = Buffer.from(await file.arrayBuffer());
      return mediaInputReferenceSchema.parse({
        source: "data",
        mimeType: file.type || "image/png",
        base64: data.toString("base64"),
        byteLength: data.byteLength,
      });
    })
  );
}
