/**
 * 媒体任务队列的真实 Redis 集成测试。
 *
 * 职责：验证生产队列契约在 BullMQ 与 Redis 上的即时消费、去重、延迟、版本重投和
 * 非法负载拒绝。每个用例使用随机 key 前缀，不清空共享逻辑库。
 * 使用方：显式 `test:media-task-mq` 质量门。
 * 关键依赖：专用 MEDIA_TASK_MQ_TEST_REDIS_URL 与 Redis 7.4。
 */

import { randomUUID } from "node:crypto";
import {
  Queue,
  QueueEvents,
  type RedisOptions,
  Worker,
} from "bullmq";
import { describe, expect, it, vi } from "vitest";
import {
  type ImageTaskJobData,
  imageTaskJobDataSchema,
  MEDIA_TASK_JOB_NAME,
  MEDIA_TASK_QUEUE_NAMES,
  MEDIA_TASK_QUEUE_PREFIX,
  type VideoTaskJobData,
  videoTaskJobDataSchema,
} from "../../../apps/web/src/server/media-task-queue-contract";
import {
  enqueueImageTask,
  enqueueVideoTask,
} from "../../../apps/web/src/server/media-task-queues";
import { requireDedicatedTestRedisConnection } from "./test-redis-connection";

const TEST_REDIS_ENVIRONMENT_VARIABLE = "MEDIA_TASK_MQ_TEST_REDIS_URL";
const producerConnection = requireDedicatedTestRedisConnection(
  TEST_REDIS_ENVIRONMENT_VARIABLE,
  "producer"
);
const workerConnection = requireDedicatedTestRedisConnection(
  TEST_REDIS_ENVIRONMENT_VARIABLE,
  "worker"
);

/** 创建当前用例独占且可在结束时精准删除的 BullMQ key 前缀。 */
function createTestQueuePrefix(): string {
  return `${MEDIA_TASK_QUEUE_PREFIX}:integration-test:${randomUUID()}`;
}

/**
 * 删除指定随机前缀下的全部测试作业并关闭 Queue。
 *
 * @param queue 当前测试创建的 BullMQ Queue。
 * @returns 精准清理完成后返回；不会 FLUSHDB 或触碰其他前缀。
 */
async function destroyTestQueue<TData>(
  queue: Queue<TData, void, typeof MEDIA_TASK_JOB_NAME>
): Promise<void> {
  await queue.obliterate({ force: true });
  await queue.close();
}

/**
 * 创建一份连接参数副本，避免 BullMQ 实例之间共享可变选项对象。
 *
 * @param connection 已严格校验的测试连接。
 * @returns 可由单个 Queue、QueueEvents 或 Worker 独占的浅拷贝。
 */
function copyConnection(connection: RedisOptions): RedisOptions {
  return { ...connection };
}

