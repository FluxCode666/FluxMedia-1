/**
 * Redis 媒体任务队列生产者。
 *
 * 职责：以确定性 jobId 向图片或视频 BullMQ 队列投递最小任务身份；业务数据库提交
 * 后调用。Redis 投递失败不得回滚已提交的数据库事实，由补偿扫描负责再次投递。
 */

import { logError } from "@repo/shared/logger";
import { type JobsOptions, Queue } from "bullmq";

import { getMediaTaskRedisConnectionOptions } from "./media-task-queue-connection";
import {
  createImageTaskJobId,
  createVideoTaskJobId,
  type ImageTaskJobData,
  imageTaskJobDataSchema,
  MEDIA_TASK_JOB_NAME,
  MEDIA_TASK_QUEUE_NAMES,
  MEDIA_TASK_QUEUE_PREFIX,
  type VideoTaskJobData,
  videoTaskJobDataSchema,
} from "./media-task-queue-contract";

const COMPLETED_JOB_RETENTION_SECONDS = 60 * 60;
const FAILED_JOB_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const RETAINED_JOB_COUNT = 10_000;
const MAX_BULLMQ_DELAY_MS = 2_147_483_647;

type MediaTaskQueueGlobal = typeof globalThis & {
  __fluxmediaMediaTaskQueues?: {
    image: Queue<ImageTaskJobData, void, typeof MEDIA_TASK_JOB_NAME>;
    video: Queue<VideoTaskJobData, void, typeof MEDIA_TASK_JOB_NAME>;
  };
};

/** 可注入队列端口；单测记录 add，不建立 Redis 连接。 */
export interface MediaTaskQueuePort<TData> {
  add(
    name: typeof MEDIA_TASK_JOB_NAME,
    data: TData,
    options: JobsOptions
  ): Promise<unknown>;
}

/** 图片任务投递参数。 */
export interface EnqueueImageTaskInput {
  taskId: string;
  deliveryVersion?: number;
  priority?: number;
  runAt?: Date;
}

/** 视频任务投递参数。 */
export interface EnqueueVideoTaskInput {
  taskId: string;
  stateVersion: number;
  runAt?: Date;
}

/** 把目标时间收窄为 BullMQ 安全延迟；过去时间立即执行。 */
function getQueueDelay(runAt: Date | undefined, now = Date.now()): number {
  if (!runAt) return 0;
  return Math.min(MAX_BULLMQ_DELAY_MS, Math.max(0, runAt.getTime() - now));
}

/** 生成所有媒体队列共用的保留、重试和退避选项。 */
function createBaseJobOptions(delay: number): JobsOptions {
  return {
    attempts: 5,
    backoff: { type: "exponential", delay: 1_000 },
    delay,
    removeOnComplete: {
      age: COMPLETED_JOB_RETENTION_SECONDS,
      count: RETAINED_JOB_COUNT,
    },
    removeOnFail: {
      age: FAILED_JOB_RETENTION_SECONDS,
      count: RETAINED_JOB_COUNT,
    },
  };
}

/** 获取进程级 Queue 生产者；两个物理队列共享契约和 Redis 命名空间。 */
function getMediaTaskQueues() {
  const runtimeGlobal = globalThis as MediaTaskQueueGlobal;
  if (runtimeGlobal.__fluxmediaMediaTaskQueues) {
    return runtimeGlobal.__fluxmediaMediaTaskQueues;
  }
  const connection = getMediaTaskRedisConnectionOptions("producer");
  const image = new Queue<ImageTaskJobData, void, typeof MEDIA_TASK_JOB_NAME>(
    MEDIA_TASK_QUEUE_NAMES.image,
    {
      connection,
      prefix: MEDIA_TASK_QUEUE_PREFIX,
    }
  );
  const video = new Queue<VideoTaskJobData, void, typeof MEDIA_TASK_JOB_NAME>(
    MEDIA_TASK_QUEUE_NAMES.video,
    {
      connection,
      prefix: MEDIA_TASK_QUEUE_PREFIX,
    }
  );
  image.on("error", (error) =>
    logError(error, { source: "media-task-image-queue" })
  );
  video.on("error", (error) =>
    logError(error, { source: "media-task-video-queue" })
  );
  runtimeGlobal.__fluxmediaMediaTaskQueues = { image, video };
  return runtimeGlobal.__fluxmediaMediaTaskQueues;
}

/**
 * 投递一条持久图片任务。
 *
 * @param input 任务 ID、可选队列优先级和延迟时间。
 * @param queue 可注入队列；生产默认使用图片 Queue。
 * @returns BullMQ add 完成后的未知作业句柄；调用方不依赖其内部结构。
 */
export async function enqueueImageTask(
  input: EnqueueImageTaskInput,
  queue: MediaTaskQueuePort<ImageTaskJobData> = getMediaTaskQueues().image
): Promise<unknown> {
  const data = imageTaskJobDataSchema.parse({
    kind: "image-generation",
    taskId: input.taskId,
  });
  const options = createBaseJobOptions(getQueueDelay(input.runAt));
  options.jobId = createImageTaskJobId(data.taskId, input.deliveryVersion ?? 0);
  if (input.priority !== undefined) {
    options.priority = Math.max(1, Math.trunc(input.priority));
  }
  return queue.add(MEDIA_TASK_JOB_NAME, data, options);
}

/**
 * 投递一条持久视频状态任务。
 *
 * @param input 任务 ID、数据库状态版本和可选延迟时间。
 * @param queue 可注入队列；生产默认使用视频 Queue。
 * @returns BullMQ add 完成后的未知作业句柄。
 */
export async function enqueueVideoTask(
  input: EnqueueVideoTaskInput,
  queue: MediaTaskQueuePort<VideoTaskJobData> = getMediaTaskQueues().video
): Promise<unknown> {
  const data = videoTaskJobDataSchema.parse({
    kind: "video-generation",
    taskId: input.taskId,
    stateVersion: input.stateVersion,
  });
  return queue.add(MEDIA_TASK_JOB_NAME, data, {
    ...createBaseJobOptions(getQueueDelay(input.runAt)),
    jobId: createVideoTaskJobId(data.taskId, data.stateVersion),
  });
}

/** 关闭进程级 Queue 生产者；不存在时幂等返回。 */
export async function closeMediaTaskQueues(): Promise<void> {
  const runtimeGlobal = globalThis as MediaTaskQueueGlobal;
  const queues = runtimeGlobal.__fluxmediaMediaTaskQueues;
  delete runtimeGlobal.__fluxmediaMediaTaskQueues;
  if (!queues) return;
  await Promise.all([queues.image.close(), queues.video.close()]);
}
