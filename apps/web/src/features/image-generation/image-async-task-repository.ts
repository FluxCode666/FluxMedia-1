/**
 * 图片异步任务 PostgreSQL 仓储。
 *
 * 职责：持久化已通过 UOL 校验的单项图片任务，Phase A 双写旧数组，并按任务 ID
 * 原子 claim、用 claim token 比较交换收敛终态。Redis 只承担唤醒和租约裁决。
 * 使用方：图片异步 UOL binding、BullMQ Worker 与数据库恢复扫描。
 */
import { createHash } from "node:crypto";
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
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
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
    generation_inputs: z.array(imageGenerateInputSchema).length(1),
    generation_ids: z.array(identifierSchema).length(1),
    generation_input: imageGenerateInputSchema,
    input_digest: z
      .string()
      .regex(/^(?:md5:[0-9a-f]{32}|sha256:[0-9a-f]{64})$/),
    generation_id: identifierSchema,
    effective_user_concurrency: z.coerce
      .number()
      .int()
      .min(1)
      .max(10_000)
      .nullable(),
    group_id_snapshot: identifierSchema.nullable(),
    group_priority_snapshot: z.coerce
      .number()
      .int()
      .min(0)
      .max(10_000)
      .nullable(),
    admission_lease_token: z.string().trim().min(1).max(256).nullable(),
    admission_lease_expires_at: z.coerce.date().nullable(),
    admission_lease_released_at: z.coerce.date().nullable(),
    mq_delivery_due_at: z.coerce.date().nullable(),
    claim_recovery_due_at: z.coerce.date().nullable(),
    admission_renewal_due_at: z.coerce.date().nullable(),
    terminal_release_due_at: z.coerce.date().nullable(),
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
    if (
      JSON.stringify(row.generation_inputs[0]) !==
        JSON.stringify(row.generation_input) ||
      row.generation_ids[0] !== row.generation_id
    ) {
      context.addIssue({
        code: "custom",
        path: ["generation_input"],
        message: "Legacy async columns do not match the single input",
      });
    }
    if (
      row.generation_input.operation !== row.operation ||
      row.generation_input.generationId !== row.generation_id
    ) {
      context.addIssue({
        code: "custom",
        path: ["generation_input"],
        message: "Persisted generation identity does not match the task",
      });
    }
    if (row.status === "queued" || row.status === "running") {
      if (!row.input_digest.startsWith("sha256:")) {
        context.addIssue({
          code: "custom",
          path: ["input_digest"],
          message: "Nonterminal task requires a SHA-256 input digest",
        });
      }
      if (
        row.effective_user_concurrency === null ||
        !row.group_id_snapshot ||
        row.group_priority_snapshot === null ||
        !row.admission_lease_token ||
        !row.admission_lease_expires_at
      ) {
        context.addIssue({
          code: "custom",
          path: ["effective_user_concurrency"],
          message: "Nonterminal task requires complete policy and lease state",
        });
      }
      if (row.admission_lease_released_at) {
        context.addIssue({
          code: "custom",
          path: ["admission_lease_released_at"],
          message: "Nonterminal task cannot have a released admission lease",
        });
      }
      if (!row.admission_renewal_due_at) {
        context.addIssue({
          code: "custom",
          path: ["admission_renewal_due_at"],
          message: "Nonterminal task requires admission renewal schedule",
        });
      }
    }
    if (
      Boolean(row.admission_lease_token) !==
      Boolean(row.admission_lease_expires_at)
    ) {
      context.addIssue({
        code: "custom",
        path: ["admission_lease_token"],
        message: "Admission lease token and expiration must be paired",
      });
    }
  });

const createImageAsyncTaskInputSchema = z
  .object({
    task: z.custom<ImageEnqueueAsyncInput>(),
    userId: identifierSchema,
    apiKeyId: identifierSchema,
    legacyPlan: identifierSchema,
    effectiveUserConcurrency: z.number().int().min(1).max(10_000),
    groupIdSnapshot: identifierSchema,
    groupPrioritySnapshot: z.number().int().min(0).max(10_000),
    admissionLeaseToken: z.string().trim().min(1).max(256),
    admissionLeaseExpiresAt: z.date(),
    admissionRenewalDueAt: z.date(),
    now: z.date(),
  })
  .strict()
  .refine(
    (input) =>
      input.admissionLeaseExpiresAt.getTime() > input.now.getTime() &&
      input.admissionRenewalDueAt.getTime() >= input.now.getTime() &&
      input.admissionRenewalDueAt.getTime() <
        input.admissionLeaseExpiresAt.getTime(),
    {
      path: ["admissionRenewalDueAt"],
      message: "Admission renewal must be due before lease expiration",
    }
  );

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

