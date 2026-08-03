/**
 * 图片异步任务 PostgreSQL 仓储。
 *
 * 职责：持久化已通过 UOL 校验的图片批次，按任务 ID 原子 claim，并用 claim token
 * 比较交换收敛终态。Redis 仅持有 taskId，不参与任务真相、身份或幂等判断。
 * 使用方：图片异步 UOL binding、BullMQ Worker 与数据库恢复扫描。
 */
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type {
  ImageEnqueueAsyncInput,
  ImageGenerateOperationInput,
} from "@repo/shared/uol/operations/image-generation";
import {
  imageAsyncTaskIdSchema,
  imageAsyncTaskStatusSchema,
  imageEnqueueAsyncInputSchema,
  imageGenerateInputSchema,
} from "@repo/shared/uol/operations/image-generation";
import { z } from "zod";

import { extractExecuteRows } from "@/server/database-result";

const identifierSchema = z.string().trim().min(1).max(128);
const taskErrorSchema = z.string().max(2_000);

const imageAsyncTaskRowSchema = z
  .object({
    id: imageAsyncTaskIdSchema,
    user_id: identifierSchema,
    api_key_id: identifierSchema,
    plan: identifierSchema,
    operation: z.enum(["generate", "edit", "mask"]),
    generation_inputs: z.array(imageGenerateInputSchema).min(1).max(10_000),
    generation_ids: z.array(identifierSchema).min(1).max(10_000),
    response_format: z.enum(["url", "b64_json"]),
    callback_url: z.string().url().max(2_048).nullable(),
    status: imageAsyncTaskStatusSchema,
    attempt_count: z.coerce.number().int().nonnegative(),
    claim_token: identifierSchema.nullable(),
    claim_expires_at: z.coerce.date().nullable(),
    error: taskErrorSchema.nullable(),
    created_at: z.coerce.date(),
    started_at: z.coerce.date().nullable(),
    completed_at: z.coerce.date().nullable(),
    updated_at: z.coerce.date(),
  })
  .superRefine((row, context) => {
    const inputGenerationIds = row.generation_inputs.map(
      (input) => input.generationId
    );
    if (
      inputGenerationIds.length !== row.generation_ids.length ||
      inputGenerationIds.some(
        (generationId, index) => generationId !== row.generation_ids[index]
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["generation_ids"],
        message: "Persisted generation IDs do not match generation inputs",
      });
    }
    if (
      row.generation_inputs.some((input) => input.operation !== row.operation)
    ) {
      context.addIssue({
        code: "custom",
        path: ["generation_inputs"],
        message: "Persisted generation operation does not match task operation",
      });
    }
  });

const createImageAsyncTaskInputSchema = z
  .object({
    task: z.custom<ImageEnqueueAsyncInput>(),
    userId: identifierSchema,
    apiKeyId: identifierSchema,
    plan: identifierSchema,
    now: z.date(),
  })
  .strict();

const claimImageAsyncTaskInputSchema = z
  .object({
    taskId: imageAsyncTaskIdSchema,
    claimToken: identifierSchema,
    now: z.date(),
    claimExpiresAt: z.date(),
  })
  .strict()
  .refine((input) => input.claimExpiresAt.getTime() > input.now.getTime(), {
    path: ["claimExpiresAt"],
    message: "Claim expiration must be later than claim time",
  });

const finishImageAsyncTaskInputSchema = z
  .object({
    taskId: imageAsyncTaskIdSchema,
    claimToken: identifierSchema,
    now: z.date(),
    error: taskErrorSchema.optional(),
  })
  .strict();

/** 一条已验证的持久图片异步任务。 */
export interface ImageAsyncTaskRecord {
  id: string;
  userId: string;
  apiKeyId: string;
  plan: string;
  operation: "generate" | "edit" | "mask";
  generationInputs: ImageGenerateOperationInput[];
  generationIds: string[];
  responseFormat: "url" | "b64_json";
  callbackUrl: string | null;
  status: "queued" | "running" | "completed" | "failed";
  attemptCount: number;
  claimToken: string | null;
  claimExpiresAt: Date | null;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
}

