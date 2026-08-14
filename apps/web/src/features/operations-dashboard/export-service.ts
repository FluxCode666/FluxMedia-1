/**
 * 运营异步导出应用服务。
 *
 * 使用方：operations 导出 UOL binding 和下载路由。负责冻结规范化范围、创建者幂等、
 * 失败重试、HMAC 列表游标与下载许可；对象定位只提供给受控路由，不穿过公共契约。
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { logError } from "@repo/shared/logger";
import type { OperationsExportTask } from "@repo/shared/operations-dashboard/contracts";
import {
  operationsCreateExportInputSchema,
  operationsListExportsInputSchema,
  operationsPrepareExportDownloadInputSchema,
  operationsRetryExportInputSchema,
} from "@repo/shared/operations-dashboard/contracts";
import type { OperationsOpenLocalExportDownloadOutput } from "@repo/shared/operations-dashboard/output-contracts";
import { z } from "zod";
import {
  getOperationsExportStorage,
  OPERATIONS_EXPORT_DOWNLOAD_TTL_SECONDS,
  type OperationsExportStorage,
} from "./export-storage";
import {
  type DownloadableOperationsExportTask,
  databaseOperationsExportTaskRepository,
  type OperationsExportTaskRepository,
} from "./export-task-repository";

const PER_ADMIN_ACTIVE_LIMIT = 3;
const GLOBAL_ACTIVE_LIMIT = 100;
const MIN_CREATE_INTERVAL_MS = 2_000;
const LIST_CURSOR_DOMAIN = "fluxmedia:operations-export:list:v1";

/** UOL 可稳定映射且不泄露数据库或存储细节的领域错误。 */
export class OperationsExportServiceError extends Error {
  /** 创建导出公开错误。 */
  constructor(
    readonly code:
      | "validation_error"
      | "not_ready"
      | "not_found"
      | "conflict"
      | "rate_limited"
      | "storage_unavailable",
    message: string
  ) {
    super(message);
    this.name = "OperationsExportServiceError";
  }
}

/** service 的可替换依赖。 */
export type OperationsExportServiceDependencies = {
  repository: OperationsExportTaskRepository;
  now(): Date;
  createId(): string;
  tokenSecret?: string;
  getStorage?(): Promise<OperationsExportStorage>;
};

const defaultDependencies: OperationsExportServiceDependencies = {
  repository: databaseOperationsExportTaskRepository,
  now: () => new Date(),
  createId: () => crypto.randomUUID(),
};

const listCursorSchema = z
  .object({
    sub: z.string().min(1),
    createdAt: z.string().datetime({ offset: true }),
    id: z.string().min(1),
  })
  .strict();

/** 获取认证密钥；缺失时禁止发放可篡改的列表游标。 */
function requireSecret(explicit?: string): string {
  const secret = explicit ?? process.env.BETTER_AUTH_SECRET;
  if (!secret?.trim()) {
    throw new OperationsExportServiceError(
      "not_ready",
      "运营导出游标密钥尚未配置"
    );
  }
  return secret;
}

/** 签名列表 cursor，避免管理员横向复用另一账号的水位。 */
function encodeListCursor(
  payload: { sub: string; createdAt: string; id: string },
  secret: string
): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(LIST_CURSOR_DOMAIN)
    .update("\0")
    .update(body)
    .digest("base64url");
  return `${body}.${signature}`;
}

/** 校验列表 cursor 的签名与创建者绑定。 */
function decodeListCursor(token: string, createdBy: string, secret: string) {
  try {
    const [body, signature, extra] = token.split(".");
    if (!body || !signature || extra !== undefined) throw new Error("shape");
    const expected = createHmac("sha256", secret)
      .update(LIST_CURSOR_DOMAIN)
      .update("\0")
      .update(body)
      .digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new Error("signature");
    const parsed = listCursorSchema.parse(
      JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown
    );
    if (parsed.sub !== createdBy) throw new Error("subject");
    return { createdAt: new Date(parsed.createdAt), id: parsed.id };
  } catch {
    throw new OperationsExportServiceError(
      "validation_error",
      "运营导出列表游标无效"
    );
  }
}

