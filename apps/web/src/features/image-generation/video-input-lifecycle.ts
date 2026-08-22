/**
 * 视频具名输入的生命周期纯策略。
 *
 * 职责：统一终态保留规则与对外安全摘要，供视频状态、callback 和持久 worker
 * 复用；本模块不读取数据库或对象存储。
 */
import {
  listVideoInputManifestReferences,
  type VideoInputManifest,
} from "@repo/shared/image-generation/media-contract";

import {
  parseVideoInputCleanupObjects,
  type VideoInputCleanupObject,
} from "./video-input-cleanup-queue";

/** 视频列表和 callback 可公开的输入摘要。 */
export type VideoInputSummary = {
  mode:
    | "none"
    | "first-frame"
    | "first-last-frames"
    | "references"
    | "reference-videos"
    | "reference-audio"
    | "mixed";
  count: number;
};

/**
 * 判断某阶段是否必须保留任务输入。
 *
 * @param stage 持久视频执行阶段。
 * @returns 所有阶段均返回 true；删除只由显式生命周期清理意图驱动。
 * @sideEffects 无。
 */
export function shouldRetainVideoInputsAfterStage(stage: string): boolean {
  void stage;
  return true;
}

/**
 * 将任务私有清单投影为不含 URL 和存储身份的摘要。
 *
 * @param manifest 已验证的具名持久输入清单；无输入时可为空。
 * @returns 稳定输入模式与数量。
 * @sideEffects 无。
 */
export function buildVideoInputSummary(
  manifest: VideoInputManifest | null | undefined
): VideoInputSummary {
  if (!manifest) return { mode: "none", count: 0 };
  const frameCount = (manifest.firstFrame ? 1 : 0) + (manifest.lastFrame ? 1 : 0);
  const referenceCount = manifest.referenceImages?.length ?? 0;
  const videoCount = manifest.referenceVideos?.length ?? 0;
  const audioCount = manifest.referenceAudios?.length ?? 0;
  const total = frameCount + referenceCount + videoCount + audioCount;
  if (total === 0) return { mode: "none", count: 0 };
  if (videoCount > 0 && audioCount === 0 && frameCount === 0 && referenceCount === 0) {
    return { mode: "reference-videos", count: videoCount };
  }
  if (audioCount > 0 && videoCount === 0 && frameCount === 0 && referenceCount === 0) {
    return { mode: "reference-audio", count: audioCount };
  }
  if (referenceCount > 0 && videoCount === 0 && audioCount === 0 && frameCount === 0) {
    return { mode: "references", count: referenceCount };
  }
  if (frameCount === 2 && total === 2) {
    return { mode: "first-last-frames", count: 2 };
  }
  if (frameCount === 1 && total === 1) {
    return { mode: "first-frame", count: 1 };
  }
  return { mode: "mixed", count: total };
}

/**
 * 构造 callback 专用输入 DTO。
 *
 * @param manifest 已验证任务清单。
 * @returns 仅模式与数量；与站内短期 URL 详情 DTO 保持类型隔离。
 * @sideEffects 无。
 */
export function buildVideoCallbackInput(
  manifest: VideoInputManifest
): VideoInputSummary {
  return buildVideoInputSummary(manifest);
}

/** 从任务自有对象 key 解析可信 staging attempt。 */
function readAttemptId(input: {
  userId: string;
  videoId: string;
  storageKey: string;
}): string {
  const prefix = `${input.userId}/video-inputs/${input.videoId}/`;
  if (!input.storageKey.startsWith(prefix)) {
    throw new Error("视频输入对象不属于指定用户和任务");
  }
  const [attemptId, fileName, ...extra] = input.storageKey
    .slice(prefix.length)
    .split("/");
  if (!attemptId || !fileName || extra.length > 0) {
    throw new Error("视频输入对象 key 结构无效");
  }
  return attemptId;
}

/**
 * 从任务白名单清单构造生命周期删除对象，不接受客户端 bucket/key。
 *
 * @param input 任务归属与已验证持久清单。
 * @returns 可幂等登记的 lifecycle_delete 对象。
 * @sideEffects 无。
 */
export function createLifecycleCleanupObjects(input: {
  userId: string;
  videoId: string;
  manifest: VideoInputManifest;
}): VideoInputCleanupObject[] {
  return parseVideoInputCleanupObjects(
    listVideoInputManifestReferences(input.manifest).map((reference) => ({
      reason: "lifecycle_delete",
      userId: input.userId,
      videoId: input.videoId,
      attemptId: readAttemptId({
        userId: input.userId,
        videoId: input.videoId,
        storageKey: reference.storageKey,
      }),
      storageKey: reference.storageKey,
      storageBucket: reference.storageBucket,
    }))
  );
}
