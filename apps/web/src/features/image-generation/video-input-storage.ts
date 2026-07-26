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

/** 本轮创建请求实际上传的临时对象。 */
export interface StagedVideoInputObject {
  storageKey: string;
  storageBucket: string;
}

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
  index: number;
  digest: string;
  extension: string;
}): string {
  return `${input.userId}/video-inputs/${input.videoId}/${input.index}-${input.digest}.${input.extension}`;
}

/** 判断一个引用是否是本任务创建的临时输入，而非用户已有对象。 */
function isTemporaryVideoInputReference(
  reference: MediaInputReference,
  userId: string,
  videoId: string
): reference is Extract<MediaInputReference, { source: "storage" }> {
  return (
    reference.source === "storage" &&
    reference.storageKey.startsWith(`${userId}/video-inputs/${videoId}/`)
  );
}

/** 删除指定对象；全部删除成功才视为清理完成，便于调用方保留重试事实。 */
async function deleteStagedObjects(
  objects: StagedVideoInputObject[]
): Promise<void> {
  if (objects.length === 0) return;
  const { provider } = await getStorageRuntimeSnapshot();
  await Promise.all(
    objects.map((object) =>
      provider.deleteObject(object.storageKey, object.storageBucket)
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
  references: MediaInputReference[];
}): Promise<StagedVideoInputReferences> {
  const parsed = mediaInputReferencesSchema.max(3).parse(input.references);
  if (!parsed.some((reference) => reference.source === "data")) {
    return { references: parsed, objects: [] };
  }

  const snapshot = await getStorageRuntimeSnapshot();
  const objects: StagedVideoInputObject[] = [];
  const references: MediaInputReference[] = [];
  try {
    for (const [index, reference] of parsed.entries()) {
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
        index,
        digest,
        extension: getMediaExtension(reference.mimeType),
      });
      await snapshot.provider.putObject(
        storageKey,
        snapshot.bucketName,
        bytes,
        reference.mimeType
      );
      objects.push({
        storageKey,
        storageBucket: snapshot.bucketName,
      });
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
    await deleteStagedObjects(objects).catch(() => undefined);
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
  references: MediaInputReference[];
}): Promise<void> {
  const objects = input.references
    .filter((reference) =>
      isTemporaryVideoInputReference(reference, input.userId, input.videoId)
    )
    .map((reference) => ({
      storageKey: reference.storageKey,
      storageBucket: reference.storageBucket ?? "",
    }));
  if (objects.some((object) => !object.storageBucket)) {
    const snapshot = await getStorageRuntimeSnapshot();
    for (const object of objects) {
      object.storageBucket ||= snapshot.bucketName;
    }
  }
  await deleteStagedObjects(objects);
}