/** 将数据库任务投影为不会泄露对象 key/租约的公共摘要。 */
function adaptTask(
  task: Awaited<
    ReturnType<OperationsExportTaskRepository["findOwned"]>
  > extends infer _T
    ? import("@repo/database/schema").OperationsExportTask
    : never
): OperationsExportTask {
  const parsedQuery = operationsCreateExportInputSchema.shape.query.parse(
    task.query
  );
  return {
    id: task.id,
    exportType: operationsCreateExportInputSchema.shape.exportType.parse(
      task.exportType
    ),
    status: z
      .enum(["queued", "running", "completed", "failed", "expired"])
      .parse(task.status),
    query: parsedQuery,
    createdAt: task.createdAt.toISOString(),
    completedAt: task.completedAt?.toISOString() ?? null,
    expiresAt: task.expiresAt?.toISOString() ?? null,
    rowCount: task.rowCount,
    byteCount: task.byteCount,
    errorCode: task.errorCode,
    retryOfTaskId: task.retryOfTaskId,
  };
}

/** 将创建与重试共享的仓储拒绝收敛为可恢复领域错误。 */
function throwCreateError(error: unknown): never {
  if (error instanceof OperationsExportServiceError) throw error;
  if (
    error instanceof Error &&
    error.message === "operations_export_capacity_exceeded"
  )
    throw new OperationsExportServiceError(
      "conflict",
      "运营导出队列已满，请稍后重试"
    );
  if (
    error instanceof Error &&
    error.message === "operations_export_rate_limited"
  )
    throw new OperationsExportServiceError(
      "rate_limited",
      "运营导出创建过于频繁"
    );
  if (error instanceof Error && error.message === "operations_export_not_ready")
    throw new OperationsExportServiceError(
      "not_ready",
      "运营统计起点尚未初始化"
    );
  throw error;
}

/** 创建幂等导出任务，并冻结范围、epoch、snapshot 与高水位。 */
export async function createOperationsExport(
  request: { createdBy: string; timeZone: string; input: unknown },
  dependencies: OperationsExportServiceDependencies = defaultDependencies
) {
  const parsed = operationsCreateExportInputSchema.safeParse(request.input);
  if (!parsed.success)
    throw new OperationsExportServiceError(
      "validation_error",
      "运营导出参数无效"
    );
  try {
    const task = await dependencies.repository.create({
      taskId: dependencies.createId(),
      createdBy: request.createdBy,
      clientRequestId: parsed.data.clientRequestId,
      exportType: parsed.data.exportType,
      query: parsed.data.query,
      timeZone: request.timeZone,
      retryOfTaskId: null,
      now: dependencies.now(),
      perAdminLimit: PER_ADMIN_ACTIVE_LIMIT,
      globalLimit: GLOBAL_ACTIVE_LIMIT,
      minCreateIntervalMs: MIN_CREATE_INTERVAL_MS,
    });
    return { task: adaptTask(task) };
  } catch (error) {
    throwCreateError(error);
  }
}

/** 只列出当前管理员自己的任务，并返回 HMAC 绑定的 keyset cursor。 */
export async function listOperationsExports(
  request: { createdBy: string; input: unknown },
  dependencies: OperationsExportServiceDependencies = defaultDependencies
) {
  const parsed = operationsListExportsInputSchema.safeParse(request.input);
  if (!parsed.success)
    throw new OperationsExportServiceError(
      "validation_error",
      "运营导出列表参数无效"
    );
  const secret = requireSecret(dependencies.tokenSecret);
  const cursor = parsed.data.cursor
    ? decodeListCursor(parsed.data.cursor, request.createdBy, secret)
    : null;
  const rows = await dependencies.repository.list({
    createdBy: request.createdBy,
    cursor,
    limit: parsed.data.limit + 1,
  });
  const page = rows.slice(0, parsed.data.limit);
  const last = page.at(-1);
  return {
    tasks: page.map(adaptTask),
    nextCursor:
      rows.length > parsed.data.limit && last
        ? encodeListCursor(
            {
              sub: request.createdBy,
              createdAt: last.createdAt.toISOString(),
              id: last.id,
            },
            secret
          )
        : null,
  };
}