/** 图片异步任务创建输入；身份只允许来自已验证的 Principal。 */
export type CreateImageAsyncTaskInput = z.input<
  typeof createImageAsyncTaskInputSchema
>;

/** 图片异步任务 claim 输入；时钟和 token 显式注入以便并发测试。 */
export type ClaimImageAsyncTaskInput = z.input<
  typeof claimImageAsyncTaskInputSchema
>;

/** 图片异步任务终态 CAS 输入。 */
export type FinishImageAsyncTaskInput = z.input<
  typeof finishImageAsyncTaskInputSchema
>;

/** 图片异步仓储使用的最小 SQL 执行端口。 */
export interface ImageAsyncTaskTransaction {
  execute(query: SQL): Promise<unknown>;
}

/** 生产数据库与 DB-free 测试共用的最小事务入口。 */
export interface ImageAsyncTaskDatabase extends ImageAsyncTaskTransaction {
  transaction<T>(
    work: (transaction: ImageAsyncTaskTransaction) => Promise<T>
  ): Promise<T>;
}

/** 图片异步 UOL 与 Worker 使用的持久化端口。 */
export interface ImageAsyncTaskRepository {
  create(
    input: CreateImageAsyncTaskInput
  ): Promise<{ task: ImageAsyncTaskRecord; created: boolean }>;
  findById(taskId: string): Promise<ImageAsyncTaskRecord | null>;
  claimById(
    input: ClaimImageAsyncTaskInput
  ): Promise<ImageAsyncTaskRecord | null>;
  complete(
    input: FinishImageAsyncTaskInput
  ): Promise<ImageAsyncTaskRecord | null>;
  fail(input: FinishImageAsyncTaskInput): Promise<ImageAsyncTaskRecord | null>;
}

