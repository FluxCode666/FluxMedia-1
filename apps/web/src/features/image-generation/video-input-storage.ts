/**
 * 视频 data 媒体引用的持久存储层。
 *
 * 职责：在任务创建前把 base64 图片转成稳定、归属受控的 storage 引用，避免大正文
 * 进入 video_generation JSON；并清理竞争失败或任务结束后的临时对象。
 * 使用方：video.generate UOL binding 与视频持久 worker。
 */
import { createHash } from "node:crypto";
import {
  type MediaInputReference,
  mediaInputReferencesSchema,
} from "@repo/shared/image-generation/media-contract";
import { getStorageRuntimeSnapshot } from "@repo/shared/storage/providers";
import {
  enqueueVideoInputCleanup,
  parseVideoInputCleanupObjects,
  type VideoInputCleanupObject,
} from "./video-input-cleanup-queue";
import { VIDEO_STAGING_RESERVATION_TTL_MS } from "./video-task-admission";

const VIDEO_INPUT_UPLOAD_COMPLETION_GRACE_MS = 5 * 60_000;
export const VIDEO_INPUT_UPLOAD_TIMEOUT_MS =
  VIDEO_STAGING_RESERVATION_TTL_MS - VIDEO_INPUT_UPLOAD_COMPLETION_GRACE_MS;

/** 本轮创建请求实际上传的临时对象。 */
export type StagedVideoInputObject = VideoInputCleanupObject;

/** data 引用持久化结果。 */
export interface StagedVideoInputReferences {
  references: MediaInputReference[];
  objects: StagedVideoInputObject[];
}

/** MIME 到安全对象扩展名的稳定映射。 */
function getMediaExtension(mimeType: MediaInputReference["mimeType"]): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

/** 临时视频输入对象只能落在当前用户和任务的隔离前缀下。 */
function createTemporaryVideoInputKey(input: {
  userId: string;
  videoId: string;
  attemptId: string;
  index: number;
  digest: string;
  extension: string;
}): string {
  return `${input.userId}/video-inputs/${input.videoId}/${input.attemptId}/${input.index}-${input.digest}.${input.extension}`;
}

/** 删除指定对象；全部删除成功才视为清理完成，便于调用方保留重试事实。 */
async function deleteStagedObjects(
  objects: StagedVideoInputObject[]
): Promise<void> {
  if (objects.length === 0) return;
  // WHY：删除前先刷新持久意图；即使进程在对象存储响应前退出，created 任务仍受
  // 保护，已经读入内存或未被任务引用的对象则由队列继续幂等删除。
  await enqueueVideoInputCleanup(objects);
  const snapshot = await getStorageRuntimeSnapshot();
  if (objects.some((object) => object.storageBucket !== snapshot.bucketName)) {
    throw new Error("视频输入清理对象不属于当前存储 bucket");
  }
  await Promise.all(
    objects.map((object) =>
      snapshot.provider.deleteObject(object.storageKey, object.storageBucket)
    )
  );
}

/**
 * 把 data 引用上传到稳定存储并替换为 storage 引用。
 *
 * 上传失败时清理已经写入的对象并原样抛错；绝不回退为数据库 base64。
 */
export async function stageVideoInputReferences(input: {
  userId: string;
  videoId: string;
  attemptId: string;
  references: MediaInputReference[];
}): Promise<StagedVideoInputReferences> {
  if (
    !input.attemptId ||
    input.attemptId.length > 128 ||
    input.attemptId.includes("/") ||
    input.attemptId.includes("..")
  ) {
    throw new Error("视频输入转存 attemptId 无效");
  }
  const parsed = mediaInputReferencesSchema.max(3).parse(input.references);
  if (
    !parsed.some(
      (reference) =>
        reference.source === "data" || reference.source === "storage"
    )
  ) {
    return { references: parsed, objects: [] };
  }

  const snapshot = await getStorageRuntimeSnapshot();
  const objects: StagedVideoInputObject[] = [];
  const references: MediaInputReference[] = [];
  // WHY：所有对象共用同一个绝对 deadline；若逐对象重置 10 分钟，三张串行上传仍
  // 可能跨过 15 分钟 reservation TTL，让清理 worker 与迟到写入重新产生竞态。
  const uploadSignal = AbortSignal.timeout(VIDEO_INPUT_UPLOAD_TIMEOUT_MS);
  try {
    for (const [index, reference] of parsed.entries()) {
      if (reference.source === "storage") {
        const bucket = reference.storageBucket ?? snapshot.bucketName;
        if (
          bucket !== snapshot.bucketName ||
          !reference.storageKey.startsWith(`${input.userId}/`)
        ) {
          throw new Error("视频输入存储引用不属于当前用户或 bucket");
        }
        references.push({ ...reference, storageBucket: snapshot.bucketName });
        continue;
      }
      if (reference.source !== "data") {
        references.push(reference);
        continue;
      }
      const bytes = Buffer.from(reference.base64, "base64");
      if (bytes.byteLength !== reference.byteLength) {
        throw new Error("视频输入图片字节数与声明不一致");
      }
      const digest = createHash("sha256")
        .update(bytes)
        .digest("hex")
        .slice(0, 32);
      const storageKey = createTemporaryVideoInputKey({
        userId: input.userId,
        videoId: input.videoId,
        attemptId: input.attemptId,
        index,
        digest,
        extension: getMediaExtension(reference.mimeType),
      });
      const object = {
        userId: input.userId,
        videoId: input.videoId,
        attemptId: input.attemptId,
        storageKey,
        storageBucket: snapshot.bucketName,
      };
      // WHY：清理意图必须先于对象写入持久化；进程在 putObject 返回前后退出时，
      // worker 都能在任务事务未接管该对象的情况下最终清理。
      await enqueueVideoInputCleanup([object]);
      await snapshot.provider.putObject(
        storageKey,
        snapshot.bucketName,
        bytes,
        reference.mimeType,
        { signal: uploadSignal }
      );
      objects.push(object);
      references.push({
        source: "storage",
        mimeType: reference.mimeType,
        storageKey,
        storageBucket: snapshot.bucketName,
        byteLength: bytes.byteLength,
      });
    }
    return {
      references: mediaInputReferencesSchema.max(3).parse(references),
      objects,
    };
  } catch (error) {
    try {
      await deleteStagedObjects(objects);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "视频输入转存失败且即时清理未完成"
      );
    }
    throw error;
  }
}

/** 清理竞争失败请求上传、但最终任务没有引用的对象。 */
export async function cleanupUnusedStagedVideoInputs(input: {
  objects: StagedVideoInputObject[];
  persistedReferences?: MediaInputReference[] | null;
}): Promise<void> {
  const used = new Set(
    (input.persistedReferences ?? [])
      .filter((reference) => reference.source === "storage")
      .map(
        (reference) =>
          `${reference.storageBucket ?? ""}\0${reference.storageKey}`
      )
  );
  await deleteStagedObjects(
    input.objects.filter(
      (object) => !used.has(`${object.storageBucket}\0${object.storageKey}`)
    )
  );
}

/** 删除任务自身的临时输入对象；用户已有 storage 引用和 remote 引用不受影响。 */
export async function cleanupPersistedVideoInputs(input: {
  userId: string;
  videoId: string;
  objects: unknown;
}): Promise<void> {
  const objects = parseVideoInputCleanupObjects(input.objects);
  if (
    objects.some(
      (object) =>
        object.userId !== input.userId || object.videoId !== input.videoId
    )
  ) {
    throw new Error("视频输入清理对象与任务归属不一致");
  }
  await deleteStagedObjects(objects);
}
