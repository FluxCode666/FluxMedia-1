/**
 * 视频具名输入的持久存储层。
 *
 * 职责：在任务创建前实际读取并复验 data、storage、remote 输入，再全部复制成当前
 * 用户与任务隔离的 storage-only 清单；对象写入前登记 orphan 清理意图。
 * 使用方：video.generate UOL binding、任务创建事务与账号删除生命周期。
 */
import { createHash } from "node:crypto";
import {
  listVideoInputManifestReferences,
  type MediaInputReference,
  type VideoInputManifest,
  type VideoInputReferenceManifest,
  videoInputManifestSchema,
  videoInputReferenceManifestSchema,
} from "@repo/shared/image-generation/media-contract";
import { getStorageRuntimeSnapshot } from "@repo/shared/storage/providers";

import { type LoadedMediaInput, loadMediaInputs } from "./media-input-loader";
import {
  enqueueVideoInputCleanup,
  type VideoInputCleanupObject,
} from "./video-input-cleanup-queue";
import { VIDEO_STAGING_RESERVATION_TTL_MS } from "./video-task-admission";

const VIDEO_INPUT_UPLOAD_COMPLETION_GRACE_MS = 5 * 60_000;
export const VIDEO_INPUT_UPLOAD_TIMEOUT_MS =
  VIDEO_STAGING_RESERVATION_TTL_MS - VIDEO_INPUT_UPLOAD_COMPLETION_GRACE_MS;

/** 本轮创建请求实际上传、尚待任务事务采用的对象。 */
export type StagedVideoInputObject = VideoInputCleanupObject;

/** 全部来源归一后的具名持久输入结果。 */
export interface StagedVideoInputManifest {
  manifest: VideoInputManifest;
  objects: StagedVideoInputObject[];
}

type NamedVideoInput = {
  slot: "first-frame" | "last-frame" | "reference";
  slotIndex: number;
  reference: MediaInputReference;
};
type PersistedVideoInputReference = NonNullable<
  VideoInputManifest["firstFrame"]
>;

/** MIME 到安全对象扩展名的稳定映射。 */
function getMediaExtension(mimeType: MediaInputReference["mimeType"]): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

/** 根据图片魔数识别当前视频契约允许的实际 MIME。 */
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

/** 临时视频输入对象只能落在当前用户和任务的隔离前缀下。 */
function createVideoInputKey(input: {
  userId: string;
  videoId: string;
  attemptId: string;
  slot: NamedVideoInput["slot"];
  slotIndex: number;
  digest: string;
  extension: string;
}): string {
  return `${input.userId}/video-inputs/${input.videoId}/${input.attemptId}/${input.slot}-${input.slotIndex}-${input.digest}.${input.extension}`;
}

/** 按具名语义稳定展开任务创建前的输入清单。 */
function listNamedVideoInputs(
  manifest: VideoInputReferenceManifest
): NamedVideoInput[] {
  return [
    ...(manifest.firstFrame
      ? [
          {
            slot: "first-frame" as const,
            slotIndex: 0,
            reference: manifest.firstFrame,
          },
        ]
      : []),
    ...(manifest.lastFrame
      ? [
          {
            slot: "last-frame" as const,
            slotIndex: 0,
            reference: manifest.lastFrame,
          },
        ]
      : []),
    ...(manifest.referenceImages ?? []).map((reference, slotIndex) => ({
      slot: "reference" as const,
      slotIndex,
      reference,
    })),
  ];
}

/** 把有序 storage 引用还原成原始具名结构。 */
function buildPersistedManifest(
  source: VideoInputReferenceManifest,
  references: PersistedVideoInputReference[]
): VideoInputManifest {
  let index = 0;
  const manifest: VideoInputManifest = {};
  if (source.firstFrame) {
    manifest.firstFrame = references[index];
    index += 1;
  }
  if (source.lastFrame) {
    manifest.lastFrame = references[index];
    index += 1;
  }
  if (source.referenceImages?.length) {
    manifest.referenceImages = references.slice(index);
  }
  return videoInputManifestSchema.parse(manifest);
}

