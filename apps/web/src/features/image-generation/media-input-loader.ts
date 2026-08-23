/**
 * UOL 媒体引用的服务端加载器。
 *
 * 职责：将经过共享 schema 校验的 data、storage 或 remote 图片引用转成
 * 媒体适配器可消费的 Buffer，并在真实读取后重新校验字节、MIME、存储归属
 * 和远程 URL 安全性。
 * 使用方：图片与视频 UOL binding；不接受原始未校验输入。
 */

import {
  MAX_MEDIA_INPUT_BYTES,
  MAX_MEDIA_INPUT_FILE_BYTES,
  MAX_REFERENCE_AUDIO_BYTES,
  type MediaInputReference,
} from "@repo/shared/image-generation/media-contract";
import type { DnsPinFetchOptions } from "@repo/shared/security/dns-pin";
import { getStorageRuntimeSnapshot } from "@repo/shared/storage/providers";

import {
  fetchPublicImage,
  readResponseBytesWithLimit,
  SafeImageFetchError,
} from "@/features/external-api/safe-image-fetch";

/** 媒体适配器消费的实际图片字节。 */
export interface LoadedMediaInput {
  data: Buffer;
  type: string;
  storageKey?: string;
  storageBucket?: string;
}

/**
 * 解析视频参考媒体的保留地址例外策略。
 *
 * 例外只对 `VIDEO_REFERENCE_MEDIA_ALLOW_RESERVED_ADDRESSES` 中列出的精确主机名
 * 生效，且只由视频参考视频/音频调用。默认不放行任何保留地址，避免把普通图片、回调
 * 或任意远程媒体输入变成 SSRF 入口。
 *
 * @param reference - 待读取的媒体引用。
 * @returns 连接层地址判断函数；未配置或非视频/音频远程引用时返回 undefined。
 */
