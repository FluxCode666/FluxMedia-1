/**
 * 输入图 re-host（转存）到我方对象存储。
 *
 * 职责：在确定走 api 后端（pool-api）后、构造 Images API 请求之前，确保每张
 * 输入图都是"我方可控的 URL"，避免把第三方外链交给上游——上游下载外链会被图床
 * 限流返回 "failed download file 429" 导致整单失败。
 *
 * 使用方：service.ts 的 generateImage / editImage 在 pool-api
 * 分支执行前调用（见 rehostApiBackendInputImages）。
 * 关键依赖：
 * - @repo/shared/storage/providers getStorageProvider().putObject
 * - @repo/shared/storage/signed-url parseStorageImageUrl / buildSignedStorageImageUrl
 * - @repo/shared/system-settings getRuntimeSettingString（取存储桶/启用判定）
 * - external-api/safe-image-fetch fetchPublicImage（带 SSRF 防护 + 429/5xx 重试）
 *
 * 失败语义：任何失败都不抛出、不中断主流程，仅 logWarn 记录——有字节则保留字节
 * （交给 getInputImageUrl 走 base64），无字节则保留原 url（best-effort）。
 */
import { logWarn } from "@repo/shared/logger";
import { getStorageProvider } from "@repo/shared/storage/providers";
import {
  buildPublicImageUrl,
  buildSignedStorageImageUrl,
  parseStorageImageUrl,
} from "@repo/shared/storage/signed-url";
import { getRuntimeStorageBucketConfig } from "@repo/shared/system-settings";
import {
  fetchPublicImage,
  readResponseBytesWithLimit,
} from "../external-api/safe-image-fetch";
import {
  DEFAULT_MAX_IMAGE_BYTES,
  getImagePublicBaseUrl,
} from "./request-utils";
import type { ImageInputFile } from "./types";

/**
 * 根据 MIME 类型推断对象存储文件扩展名（与 request-utils 保持一致）。
 */
function extensionForType(type: string): string {
  if (type === "image/jpeg") return "jpg";
  if (type === "image/webp") return "webp";
  return "png";
}

/**
 * 把外链字节流读入 Buffer，受 DEFAULT_MAX_IMAGE_BYTES 上限保护。
 *
 * @returns 读取到的字节与最终 MIME 类型；下载失败或非图片时抛出由调用方兜底。
 */
async function downloadImageBytes(
  url: string,
  signal?: AbortSignal
): Promise<{ data: Buffer; type: string }> {
  const response = await fetchPublicImage(url, { signal });
  if (!response.ok) {
    throw new Error(
      `Input image download failed with status ${response.status}`
    );
  }
  const type = response.headers.get("content-type") || "image/png";
  const data = await readResponseBytesWithLimit(
    response,
    DEFAULT_MAX_IMAGE_BYTES,
    () => {
      throw new Error("Input image exceeds the maximum allowed size.");
    }
  );
  return { data, type };
}

export type RehostContext = {
  /** 请求用户 id，用作对象存储 key 前缀（隔离不同用户）。 */
  userId: string;
  /** 本次生成 id，参与 key 命名以保证唯一。 */
  generationId: string;
  /** key 命名作用域，默认 "rehost"。 */
  scope?: string;
  /** 第几张图，参与 key 命名避免同一生成内冲突。 */
  index?: number;
  /** 透传给下载的 abort 信号。 */
  signal?: AbortSignal;
};

/**
 * 将输入图上的引用解析为供应商可访问的绝对 HTTP(S) URL。
 *
 * 优先使用 storageKey/storageBucket 重新签名，避免旧的相对 URL 或已过期签名被
 * 直接转发；普通相对站内 URL 也会使用运行时公开基址补成绝对地址。
 */