/** 只允许失败且属于当前管理员的父任务生成新记录。 */
export async function retryOperationsExport(
  request: { createdBy: string; input: unknown },
  dependencies: OperationsExportServiceDependencies = defaultDependencies
) {
  const parsed = operationsRetryExportInputSchema.safeParse(request.input);
  if (!parsed.success)
    throw new OperationsExportServiceError(
      "validation_error",
      "运营导出重试参数无效"
    );
  const parent = await dependencies.repository.findOwned(
    parsed.data.taskId,
    request.createdBy
  );
  if (!parent)
    throw new OperationsExportServiceError("not_found", "运营导出任务不存在");
  if (parent.status !== "failed")
    throw new OperationsExportServiceError(
      "conflict",
      "只有失败的运营导出可以重试"
    );
  const query = operationsCreateExportInputSchema.shape.query.parse(
    parent.query
  );
  try {
    const task = await dependencies.repository.create({
      taskId: dependencies.createId(),
      createdBy: request.createdBy,
      clientRequestId: parsed.data.clientRequestId,
      exportType: operationsCreateExportInputSchema.shape.exportType.parse(
        parent.exportType
      ),
      query,
      timeZone: parent.timeZone,
      retryOfTaskId: parent.id,
      now: dependencies.now(),
      perAdminLimit: PER_ADMIN_ACTIVE_LIMIT,
      globalLimit: GLOBAL_ACTIVE_LIMIT,
      minCreateIntervalMs: MIN_CREATE_INTERVAL_MS,
    });
    return { task: adaptTask(task) };
  } catch (error) {
    throwCreateError(error);
  }
}

/**
 * 校验下载归属、状态与七天边界；S3 返回短期签名，本地只返回受控路由模式。
 */
export async function prepareOperationsExportDownload(
  request: {
    createdBy: string;
    input: unknown;
    localDownloadUrl(taskId: string): string;
  },
  dependencies: OperationsExportServiceDependencies = defaultDependencies
) {
  const parsed = operationsPrepareExportDownloadInputSchema.safeParse(
    request.input
  );
  if (!parsed.success)
    throw new OperationsExportServiceError(
      "validation_error",
      "运营导出下载参数无效"
    );
  const now = dependencies.now();
  const task = await dependencies.repository.findDownloadable(
    parsed.data.taskId,
    request.createdBy,
    now
  );
  if (!task)
    throw new OperationsExportServiceError(
      "not_found",
      "运营导出不存在、未完成或已过期"
    );
  const remainingSeconds = Math.floor(
    (task.expiresAt.getTime() - now.getTime()) / 1000
  );
  if (remainingSeconds < 1) {
    throw new OperationsExportServiceError(
      "not_found",
      "运营导出不存在、未完成或已过期"
    );
  }
  try {
    const storage = await (dependencies.getStorage?.() ??
      getOperationsExportStorage());
    const expiresIn = Math.min(
      OPERATIONS_EXPORT_DOWNLOAD_TTL_SECONDS,
      remainingSeconds
    );
    const mode = storage.remote ? ("redirect" as const) : ("stream" as const);
    const downloadUrl = storage.remote
      ? await storage.getSignedUrl(task.objectKey, task.objectBucket, expiresIn)
      : request.localDownloadUrl(task.id);
    await dependencies.repository.recordDownload({
      taskId: task.id,
      createdBy: request.createdBy,
      mode,
      result: "granted",
      now,
    });
    return {
      taskId: task.id,
      mode,
      downloadUrl,
      expiresAt: new Date(now.getTime() + expiresIn * 1000).toISOString(),
    };
  } catch (error) {
    try {
      await dependencies.repository.recordDownload({
        taskId: task.id,
        createdBy: request.createdBy,
        mode: "stream",
        result: "storage_unavailable",
        now,
      });
    } catch (auditError) {
      logError(auditError, {
        source: "operations-export-download-audit",
        taskId: task.id,
        result: "storage_unavailable",
      });
    }
    logError(error, {
      source: "operations-export-download-storage",
      taskId: task.id,
    });
    throw new OperationsExportServiceError(
      "storage_unavailable",
      "运营导出存储暂不可用"
    );
  }
}