const updateImageAsyncAdmissionLeaseInputSchema = z
  .object({
    taskId: imageAsyncTaskIdSchema,
    admissionLeaseToken: z.string().trim().min(1).max(256),
    admissionLeaseExpiresAt: z.date(),
    admissionRenewalDueAt: z.date(),
    now: z.date(),
  })
  .strict()
  .refine(
    (input) =>
      input.admissionLeaseExpiresAt.getTime() > input.now.getTime() &&
      input.admissionRenewalDueAt.getTime() >= input.now.getTime() &&
      input.admissionRenewalDueAt.getTime() <
        input.admissionLeaseExpiresAt.getTime(),
    {
      path: ["admissionRenewalDueAt"],
      message: "Admission renewal must be due before lease expiration",
    }
  );

const heartbeatImageAsyncTaskClaimInputSchema = z
  .object({
    taskId: imageAsyncTaskIdSchema,
    claimToken: z.string().trim().min(1).max(256),
    admissionLeaseToken: z.string().trim().min(1).max(256),
    now: z.date(),
    claimExpiresAt: z.date(),
    admissionLeaseExpiresAt: z.date(),
    admissionRenewalDueAt: z.date(),
  })
  .strict()
  .refine(
    (input) =>
      input.claimExpiresAt.getTime() > input.now.getTime() &&
      input.admissionLeaseExpiresAt.getTime() > input.now.getTime() &&
      input.admissionRenewalDueAt.getTime() >= input.now.getTime() &&
      input.admissionRenewalDueAt.getTime() <
        input.admissionLeaseExpiresAt.getTime(),
    {
      path: ["claimExpiresAt"],
      message: "Claim expiration must be later than heartbeat time",
    }
  );

const markImageAsyncMqDeliveredInputSchema = z
  .object({
    taskId: imageAsyncTaskIdSchema,
    now: z.date(),
  })
  .strict();

const markImageAsyncAdmissionReleasedInputSchema = z
  .object({
    taskId: imageAsyncTaskIdSchema,
    admissionLeaseToken: z.string().trim().min(1).max(256),
    now: z.date(),
  })
  .strict();

