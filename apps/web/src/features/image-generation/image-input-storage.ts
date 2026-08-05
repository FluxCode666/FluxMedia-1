/**
 * 同步图片请求的轻量输入转存层。
 *
 * 职责：在进入本地等待队列前实际复验 data、storage、remote 引用，并把非存储来源
 * 转成当前用户拥有的 storage-only 清单。队列只保存清单，实际 Buffer 在取得全站槽
 * 后由 `media-input-loader` 重新读取。
 */

import { createHash, randomUUID } from "node:crypto";
import {
  type MediaInputReference,
  mediaInputReferencesSchema,
} from "@repo/shared/image-generation/media-contract";
import { getStorageRuntimeSnapshot } from "@repo/shared/storage/providers";

import { type LoadedMediaInput, loadMediaInputs } from "./media-input-loader";

const IMAGE_INPUT_STAGING_TIMEOUT_MS = 5 * 60_000;

/** 本轮同步请求新建、尚未被 generation 记录采用的输入对象。 */
export interface StagedImageInputObject {
  userId: string;
  storageKey: string;
  storageBucket: string;
}

/** 队列使用的 storage-only 清单及其临时所有权。 */
export interface StagedImageInputSet {
  references: MediaInputReference[];
  objects: StagedImageInputObject[];
}

/** MIME 到安全对象扩展名的稳定映射。 */
function getMediaExtension(mimeType: MediaInputReference["mimeType"]): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

/** 根据图片魔数识别共享图片契约允许的实际 MIME。 */
function detectMediaMimeType(
  bytes: Buffer
): MediaInputReference["mimeType"] | null {
  if (
    bytes.length >= 8 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/** 用摘要隔离 generationId，并用 attempt 隔离同 ID 的并发请求。 */
function createImageInputStorageKey(input: {
  userId: string;
  generationId: string;
  attemptId: string;
  index: number;
  digest: string;
  extension: string;
}): string {
  const generationDigest = createHash("sha256")
    .update(input.generationId)
    .digest("hex")
    .slice(0, 32);
  return `${input.userId}/image-inputs/${generationDigest}/${input.attemptId}/input-${input.index}-${input.digest}.${input.extension}`;
}

/** 尽力删除本轮已写入但转存整体失败的对象，并把清理失败显式聚合上抛。 */
async function cleanupFailedUploads(input: {
  provider: Awaited<ReturnType<typeof getStorageRuntimeSnapshot>>["provider"];
  bucket: string;
  objects: StagedImageInputObject[];
  cause: unknown;
}): Promise<never> {
  const cleanupResults = await Promise.allSettled(
    input.objects.map((object) =>
      input.provider.deleteObject(object.storageKey, input.bucket)
    )
  );
  const cleanupErrors = cleanupResults.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  );
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [input.cause, ...cleanupErrors],
      "图片输入转存失败且即时清理未完成"
    );
  }
  throw input.cause;
}

/**
 * 删除尚未被 generation 采用的同步图片输入对象。
 *
 * @param objects 仅允许来自本模块 staging 结果的对象所有权清单。
 * @returns 无；空清单不访问存储服务。
 * @sideEffects 并行删除当前存储 bucket 中的临时输入对象。
 * @throws bucket 或用户前缀不匹配、存储删除失败时显式拒绝。
 */
export async function cleanupStagedImageInputs(
  objects: StagedImageInputObject[]
): Promise<void> {
  if (objects.length === 0) return;
  const snapshot = await getStorageRuntimeSnapshot();
  for (const object of objects) {
    if (
      object.storageBucket !== snapshot.bucketName ||
      !object.storageKey.startsWith(`${object.userId}/image-inputs/`)
    ) {
      throw new Error("同步图片输入清理对象不属于当前 staging 空间");
    }
  }
  const results = await Promise.allSettled(
    objects.map((object) =>
      snapshot.provider.deleteObject(object.storageKey, object.storageBucket)
    )
  );
  const errors = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  );
  if (errors.length > 0) {
    throw new AggregateError(errors, "同步图片输入对象清理未完成");
  }
}