describe("media task BullMQ Redis integration", () => {
  it("图片入队后由已就绪 Worker 即时消费", async () => {
    const prefix = createTestQueuePrefix();
    const queue = new Queue<
      ImageTaskJobData,
      void,
      typeof MEDIA_TASK_JOB_NAME
    >(MEDIA_TASK_QUEUE_NAMES.image, {
      connection: copyConnection(producerConnection),
      prefix,
    });
    const processTask = vi.fn().mockResolvedValue(undefined);
    const worker = new Worker<
      ImageTaskJobData,
      void,
      typeof MEDIA_TASK_JOB_NAME
    >(
      MEDIA_TASK_QUEUE_NAMES.image,
      async (job) => {
        const data = imageTaskJobDataSchema.parse(job.data);
        await processTask(data.taskId);
      },
      {
        connection: copyConnection(workerConnection),
        prefix,
      }
    );
    try {
      await worker.waitUntilReady();
      await enqueueImageTask({ taskId: "image-immediate" }, queue);
      await vi.waitFor(
        () => expect(processTask).toHaveBeenCalledWith("image-immediate"),
        { timeout: 5_000, interval: 20 }
      );
    } finally {
      await worker.close(true);
      await destroyTestQueue(queue);
    }
  });

  it("同一图片投递版本去重，版本变化后允许补投", async () => {
    const prefix = createTestQueuePrefix();
    const queue = new Queue<
      ImageTaskJobData,
      void,
      typeof MEDIA_TASK_JOB_NAME
    >(MEDIA_TASK_QUEUE_NAMES.image, {
      connection: copyConnection(producerConnection),
      prefix,
    });
    try {
      await Promise.all([
        enqueueImageTask(
          { taskId: "image-deduplicated", deliveryVersion: 0 },
          queue
        ),
        enqueueImageTask(
          { taskId: "image-deduplicated", deliveryVersion: 0 },
          queue
        ),
      ]);
      expect(await queue.getWaitingCount()).toBe(1);

      await enqueueImageTask(
        { taskId: "image-deduplicated", deliveryVersion: 1 },
        queue
      );
      const jobs = await queue.getJobs(["waiting"]);
      expect(jobs).toHaveLength(2);
      expect(new Set(jobs.map((job) => job.id)).size).toBe(2);
      expect(jobs.map((job) => job.data)).toEqual([
        { kind: "image-generation", taskId: "image-deduplicated" },
        { kind: "image-generation", taskId: "image-deduplicated" },
      ]);
    } finally {
      await destroyTestQueue(queue);
    }
  });

  it("视频任务在数据库目标时间到达后才消费", async () => {
    const prefix = createTestQueuePrefix();
    const queue = new Queue<
      VideoTaskJobData,
      void,
      typeof MEDIA_TASK_JOB_NAME
    >(MEDIA_TASK_QUEUE_NAMES.video, {
      connection: copyConnection(producerConnection),
      prefix,
    });
    const processTask = vi.fn().mockResolvedValue(null);
    const worker = new Worker<
      VideoTaskJobData,
      void,
      typeof MEDIA_TASK_JOB_NAME
    >(
      MEDIA_TASK_QUEUE_NAMES.video,
      async (job) => {
        const data = videoTaskJobDataSchema.parse(job.data);
        await processTask(data.taskId);
      },
      {
        connection: copyConnection(workerConnection),
        prefix,
      }
    );
    try {
      await worker.waitUntilReady();
      await enqueueVideoTask(
        {
          taskId: "video-delayed",
          stateVersion: 3,
          runAt: new Date(Date.now() + 400),
        },
        queue
      );
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(processTask).not.toHaveBeenCalled();
      await vi.waitFor(
        () => expect(processTask).toHaveBeenCalledWith("video-delayed"),
        { timeout: 5_000, interval: 20 }
      );
    } finally {
      await worker.close(true);
      await destroyTestQueue(queue);
    }
  });

  it("Redis 中的非法图片负载在业务调用前失败关闭", async () => {
    const prefix = createTestQueuePrefix();
    const queue = new Queue<unknown, void, typeof MEDIA_TASK_JOB_NAME>(
      MEDIA_TASK_QUEUE_NAMES.image,
      {
        connection: copyConnection(producerConnection),
        prefix,
      }
    );
    const queueEvents = new QueueEvents(MEDIA_TASK_QUEUE_NAMES.image, {
      connection: copyConnection(workerConnection),
      prefix,
    });
    const processTask = vi.fn();
    const worker = new Worker<unknown, void, typeof MEDIA_TASK_JOB_NAME>(
      MEDIA_TASK_QUEUE_NAMES.image,
      async (job) => {
        const data = imageTaskJobDataSchema.parse(job.data);
        await processTask(data.taskId);
      },
      {
        connection: copyConnection(workerConnection),
        prefix,
      }
    );
    try {
      await Promise.all([
        worker.waitUntilReady(),
        queueEvents.waitUntilReady(),
      ]);
      const job = await queue.add(
        MEDIA_TASK_JOB_NAME,
        {
          kind: "image-generation",
          taskId: "image-invalid",
          prompt: "不得进入 Redis",
        },
        { attempts: 1 }
      );
      await expect(job.waitUntilFinished(queueEvents, 5_000)).rejects.toThrow();
      expect(processTask).not.toHaveBeenCalled();
    } finally {
      await worker.close(true);
      await queueEvents.close();
      await destroyTestQueue(queue);
    }
  });
});