/** 删除指定 orphan 对象；删除失败时持久意图留给 worker 重试。 */
async function deleteStagedObjects(
  objects: StagedVideoInputObject[]
): Promise<void> {
  if (objects.length === 0) return;
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
 * 实际读取所有输入并复制到任务自有持久对象。
 *
 * @param input 当前用户、任务、准入尝试和具名输入。
 * @returns storage-only 清单与待任务事务采用的 orphan 对象。
 * @sideEffects 读取外部/已有对象，登记清理意图并写入当前存储 bucket。
 * @throws 数量、总字节、归属、SSRF、MIME、声明字节或上传失败时拒绝。
 */
export async function stageVideoInputManifest(input: {
  userId: string;
  videoId: string;
  attemptId: string;
  manifest: VideoInputReferenceManifest;
}): Promise<StagedVideoInputManifest> {
  if (
    !input.attemptId ||
    input.attemptId.length > 128 ||
    input.attemptId.includes("/") ||
    input.attemptId.includes("..")
  ) {
    throw new Error("视频输入转存 attemptId 无效");
  }
  const manifest = videoInputReferenceManifestSchema.parse(input.manifest);
  const namedInputs = listNamedVideoInputs(manifest);
  if (namedInputs.length === 0) return { manifest: {}, objects: [] };
  const uploadSignal = AbortSignal.timeout(VIDEO_INPUT_UPLOAD_TIMEOUT_MS);

  // WHY：先完成全部实际读取、MIME、字节和总量复验，再写第一个对象，避免第 257
  // 张或实际 512 MB 超限请求制造部分对象和额外清理压力。
  const loaded = await loadMediaInputs({
    userId: input.userId,
    references: namedInputs.map((entry) => entry.reference),
    signal: uploadSignal,
  });
  if (loaded.length !== namedInputs.length) {
    throw new Error("视频输入加载结果数量不一致");
  }
  for (const [index, entry] of namedInputs.entries()) {
    const media = loaded[index] as LoadedMediaInput;
    if (media.data.byteLength !== entry.reference.byteLength) {
      throw new Error("视频输入图片字节数与声明不一致");
    }
    if (detectMediaMimeType(media.data) !== entry.reference.mimeType) {
      throw new Error("视频输入图片实际 MIME 与声明不一致");
    }
  }

  const snapshot = await getStorageRuntimeSnapshot();
  const objects: StagedVideoInputObject[] = [];
  const references: PersistedVideoInputReference[] = [];
  try {
    for (const [index, entry] of namedInputs.entries()) {
      const media = loaded[index] as LoadedMediaInput;
      const digest = createHash("sha256")
        .update(media.data)
        .digest("hex")
        .slice(0, 32);
      const storageKey = createVideoInputKey({
        userId: input.userId,
        videoId: input.videoId,
        attemptId: input.attemptId,
        slot: entry.slot,
        slotIndex: entry.slotIndex,
        digest,
        extension: getMediaExtension(entry.reference.mimeType),
      });
      const object: StagedVideoInputObject = {
        reason: "orphan",
        userId: input.userId,
        videoId: input.videoId,
        attemptId: input.attemptId,
        storageKey,
        storageBucket: snapshot.bucketName,
      };
      await enqueueVideoInputCleanup([object]);
      await snapshot.provider.putObject(
        storageKey,
        snapshot.bucketName,
        media.data,
        entry.reference.mimeType,
        { signal: uploadSignal }
      );
      objects.push(object);
      references.push({
        source: "storage",
        mimeType: entry.reference.mimeType,
        storageKey,
        storageBucket: snapshot.bucketName,
        byteLength: media.data.byteLength,
      });
    }
    return {
      manifest: buildPersistedManifest(manifest, references),
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

/**
 * 清理竞争失败请求上传、但最终任务清单没有采用的对象。
 *
 * @param input 本次 orphan 对象与竞争后实际持久清单。
 * @returns 无。
 * @sideEffects 对未采用对象登记并执行幂等删除。
 */
export async function cleanupUnusedStagedVideoInputs(input: {
  objects: StagedVideoInputObject[];
  persistedManifest?: VideoInputManifest | null;
}): Promise<void> {
  const used = new Set(
    listVideoInputManifestReferences(input.persistedManifest ?? {}).map(
      (reference) => `${reference.storageBucket}\0${reference.storageKey}`
    )
  );
  await deleteStagedObjects(
    input.objects.filter(
      (object) => !used.has(`${object.storageBucket}\0${object.storageKey}`)
    )
  );
}