/**
 * 在同步图片输入被 generation 采用前维持临时所有权。
 *
 * @param input 临时对象以及会在 generation 持久化后确认采用的执行函数。
 * @returns 执行函数的原始结果。
 * @sideEffects 未确认采用时删除本轮 staging 对象。
 * @throws 执行或清理失败时显式上抛；采用后的执行错误不会误删历史输入。
 */
export async function withStagedImageInputOwnership<Result>(input: {
  objects: StagedImageInputObject[];
  run: (markAdopted: () => void) => Promise<Result>;
}): Promise<Result> {
  let adopted = false;
  try {
    return await input.run(() => {
      adopted = true;
    });
  } finally {
    if (!adopted) {
      await cleanupStagedImageInputs(input.objects);
    }
  }
}

/**
 * 复验并转存一组同步图片引用。
 *
 * @param input 当前用户、幂等 generationId 与已通过 UOL schema 的引用。
 * @returns 顺序不变的 storage-only 引用及本轮新建对象；合法 storage 不重复复制。
 * @sideEffects 读取存储/远程输入，并为 data/remote 来源写入当前对象存储。
 * @throws 归属、SSRF、MIME、字节、上传或失败清理异常时显式拒绝。
 */
export async function stageImageInputReferences(input: {
  userId: string;
  generationId: string;
  references: MediaInputReference[];
}): Promise<StagedImageInputSet> {
  const references = mediaInputReferencesSchema.parse(input.references);
  if (references.length === 0) return { references: [], objects: [] };
  const signal = AbortSignal.timeout(IMAGE_INPUT_STAGING_TIMEOUT_MS);
  const loaded = await loadMediaInputs({
    userId: input.userId,
    references,
    signal,
  });
  if (loaded.length !== references.length) {
    throw new Error("图片输入加载结果数量不一致");
  }
  for (const [index, reference] of references.entries()) {
    const media = loaded[index] as LoadedMediaInput;
    if (media.data.byteLength !== reference.byteLength) {
      throw new Error("图片输入字节数与声明不一致");
    }
    if (detectMediaMimeType(media.data) !== reference.mimeType) {
      throw new Error("图片输入实际 MIME 与声明不一致");
    }
  }

  const snapshot = await getStorageRuntimeSnapshot();
  const attemptId = randomUUID();
  const objects: StagedImageInputObject[] = [];
  const persisted: MediaInputReference[] = [];
  try {
    for (const [index, reference] of references.entries()) {
      const media = loaded[index] as LoadedMediaInput;
      if (
        reference.source === "storage" &&
        media.storageKey &&
        media.storageBucket
      ) {
        persisted.push({
          source: "storage",
          mimeType: reference.mimeType,
          storageKey: media.storageKey,
          storageBucket: media.storageBucket,
          byteLength: media.data.byteLength,
        });
        continue;
      }
      const digest = createHash("sha256")
        .update(media.data)
        .digest("hex")
        .slice(0, 32);
      const storageKey = createImageInputStorageKey({
        userId: input.userId,
        generationId: input.generationId,
        attemptId,
        index,
        digest,
        extension: getMediaExtension(reference.mimeType),
      });
      await snapshot.provider.putObject(
        storageKey,
        snapshot.bucketName,
        media.data,
        reference.mimeType,
        { signal }
      );
      objects.push({
        userId: input.userId,
        storageKey,
        storageBucket: snapshot.bucketName,
      });
      persisted.push({
        source: "storage",
        mimeType: reference.mimeType,
        storageKey,
        storageBucket: snapshot.bucketName,
        byteLength: media.data.byteLength,
      });
    }
    return {
      references: mediaInputReferencesSchema.parse(persisted),
      objects,
    };
  } catch (error) {
    return cleanupFailedUploads({
      provider: snapshot.provider,
      bucket: snapshot.bucketName,
      objects,
      cause: error,
    });
  }
}
