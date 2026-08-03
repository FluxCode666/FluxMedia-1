/**
 * Redis 媒体任务队列契约。
 *
 * 职责：定义图片、视频队列名称与仅含持久任务身份的消息格式；生产者和 Worker
 * 共同使用。消息不得包含提示词、媒体字节、凭据或第三方响应。
 */

import { createHash } from "node:crypto";
import { z } from "zod";

/** BullMQ key 前缀；版本升级时显式迁移，禁止静默复用旧协议。 */
export const MEDIA_TASK_QUEUE_PREFIX = "fluxmedia:media-mq:v1";

/** 图片与视频使用独立物理队列，避免长视频任务阻塞图片任务。 */
export const MEDIA_TASK_QUEUE_NAMES = {
  image: "image-generation",
  video: "video-generation",
} as const;

/** 两类队列统一使用的作业名称。 */
export const MEDIA_TASK_JOB_NAME = "execute";

const taskIdSchema = z.string().trim().min(1).max(128);

/** 图片 MQ 消息；完整输入与 Principal 快照只从 PostgreSQL 任务行读取。 */
export const imageTaskJobDataSchema = z
  .object({
    kind: z.literal("image-generation"),
    taskId: taskIdSchema,
  })
  .strict();

/** 视频 MQ 消息；stateVersion 参与去重，不作为执行授权或状态真相。 */
export const videoTaskJobDataSchema = z
  .object({
    kind: z.literal("video-generation"),
    taskId: taskIdSchema,
    stateVersion: z.number().int().nonnegative(),
  })
  .strict();

/** 图片队列消息类型。 */
export type ImageTaskJobData = z.infer<typeof imageTaskJobDataSchema>;

/** 视频队列消息类型。 */
export type VideoTaskJobData = z.infer<typeof videoTaskJobDataSchema>;

/** 把持久身份压缩为不含 BullMQ 保留分隔符的稳定摘要。 */
function createTaskIdentityDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * 生成 BullMQ 可接受的稳定图片 jobId。
 *
 * @param taskId PostgreSQL 图片异步任务 ID。
 * @returns 不含冒号的确定性 jobId；重复投递由 BullMQ 合并。
 */
export function createImageTaskJobId(taskId: string): string {
  const data = imageTaskJobDataSchema.parse({
    kind: "image-generation",
    taskId,
  });
  return `image-${createTaskIdentityDigest(data.taskId)}`;
}

/**
 * 生成带状态版本的视频 jobId。
 *
 * @param taskId PostgreSQL 视频任务 ID。
 * @param stateVersion 当前持久状态版本。
 * @returns 同一状态版本确定性去重、状态推进后允许再次投递的 jobId。
 */
export function createVideoTaskJobId(
  taskId: string,
  stateVersion: number
): string {
  const data = videoTaskJobDataSchema.parse({
    kind: "video-generation",
    taskId,
    stateVersion,
  });
  return `video-${createTaskIdentityDigest(
    `${data.taskId}\0${data.stateVersion}`
  )}`;
}
