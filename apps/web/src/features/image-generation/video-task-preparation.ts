/**
 * 视频任务创建前的容量预检与输入转存编排。
 *
 * 职责：强制所有大媒体处理发生在双层容量预检之后；事务内准入仍由任务创建函数
 * 终检。使用方是 video.generate UOL binding；依赖可注入以证明限流时没有存储 I/O。
 */
import type { VideoInputReferenceManifest } from "@repo/shared/image-generation/media-contract";

import type { StagedVideoInputManifest } from "./video-input-storage";
import {
  preflightVideoTaskCreation,
  releaseVideoTaskStagingReservation,
  type VideoTaskAdmissionInput,
  type VideoTaskPreflightResult,
} from "./video-task-admission";

/** 预检通过后的输入准备结果；existing 分支绝不执行媒体转存。 */
export type VideoTaskPreparationResult =
  | { admission: "existing"; stagedInput: null }
  | {
      admission: "admitted";
      reservationToken: string;
      stagedInput: StagedVideoInputManifest;
    };

/** 输入准备依赖端口，仅供 DB-free 边界测试注入。 */
export interface VideoTaskPreparationDependencies {
  preflight: (
    input: VideoTaskAdmissionInput
  ) => Promise<VideoTaskPreflightResult>;
  stage: (input: {
    userId: string;
    videoId: string;
    attemptId: string;
    manifest: VideoInputReferenceManifest;
  }) => Promise<StagedVideoInputManifest>;
  release: (input: {
    taskId: string;
    userId: string;
    reservationToken: string;
  }) => Promise<boolean>;
}

/**
 * 先执行廉价容量预检，再按需把 data 引用写入对象存储。
 *
 * @returns existing 时调用方应读取已创建任务；admitted 仅代表预检通过，最终插入仍需
 * 用户级事务锁下再次准入。
 */
export async function prepareVideoTaskInputReferences(
  input: VideoTaskAdmissionInput & {
    manifest: VideoInputReferenceManifest;
  },
  dependencies?: VideoTaskPreparationDependencies
): Promise<VideoTaskPreparationResult> {
  const preflight = await (
    dependencies?.preflight ?? preflightVideoTaskCreation
  )(input);
  if (preflight.status === "existing") {
    return { admission: "existing", stagedInput: null };
  }
  const reservationToken = preflight.reservationToken;
  if (Object.keys(input.manifest).length === 0) {
    return {
      admission: "admitted",
      reservationToken,
      stagedInput: { manifest: {}, objects: [] },
    };
  }
  const stage =
    dependencies?.stage ??
    (await import("./video-input-storage")).stageVideoInputManifest;
  try {
    return {
      admission: "admitted",
      reservationToken,
      stagedInput: await stage({
        userId: input.userId,
        videoId: input.taskId,
        attemptId: reservationToken,
        manifest: input.manifest,
      }),
    };
  } catch (error) {
    const release = dependencies?.release ?? releaseVideoTaskStagingReservation;
    try {
      await release({
        taskId: input.taskId,
        userId: input.userId,
        reservationToken,
      });
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        "视频输入准备失败且 staging reservation 释放未完成"
      );
    }
    throw error;
  }
}
