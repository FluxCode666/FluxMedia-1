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
  type MediaInputReference,
} from "@repo/shared/image-generation/media-contract";
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
}

/** 校验实际 MIME，防止宣称为图片的 HTML 或其他载荷进入上游。 */
function assertExpectedMimeType(expected: string, actual: string | null): void {
  const normalized = actual?.split(";", 1)[0]?.trim().toLowerCase();
  if (normalized && normalized !== expected) {
    throw new SafeImageFetchError("Media MIME type does not match request.");
  }
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
}): Promise<LoadedMediaInput[]> {
  const loaded: LoadedMediaInput[] = [];
  let totalBytes = 0;
  let storageSnapshot:
    | Awaited<ReturnType<typeof getStorageRuntimeSnapshot>>
    | undefined;

  const addLoaded = (data: Buffer, type: string): void => {
    totalBytes += data.byteLength;
    if (totalBytes > MAX_MEDIA_INPUT_BYTES) {
      throw new SafeImageFetchError("Media input exceeds the byte limit.");
    }
    loaded.push({ data, type });
  };

  for (const reference of input.references) {
    if (reference.source === "data") {
      const data = Buffer.from(reference.base64, "base64");
      if (data.byteLength !== reference.byteLength) {
        throw new SafeImageFetchError(
          "Media byte length does not match request."
        );
      }
      addLoaded(data, reference.mimeType);
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
      addLoaded(data, reference.mimeType);
      continue;
    }

    const response = await fetchPublicImage(reference.url, {
      ...(input.signal ? { signal: input.signal } : {}),
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
      remainingBytes,
      () => {
        throw new SafeImageFetchError("Media input exceeds the byte limit.");
      }
    );
    addLoaded(data, reference.mimeType);
  }

  return loaded;
}
