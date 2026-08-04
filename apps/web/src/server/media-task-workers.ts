/**
 * Redis 媒体任务 Worker 运行时。
 *
 * 职责：在 Node 进程内启动跨副本竞争的 BullMQ 消费者，严格校验最小消息后从
 * PostgreSQL 恢复业务输入。图片与视频使用独立物理队列和并发预算，共享消息契约、
 * Redis 连接策略与有界关闭生命周期。
 */

import { logError } from "@repo/shared/logger";
import { Worker } from "bullmq";

import type { VideoQueueSchedule } from "@/features/image-generation/video-queue-schedule";
import { getMediaTaskRedisConnectionOptions } from "./media-task-queue-connection";
import {
  type ImageTaskJobData,
  imageTaskJobDataSchema,
  type MEDIA_TASK_JOB_NAME,
  MEDIA_TASK_QUEUE_NAMES,
  MEDIA_TASK_QUEUE_PREFIX,
  type VideoTaskJobData,
  videoTaskJobDataSchema,
} from "./media-task-queue-contract";
import {
  closeMediaTaskQueues,
  enqueueVideoTask,
} from "./media-task-queues";
import { registerProcessShutdownHook } from "./process-lifecycle";

const DEFAULT_VIDEO_WORKER_CONCURRENCY = 4;
const DEFAULT_IMAGE_WORKER_CONCURRENCY = 4;
const MAX_VIDEO_WORKER_CONCURRENCY = 128;
const MAX_IMAGE_WORKER_CONCURRENCY = 128;

type MediaTaskWorkerGlobal = typeof globalThis & {
  __fluxmediaMediaTaskWorkers?: {
    startPromise?: Promise<void>;
    image?: Worker<ImageTaskJobData, void, typeof MEDIA_TASK_JOB_NAME>;
    video?: Worker<VideoTaskJobData, void, typeof MEDIA_TASK_JOB_NAME>;
  };
};

/** 图片消息处理器可替换依赖；测试不加载 UOL binding、数据库或 Redis。 */
export interface ImageTaskJobDependencies {
  processTask(taskId: string): Promise<unknown>;
}

/** 视频消息处理器可替换依赖；测试不加载数据库或 Redis。 */
export interface VideoTaskJobDependencies {
  processTask(taskId: string): Promise<VideoQueueSchedule | null>;
  enqueueTask(schedule: VideoQueueSchedule): Promise<unknown>;
}

const defaultVideoTaskJobDependencies: VideoTaskJobDependencies = {
  async processTask(taskId) {
    const { processVideoGenerationQueueTask } = await import(
      "@/features/image-generation/video-operations"
    );
    return processVideoGenerationQueueTask(taskId);
  },
  async enqueueTask(schedule) {
    return enqueueVideoTask(schedule);
  },
};

const defaultImageTaskJobDependencies: ImageTaskJobDependencies = {
  async processTask(taskId) {
    const [{ invokeOperation }, { ensureUolInitialized }] = await Promise.all([
      import("@repo/shared/uol"),
      import("@/server/uol-init"),
    ]);
    await ensureUolInitialized();
    return invokeOperation(
      "image.processAsyncTask",
      { taskId },
      { type: "system", reason: "media-task-image-worker" }
    );
  },
};

/** 从环境读取有上限的图片 Worker 并发，非法值使用 4 worker。 */
function getImageWorkerConcurrency(): number {
  const parsed = Number.parseInt(
    process.env.MEDIA_IMAGE_WORKER_CONCURRENCY ?? "",
    10
  );
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_IMAGE_WORKER_CONCURRENCY;
  }
  return Math.min(MAX_IMAGE_WORKER_CONCURRENCY, parsed);
}

/** 从环境读取有上限的视频 Worker 并发，非法值使用现有 4 worker 口径。 */
function getVideoWorkerConcurrency(): number {
  const parsed = Number.parseInt(
    process.env.MEDIA_VIDEO_WORKER_CONCURRENCY ?? "",
    10
  );
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_VIDEO_WORKER_CONCURRENCY;
  }
  return Math.min(MAX_VIDEO_WORKER_CONCURRENCY, parsed);
}

/**
 * 处理一条视频 BullMQ 消息。
 *
 * @param value 来自 Redis 的不可信 JSON。
 * @param dependencies PostgreSQL 状态机处理器与后续投递器。
 * @returns 处理和必要的延迟重投完成后返回。
 * @throws 非法消息、数据库状态失败或 Redis 重投失败时上抛，由 BullMQ 有界重试。
 */
export async function processVideoTaskJob(
  value: unknown,
  dependencies: VideoTaskJobDependencies = defaultVideoTaskJobDependencies
): Promise<void> {
  const data = videoTaskJobDataSchema.parse(value);
  const schedule = await dependencies.processTask(data.taskId);
  if (schedule) await dependencies.enqueueTask(schedule);
}