/** 将数据库 snake_case 行映射为应用稳定记录。 */
function parseImageAsyncTaskRow(value: unknown): ImageAsyncTaskRecord {
  const row = imageAsyncTaskRowSchema.parse(value);
  return {
    id: row.id,
    userId: row.user_id,
    apiKeyId: row.api_key_id,
    plan: row.plan,
    operation: row.operation,
    generationInputs: row.generation_inputs,
    generationIds: row.generation_ids,
    responseFormat: row.response_format,
    callbackUrl: row.callback_url,
    status: row.status,
    attemptCount: row.attempt_count,
    claimToken: row.claim_token,
    claimExpiresAt: row.claim_expires_at,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

/** 从 SQL 结果读取第一条任务；无匹配行时返回 null。 */
function parseFirstImageAsyncTaskRow(
  result: unknown
): ImageAsyncTaskRecord | null {
  const row = extractExecuteRows(result)[0];
  return row ? parseImageAsyncTaskRow(row) : null;
}

/** 生成图片异步任务所有读取路径共用的列清单。 */
function getImageAsyncTaskColumns(): SQL {
  return sql`
    id,
    user_id,
    api_key_id,
    plan,
    operation,
    generation_inputs,
    generation_ids,
    response_format,
    callback_url,
    status,
    attempt_count,
    claim_token,
    claim_expires_at,
    error,
    created_at,
    started_at,
    completed_at,
    updated_at
  `;
}

/**
 * 创建 PostgreSQL 图片异步任务仓储。
 *
 * @param database 可注入的参数化 SQL 与事务入口。
 * @returns 支持幂等创建、定向 claim 和终态 CAS 的仓储。
 */
export function createPostgresImageAsyncTaskRepository(
  database: ImageAsyncTaskDatabase
): ImageAsyncTaskRepository {
  const columns = getImageAsyncTaskColumns();

  return {
    async create(rawInput) {
      const input = createImageAsyncTaskInputSchema.parse(rawInput);
      const task = imageEnqueueAsyncInputSchema.parse(input.task);
      const operation = task.generationInputs[0]?.operation;
      if (!operation) {
        throw new Error("图片异步任务缺少 generation input");
      }
      const generationIds = task.generationInputs.map(
        (generationInput) => generationInput.generationId
      );
      return database.transaction(async (transaction) => {
        const insertedResult = await transaction.execute(sql`
          insert into image_async_task (
            id,
            user_id,
            api_key_id,
            plan,
            operation,
            generation_inputs,
            generation_ids,
            response_format,
            callback_url,
            status,
            created_at,
            updated_at
          ) values (
            ${task.taskId},
            ${input.userId},
            ${input.apiKeyId},
            ${input.plan},
            ${operation},
            ${JSON.stringify(task.generationInputs)}::json,
            ${JSON.stringify(generationIds)}::json,
            ${task.responseFormat},
            ${task.callbackUrl ?? null},
            'queued',
            ${input.now},
            ${input.now}
          )
          on conflict (id) do nothing
          returning ${columns}
        `);
        const inserted = parseFirstImageAsyncTaskRow(insertedResult);
        if (inserted) return { task: inserted, created: true };

        const existingResult = await transaction.execute(sql`
          select ${columns}
          from image_async_task
          where id = ${task.taskId}
          limit 1
        `);
        const existing = parseFirstImageAsyncTaskRow(existingResult);
        if (!existing) {
          throw new Error("图片异步任务幂等冲突后无法读取现有记录");
        }
        return { task: existing, created: false };
      });
    },

    async findById(taskId) {
      const parsedTaskId = imageAsyncTaskIdSchema.parse(taskId);
      const result = await database.execute(sql`
        select ${columns}
        from image_async_task
        where id = ${parsedTaskId}
        limit 1
      `);
      return parseFirstImageAsyncTaskRow(result);
    },

    async claimById(rawInput) {
      const input = claimImageAsyncTaskInputSchema.parse(rawInput);
      const result = await database.execute(sql`
        update image_async_task
        set status = 'running',
            attempt_count = attempt_count + 1,
            claim_token = ${input.claimToken},
            claim_expires_at = ${input.claimExpiresAt},
            started_at = coalesce(started_at, ${input.now}),
            updated_at = ${input.now}
        where id = ${input.taskId}
          and (
            status = 'queued'
            or (
              status = 'running'
              and claim_expires_at <= ${input.now}
            )
          )
        returning ${columns}
      `);
      return parseFirstImageAsyncTaskRow(result);
    },

    async complete(rawInput) {
      const input = finishImageAsyncTaskInputSchema.parse(rawInput);
      if (input.error !== undefined) {
        throw new Error("完成图片异步任务时不能携带错误");
      }
      const result = await database.execute(sql`
        update image_async_task
        set status = 'completed',
            claim_token = null,
            claim_expires_at = null,
            error = null,
            completed_at = ${input.now},
            updated_at = ${input.now}
        where id = ${input.taskId}
          and status = 'running'
          and claim_token = ${input.claimToken}
        returning ${columns}
      `);
      return parseFirstImageAsyncTaskRow(result);
    },

    async fail(rawInput) {
      const input = finishImageAsyncTaskInputSchema.parse(rawInput);
      if (input.error === undefined) {
        throw new Error("失败图片异步任务必须携带错误");
      }
      const result = await database.execute(sql`
        update image_async_task
        set status = 'failed',
            claim_token = null,
            claim_expires_at = null,
            error = ${input.error},
            completed_at = ${input.now},
            updated_at = ${input.now}
        where id = ${input.taskId}
          and status = 'running'
          and claim_token = ${input.claimToken}
        returning ${columns}
      `);
      return parseFirstImageAsyncTaskRow(result);
    },
  };
}

/** 默认生产仓储；数据库错误显式上抛并由 UOL 网关或 Worker 记录。 */
export const defaultImageAsyncTaskRepository: ImageAsyncTaskRepository =
  createPostgresImageAsyncTaskRepository({
    async execute(query) {
      const { db } = await import("@repo/database");
      return db.execute(query);
    },
    async transaction(work) {
      const { db } = await import("@repo/database");
      return db.transaction(async (transaction) =>
        work({ execute: (query) => transaction.execute(query) })
      );
    },
  });