export function getVideoReferenceMediaAddressPolicy(
  reference: MediaInputReference
): DnsPinFetchOptions["allowBlockedAddress"] | undefined {
  if (
    reference.source !== "remote" ||
    (!reference.mimeType.startsWith("video/") &&
      !reference.mimeType.startsWith("audio/"))
  ) {
    return undefined;
  }
  const allowedHosts = new Set(
    (process.env.VIDEO_REFERENCE_MEDIA_ALLOW_RESERVED_ADDRESSES ?? "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean)
  );
  const hostname = new URL(reference.url).hostname.toLowerCase();
  if (!allowedHosts.has(hostname)) return undefined;
  return ({ hostname: resolvedHostname }) =>
    resolvedHostname.toLowerCase() === hostname;
}

/**
 * 累加实际读取字节并执行单文件 200 MB、请求合计 512 MB 硬上限。
 *
 * @param currentBytes 当前请求已经实际读取的字节。
 * @param nextBytes 下一项实际 Buffer 字节。
 * @returns 未超限时的新总量。
 * @sideEffects 无。
 * @throws SafeImageFetchError 单文件或总量超过共享基础设施上限时失败。
 */
export function addActualMediaInputBytes(
  currentBytes: number,
  nextBytes: number
): number {
  if (nextBytes > MAX_MEDIA_INPUT_FILE_BYTES) {
    throw new SafeImageFetchError(
      "Media input exceeds the per-file byte limit."
    );
  }
  const totalBytes = currentBytes + nextBytes;
  if (totalBytes > MAX_MEDIA_INPUT_BYTES) {
    throw new SafeImageFetchError("Media input exceeds the byte limit.");
  }
  return totalBytes;
}

/** 校验实际读取字节与请求声明一致，阻止低报大小绕过运行时策略。 */
function assertExpectedByteLength(
  expected: number | undefined,
  actual: number
): void {
  if (expected === undefined) return;
  if (actual !== expected) {
    throw new SafeImageFetchError("Media byte length does not match request.");
  }
}

/** 校验实际 MIME，防止宣称为图片的 HTML 或其他载荷进入上游。 */
function assertExpectedMimeType(expected: string, actual: string | null): void {
  const normalized = actual?.split(";", 1)[0]?.trim().toLowerCase();
  if (normalized && normalized !== expected) {
    throw new SafeImageFetchError("Media MIME type does not match request.");
  }
}

/** 返回媒体类型的更严格业务上限；未单独限制的媒体沿用共享 200 MiB 上限。 */
export function getMediaInputReferenceMaxBytes(
  reference: MediaInputReference
): number | undefined {
  if (
    reference.mimeType === "audio/mpeg" ||
    reference.mimeType === "audio/wav" ||
    reference.mimeType === "audio/x-wav"
  ) {
    return MAX_REFERENCE_AUDIO_BYTES;
  }
  return undefined;
}

/**
 * 读取一组已校验的媒体引用。
 *
 * @param input 当前所有者与 JSON-safe 媒体引用。
 * @returns 按输入顺序返回的图片字节与 MIME。
 * @throws 任一引用越权、SSRF、MIME 不匹配或实际总字节超限时失败。
 */
export async function loadMediaInputs(input: {
  userId: string;
  references: MediaInputReference[];
  signal?: AbortSignal;
  /** 按引用类型收紧单项读取上限；用于参考音频的 15 MiB 硬上限。 */
  maxBytesForReference?: (
    reference: MediaInputReference,
    index: number
  ) => number | undefined;
  /** 仅对指定引用返回受控的 DNS 保留地址例外。 */
  allowBlockedAddressForReference?: (
    reference: MediaInputReference,
    index: number
  ) => DnsPinFetchOptions["allowBlockedAddress"] | undefined;
}): Promise<LoadedMediaInput[]> {
  const loaded: LoadedMediaInput[] = [];
  let totalBytes = 0;
  let storageSnapshot:
    | Awaited<ReturnType<typeof getStorageRuntimeSnapshot>>
    | undefined;

  const addLoaded = (
    data: Buffer,
    type: string,
    expectedByteLength: number | undefined,
    storage?: Pick<LoadedMediaInput, "storageKey" | "storageBucket">
  ): void => {
    assertExpectedByteLength(expectedByteLength, data.byteLength);
    totalBytes = addActualMediaInputBytes(totalBytes, data.byteLength);
    loaded.push({ data, type, ...storage });
  };

  for (const [referenceIndex, reference] of input.references.entries()) {
    const referenceMaxBytes = input.maxBytesForReference?.(
      reference,
      referenceIndex
    );
    if (reference.source === "data") {
      const data = Buffer.from(reference.base64, "base64");
      if (
        referenceMaxBytes !== undefined &&
        data.byteLength > referenceMaxBytes
      ) {
        throw new SafeImageFetchError("Media input exceeds its type limit.");
      }
      addLoaded(data, reference.mimeType, reference.byteLength);
      continue;
    }

    if (reference.source === "storage") {
      storageSnapshot ??= await getStorageRuntimeSnapshot();
      const bucket = reference.storageBucket ?? storageSnapshot.bucketName;
      if (
        bucket !== storageSnapshot.bucketName ||
        !reference.storageKey.startsWith(`${input.userId}/`)
      ) {
        throw new SafeImageFetchError("Stored media is not owned by caller.");
      }
      const data = await storageSnapshot.provider.getObject(
        reference.storageKey,
        bucket,
        input.signal ? { signal: input.signal } : undefined
      );
      if (
        referenceMaxBytes !== undefined &&
        data.byteLength > referenceMaxBytes
      ) {
        throw new SafeImageFetchError("Media input exceeds its type limit.");
      }
      addLoaded(data, reference.mimeType, reference.byteLength, {
        storageKey: reference.storageKey,
        storageBucket: bucket,
      });
      continue;
    }

    const allowBlockedAddress = input.allowBlockedAddressForReference?.(
      reference,
      referenceIndex
    );
    const response = await fetchPublicImage(reference.url, {
      ...(input.signal ? { signal: input.signal } : {}),
      ...(allowBlockedAddress ? { allowBlockedAddress } : {}),
    });
    if (!response.ok) {
      throw new SafeImageFetchError(
        `Remote media request failed with HTTP ${response.status}.`
      );
    }
    assertExpectedMimeType(
      reference.mimeType,
      response.headers.get("content-type")
    );
    const remainingBytes = MAX_MEDIA_INPUT_BYTES - totalBytes;
    const data = await readResponseBytesWithLimit(
      response,
      Math.min(
        MAX_MEDIA_INPUT_FILE_BYTES,
        remainingBytes,
        referenceMaxBytes ?? MAX_MEDIA_INPUT_FILE_BYTES
      ),
      () => {
        throw new SafeImageFetchError("Media input exceeds the byte limit.");
      }
    );
    addLoaded(data, reference.mimeType, reference.byteLength);
  }

  return loaded;
}