export async function resolveInputImagePublicUrl(
  image: ImageInputFile,
  expiresInSeconds = 3600
): Promise<string | null> {
  const rawUrl = image.url?.trim();
  if (rawUrl?.startsWith("//") || rawUrl?.toLowerCase().startsWith("data:")) {
    return null;
  }
  let publicBaseUrl: string;
  try {
    publicBaseUrl = await getImagePublicBaseUrl();
  } catch (error) {
    logWarn("无法读取图片公网基址，拒绝向供应商发送参考图 URL", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  if (image.storageKey?.trim() && image.storageBucket?.trim()) {
    let signed: string | null = null;
    try {
      signed = buildSignedStorageImageUrl(
        image.storageKey,
        image.storageBucket,
        expiresInSeconds
      );
    } catch (error) {
      logWarn("无法为参考图生成签名 URL，拒绝向供应商发送", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    const absolute = signed
      ? buildPublicImageUrl(signed, publicBaseUrl, expiresInSeconds)
      : undefined;
    if (absolute && /^https?:\/\//iu.test(absolute)) return absolute;
  }

  // 协议相对地址、data URL 和本地路径都不是供应商可验证的绝对 HTTP(S) 引用；
  // 只有带公开基址的站内相对路径才允许继续由 buildPublicImageUrl 解析。
  const resolved = buildPublicImageUrl(rawUrl, publicBaseUrl, expiresInSeconds);
  if (resolved && /^https?:\/\//iu.test(resolved)) return resolved;
  return null;
}

/** 判断输入图是否已经属于平台对象存储，供“必须先转存”模式 fail-closed。 */
export async function isInputImagePlatformHosted(
  image: ImageInputFile
): Promise<boolean> {
  if (image.storageKey?.trim() && image.storageBucket?.trim()) return true;
  let publicBaseUrl: string;
  try {
    publicBaseUrl = await getImagePublicBaseUrl();
  } catch (error) {
    logWarn("无法读取图片公网基址，无法确认参考图是否已转存", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
  return Boolean(
    image.url?.trim() && parseStorageImageUrl(image.url.trim(), publicBaseUrl)
  );
}

/**
 * 确保单张输入图已 re-host 到我方存储（幂等、不抛出）。
 *
 * 决策：
 * - 已有 storageKey → 直接返回（已是我方对象，无需处理）；
 * - image.url 为第一方站内 URL → 直接返回（已可控）；
 * - 否则需转存：优先用 image.data 字节，无字节则下载 image.url；拿到字节后
 *   putObject 到 generations 桶并回填 storageKey/storageBucket/url（站内签名）。
 *
 * @param image 待处理输入图（不修改入参，返回新对象或原对象）。
 * @param ctx re-host 上下文（userId/generationId/scope/index/signal）。
 * @returns 处理后的 ImageInputFile；失败时按"有字节保留字节、无字节保留 url"兜底。
 * @remarks 失败只 logWarn，不抛出，保证主流程不中断。
 */
export async function ensureInputImageRehosted(
  image: ImageInputFile,
  ctx: RehostContext
): Promise<ImageInputFile> {
  // 已是我方存储对象。
  if (image.storageKey?.trim()) return image;

  const publicBaseUrl = await getImagePublicBaseUrl();
  const trimmedUrl = image.url?.trim();

  // 已是第一方站内 URL，可控，无需转存。
  if (trimmedUrl && parseStorageImageUrl(trimmedUrl, publicBaseUrl)) {
    return image;
  }

  const index = ctx.index ?? 0;
  const scope = ctx.scope || "rehost";

  try {
    let bytes = image.data?.length ? image.data : null;
    let contentType = image.type || "image/png";

    if (!bytes) {
      if (!trimmedUrl) {
        // 既无字节也无 url，无从转存，保持原样。
        return image;
      }
      const downloaded = await downloadImageBytes(trimmedUrl, ctx.signal);
      bytes = downloaded.data;
      contentType = downloaded.type;
    }

    const storage = await getStorageProvider();
    const { generations: bucket } = await getRuntimeStorageBucketConfig();
    const extension = extensionForType(contentType);
    const key = `${ctx.userId}/${scope}/${ctx.generationId}-${index}.${extension}`;

    await storage.putObject(key, bucket, bytes, contentType);

    return {
      ...image,
      data: bytes,
      type: contentType,
      storageBucket: bucket,
      storageKey: key,
      url: buildSignedStorageImageUrl(key, bucket) || image.url,
    };
  } catch (error) {
    logWarn("输入图 re-host 失败，回退到字节/原 URL", {
      userId: ctx.userId,
      generationId: ctx.generationId,
      index,
      hasBytes: Boolean(image.data?.length),
      error: error instanceof Error ? error.message : String(error),
    });
    return image;
  }
}