/** 一条已验证的持久图片异步任务。 */
export interface ImageAsyncTaskRecord {
  id: string;
  userId: string;
  apiKeyId: string;
  operation: "generate" | "edit" | "mask";
  generationInput: ImageGenerateOperationInput;
  inputDigest: string;
  generationId: string;
  effectiveUserConcurrency: number | null;
  groupIdSnapshot: string | null;
  groupPrioritySnapshot: number | null;
  admissionLeaseToken: string | null;
  admissionLeaseExpiresAt: Date | null;
  admissionLeaseReleasedAt: Date | null;
  mqDeliveryDueAt: Date | null;
  claimRecoveryDueAt: Date | null;
  admissionRenewalDueAt: Date | null;
  terminalReleaseDueAt: Date | null;
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

/** 为新单项 writer 生成带算法前缀的稳定输入摘要。 */
export function createImageAsyncTaskInputDigest(
  input: ImageGenerateOperationInput
): string {
  const parsed = imageGenerateInputSchema.parse(input);
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(parsed))
    .digest("hex")}`;
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
  updateAdmissionLease(
    input: z.input<typeof updateImageAsyncAdmissionLeaseInputSchema>
  ): Promise<ImageAsyncTaskRecord | null>;
  markMqDelivered(
    input: z.input<typeof markImageAsyncMqDeliveredInputSchema>
  ): Promise<ImageAsyncTaskRecord | null>;
  heartbeatClaim(
    input: z.input<typeof heartbeatImageAsyncTaskClaimInputSchema>
  ): Promise<ImageAsyncTaskRecord | null>;
  markAdmissionReleased(
    input: z.input<typeof markImageAsyncAdmissionReleasedInputSchema>
  ): Promise<ImageAsyncTaskRecord | null>;
  claimById(
    input: ClaimImageAsyncTaskInput
  ): Promise<ImageAsyncTaskRecord | null>;
  release(
    input: FinishImageAsyncTaskInput
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
    operation: row.operation,
    generationInput: row.generation_input,
    inputDigest: row.input_digest,
    generationId: row.generation_id,
    effectiveUserConcurrency: row.effective_user_concurrency,
    groupIdSnapshot: row.group_id_snapshot,
    groupPrioritySnapshot: row.group_priority_snapshot,
    admissionLeaseToken: row.admission_lease_token,
    admissionLeaseExpiresAt: row.admission_lease_expires_at,
    admissionLeaseReleasedAt: row.admission_lease_released_at,
    mqDeliveryDueAt: row.mq_delivery_due_at,
    claimRecoveryDueAt: row.claim_recovery_due_at,
    admissionRenewalDueAt: row.admission_renewal_due_at,
    terminalReleaseDueAt: row.terminal_release_due_at,
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
    generation_input,
    input_digest,
    generation_id,
    effective_user_concurrency,
    group_id_snapshot,
    group_priority_snapshot,
    admission_lease_token,
    admission_lease_expires_at,
    admission_lease_released_at,
    mq_delivery_due_at,
    claim_recovery_due_at,
    admission_renewal_due_at,
    terminal_release_due_at,
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
      const generationInput = task.generationInput;
      const generationId = generationInput.generationId;
      const inputDigest = createImageAsyncTaskInputDigest(generationInput);
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
            generation_input,
            input_digest,
            generation_id,
            effective_user_concurrency,
            group_id_snapshot,
            group_priority_snapshot,
            admission_lease_token,
            admission_lease_expires_at,
            mq_delivery_due_at,
            admission_renewal_due_at,
            response_format,
            callback_url,
            status,
            created_at,
            updated_at
          ) values (
            ${task.taskId},
            ${input.userId},
            ${input.apiKeyId},
            ${input.legacyPlan},
            ${generationInput.operation},
            ${JSON.stringify([generationInput])}::json,
            ${JSON.stringify([generationId])}::json,
            ${JSON.stringify(generationInput)}::json,
            ${inputDigest},
            ${generationId},
            ${input.effectiveUserConcurrency},
            ${input.groupIdSnapshot},
            ${input.groupPrioritySnapshot},
            ${input.admissionLeaseToken},
            ${input.admissionLeaseExpiresAt},
            ${input.now},
            ${input.admissionRenewalDueAt},
            ${task.responseFormat},
            ${task.callbackUrl ?? null},
            'queued',
            ${input.now},
            ${input.now}
          )
          on conflict do nothing
          returning ${columns}
        `);
        const inserted = parseFirstImageAsyncTaskRow(insertedResult);
        if (inserted) return { task: inserted, created: true };

        const existingResult = await transaction.execute(sql`
          select ${columns}
          from image_async_task
          where id = ${task.taskId}
             or generation_id = ${generationId}
          order by case when id = ${task.taskId} then 0 else 1 end
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

    async updateAdmissionLease(rawInput) {
      const input = updateImageAsyncAdmissionLeaseInputSchema.parse(rawInput);
      const result = await database.execute(sql`
        update image_async_task
        set admission_lease_expires_at = ${input.admissionLeaseExpiresAt},
            admission_renewal_due_at = ${input.admissionRenewalDueAt},
            updated_at = ${input.now}
        where id = ${input.taskId}
          and status in ('queued', 'running')
          and admission_lease_token = ${input.admissionLeaseToken}
          and admission_lease_released_at is null
        returning ${columns}
      `);
      return parseFirstImageAsyncTaskRow(result);
    },

    async markMqDelivered(rawInput) {
      const input = markImageAsyncMqDeliveredInputSchema.parse(rawInput);
      const result = await database.execute(sql`
        update image_async_task
        set mq_delivery_due_at = null,
            updated_at = ${input.now}
        where id = ${input.taskId}
          and status = 'queued'
        returning ${columns}
      `);
      return parseFirstImageAsyncTaskRow(result);
    },

    async heartbeatClaim(rawInput) {
      const input = heartbeatImageAsyncTaskClaimInputSchema.parse(rawInput);
      const result = await database.execute(sql`
        update image_async_task
        set claim_expires_at = ${input.claimExpiresAt},
            claim_recovery_due_at = ${input.claimExpiresAt},
            admission_lease_expires_at = ${input.admissionLeaseExpiresAt},
            admission_renewal_due_at = ${input.admissionRenewalDueAt},
            updated_at = ${input.now}
        where id = ${input.taskId}
          and status = 'running'
          and claim_token = ${input.claimToken}
          and admission_lease_token = ${input.admissionLeaseToken}
          and admission_lease_released_at is null
        returning ${columns}
      `);
      return parseFirstImageAsyncTaskRow(result);
    },

    async markAdmissionReleased(rawInput) {
      const input = markImageAsyncAdmissionReleasedInputSchema.parse(rawInput);
      const result = await database.execute(sql`
        update image_async_task
        set admission_lease_released_at = ${input.now},
            terminal_release_due_at = null,
            updated_at = ${input.now}
        where id = ${input.taskId}
          and status in ('completed', 'failed')
          and admission_lease_token = ${input.admissionLeaseToken}
          and admission_lease_released_at is null
        returning ${columns}
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
            mq_delivery_due_at = null,
            claim_recovery_due_at = ${input.claimExpiresAt},
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

    async release(rawInput) {
      const input = finishImageAsyncTaskInputSchema.parse(rawInput);
      if (input.error !== undefined) {
        throw new Error("释放图片异步任务 claim 时不能携带错误");
      }
      const result = await database.execute(sql`
        update image_async_task
        set status = 'queued',
            claim_token = null,
            claim_expires_at = null,
            mq_delivery_due_at = ${input.now},
            claim_recovery_due_at = null,
            updated_at = ${input.now}
        where id = ${input.taskId}
          and status = 'running'
          and claim_token = ${input.claimToken}
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
            mq_delivery_due_at = null,
            claim_recovery_due_at = null,
            admission_renewal_due_at = null,
            terminal_release_due_at = ${input.now},
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
            mq_delivery_due_at = null,
            claim_recovery_due_at = null,
            admission_renewal_due_at = null,
            terminal_release_due_at = ${input.now},
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