/** 受控本地路由复用相同归属和过期校验并返回内部对象位置。 */
export async function getOperationsExportDownloadTarget(
  input: { taskId: string; createdBy: string; now?: Date },
  repository: OperationsExportTaskRepository = databaseOperationsExportTaskRepository
): Promise<DownloadableOperationsExportTask> {
  const task = await repository.findDownloadable(
    input.taskId,
    input.createdBy,
    input.now ?? new Date()
  );
  if (!task)
    throw new OperationsExportServiceError(
      "not_found",
      "运营导出不存在、未完成或已过期"
    );
  return task;
}

/** 本地下载 operation 所需的最小可替换依赖。 */
export type OperationsLocalExportDownloadDependencies = {
  repository: OperationsExportTaskRepository;
  now(): Date;
  getStorage?(): Promise<OperationsExportStorage>;
};

/** 把任务标识收敛为安全的 Content-Disposition 文件名片段。 */
function normalizeDownloadFilenamePart(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 255);
  return normalized || "export";
}

/**
 * 打开当前管理员自己的本地 CSV 字节流并记录开始审计。
 *
 * @param request 已由 UOL 鉴权的管理员、任务标识。
 * @param dependencies 可替换的任务仓储、时间和存储 provider。
 * @returns 只供同进程 HTTP 适配器消费的文件元数据和异步字节流。
 * @sideEffects 读取对象存储并写入下载审计。
 * @failure 远端 provider 返回 conflict；对象读取或审计失败返回 storage_unavailable。
 */
export async function openOperationsLocalExportDownload(
  request: { taskId: string; createdBy: string },
  dependencies: OperationsLocalExportDownloadDependencies = {
    repository: databaseOperationsExportTaskRepository,
    now: () => new Date(),
  }
): Promise<OperationsOpenLocalExportDownloadOutput> {
  const task = await getOperationsExportDownloadTarget(
    {
      taskId: request.taskId,
      createdBy: request.createdBy,
      now: dependencies.now(),
    },
    dependencies.repository
  );
  try {
    const storage = await (dependencies.getStorage?.() ??
      getOperationsExportStorage());
    if (storage.remote) {
      throw new OperationsExportServiceError(
        "conflict",
        "远端运营导出必须使用短期签名 URL"
      );
    }
    const stream = await storage.getObjectStream(
      task.objectKey,
      task.objectBucket
    );
    await dependencies.repository.recordDownload({
      taskId: task.id,
      createdBy: request.createdBy,
      mode: "stream",
      result: "started",
      now: dependencies.now(),
    });
    return {
      taskId: task.id,
      filename: `operations-${task.exportType}-${normalizeDownloadFilenamePart(task.id)}.csv`,
      contentType: "text/csv; charset=utf-8",
      stream,
    };
  } catch (error) {
    if (
      error instanceof OperationsExportServiceError &&
      error.code === "conflict"
    ) {
      throw error;
    }
    try {
      await dependencies.repository.recordDownload({
        taskId: task.id,
        createdBy: request.createdBy,
        mode: "stream",
        result: "storage_unavailable",
        now: dependencies.now(),
      });
    } catch (auditError) {
      logError(auditError, {
        source: "operations-export-download-audit",
        taskId: task.id,
        result: "storage_unavailable",
      });
    }
    logError(error, {
      source: "operations-export-local-download",
      taskId: task.id,
    });
    throw new OperationsExportServiceError(
      "storage_unavailable",
      "运营导出存储暂不可用"
    );
  }
}