/**
 * 处理一条图片 BullMQ 消息。
 *
 * @param value 来自 Redis 的不可信 JSON，仅允许 kind 与 taskId。
 * @param dependencies 系统 UOL 处理器；生产实现只把 taskId 传入统一网关。
 * @returns PostgreSQL 状态机处理完成后返回。
 * @throws 非法消息或可重试基础设施失败时上抛，由 BullMQ 有界重试。
 */
export async function processImageTaskJob(
  value: unknown,
  dependencies: ImageTaskJobDependencies = defaultImageTaskJobDependencies
): Promise<void> {
  const data = imageTaskJobDataSchema.parse(value);
  await dependencies.processTask(data.taskId);
}

/** 创建图片 BullMQ Worker，并注册不含领域负载的错误日志。 */
function createImageTaskWorker(): Worker<
  ImageTaskJobData,
  void,
  typeof MEDIA_TASK_JOB_NAME
> {
  const worker = new Worker<
    ImageTaskJobData,
    void,
    typeof MEDIA_TASK_JOB_NAME
  >(
    MEDIA_TASK_QUEUE_NAMES.image,
    async (job) => {
      await processImageTaskJob(job.data);
    },
    {
      connection: getMediaTaskRedisConnectionOptions("worker"),
      concurrency: getImageWorkerConcurrency(),
      prefix: MEDIA_TASK_QUEUE_PREFIX,
    }
  );
  worker.on("error", (error) =>
    logError(error, { source: "media-task-image-worker" })
  );
  worker.on("failed", (job, error) =>
    logError(error, {
      source: "media-task-image-job",
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
    })
  );
  return worker;
}

/** 创建视频 BullMQ Worker，并注册不含领域负载的错误日志。 */
function createVideoTaskWorker(): Worker<
  VideoTaskJobData,
  void,
  typeof MEDIA_TASK_JOB_NAME
> {
  const worker = new Worker<
    VideoTaskJobData,
    void,
    typeof MEDIA_TASK_JOB_NAME
  >(
    MEDIA_TASK_QUEUE_NAMES.video,
    async (job) => {
      await processVideoTaskJob(job.data);
    },
    {
      connection: getMediaTaskRedisConnectionOptions("worker"),
      concurrency: getVideoWorkerConcurrency(),
      prefix: MEDIA_TASK_QUEUE_PREFIX,
    }
  );
  worker.on("error", (error) =>
    logError(error, { source: "media-task-video-worker" })
  );
  worker.on("failed", (job, error) =>
    logError(error, {
      source: "media-task-video-job",
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
    })
  );
  return worker;
}

/**
 * 启动进程级媒体 Worker。
 *
 * @returns 图片、视频 Worker Redis 连接均就绪后返回；并发调用复用同一 Promise。
 * @throws 任一 Redis 连接或 Worker 初始化失败时关闭两者并阻止应用启动。
 */
export async function startMediaTaskWorkers(): Promise<void> {
  const runtimeGlobal = globalThis as MediaTaskWorkerGlobal;
  let state = runtimeGlobal.__fluxmediaMediaTaskWorkers;
  if (!state) {
    state = {};
    runtimeGlobal.__fluxmediaMediaTaskWorkers = state;
  }
  if (state.startPromise) return state.startPromise;

  state.startPromise = (async () => {
    const image = createImageTaskWorker();
    const video = createVideoTaskWorker();
    state.image = image;
    state.video = video;
    registerProcessShutdownHook(
      "media-task-workers",
      () => closeMediaTaskWorkers(true),
      20
    );
    registerProcessShutdownHook("media-task-queues", closeMediaTaskQueues, 30);
    try {
      await Promise.all([image.waitUntilReady(), video.waitUntilReady()]);
    } catch (error) {
      delete state.image;
      delete state.video;
      await Promise.allSettled([image.close(true), video.close(true)]);
      throw error;
    }
  })();
  try {
    await state.startPromise;
  } catch (error) {
    delete state.startPromise;
    throw error;
  }
}

/**
 * 关闭进程级媒体 Worker。
 *
 * @param force true 时立即释放，未完成任务由 BullMQ stalled 与数据库 claim 恢复。
 * @returns Worker 关闭后返回；重复调用幂等。
 */
export async function closeMediaTaskWorkers(force = false): Promise<void> {
  const runtimeGlobal = globalThis as MediaTaskWorkerGlobal;
  const state = runtimeGlobal.__fluxmediaMediaTaskWorkers;
  delete runtimeGlobal.__fluxmediaMediaTaskWorkers;
  if (!state) return;
  await Promise.allSettled([
    state.image?.close(force),
    state.video?.close(force),
  ]);
}
