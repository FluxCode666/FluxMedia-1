/**
 * 运营 CSV 导出 worker 与七天清理执行器。
 *
 * 使用方：operations.processExports / expireExports 内部 UOL binding。worker 从仓储领取
 * 带 fencing token 的冻结任务，按 keyset 读取同源事实、流式上传并条件完成；过期先在
 * 数据库拒绝下载，再独立幂等删除对象。
 */
import { randomUUID } from "node:crypto";

import {
  amountMinorToMajor,
  getCurrencyMinorUnitExponent,
} from "@repo/shared/credits/top-up";
import { logError, logger } from "@repo/shared/logger";
import type { OperationsExportType } from "@repo/shared/operations-dashboard/contracts";
import { addOperationsCalendarDays } from "@repo/shared/operations-dashboard/range";
import {
  getTimeZoneOffsetMinutes,
  normalizeTimeZone,
  parseDateInputInTimeZone,
} from "@repo/shared/time-zone";

import { type OperationsCsvCell, streamOperationsCsv } from "./csv-encoder";
import {
  databaseOperationsGrowthDetailRepository,
  type OperationsDetailCursor,
  type OperationsDetailHighWatermarks,
  type OperationsDetailQuery,
  type OperationsDetailRepository,
  type OperationsDetailRow,
} from "./detail-repository";
import {
  buildOperationsExportObjectKey,
  createMeasuredExportStream,
  getOperationsExportStorage,
  type OperationsExportStorage,
  parseOperationsExportObjectKey,
} from "./export-storage";
import {
  type ClaimedOperationsExportTask,
  databaseOperationsExportTaskRepository,
  OPERATIONS_EXPORT_LEASE_MS,
  OPERATIONS_EXPORT_RETENTION_MS,
  type OperationsExportTaskRepository,
  parseOperationsExportHighWatermarks,
} from "./export-task-repository";

const EXPORT_PAGE_SIZE = 1_000;
const EXPORT_LEASE_RENEW_INTERVAL_MS = 30_000;
const EXPORT_ORPHAN_SCAN_PREFIX = "operations-exports/";
const EXPORT_ORPHAN_SAFETY_MS = OPERATIONS_EXPORT_LEASE_MS;

/** 进程内 opaque cursor；重启后从前缀起点重扫，删除与引用检查均保持幂等。 */
let storageObjectScanCursor: string | null = null;
let multipartUploadScanCursor: string | null = null;

/** worker 可注入端口；测试替换数据库、存储、时钟和 UUID。 */
export type OperationsExportWorkerDependencies = {
  repository: Pick<
    OperationsExportTaskRepository,
    "claimNext" | "renewLease" | "complete" | "fail" | "recordOrphan"
  >;
  storage: Pick<
    OperationsExportStorage,
    "bucket" | "putObjectStream" | "deleteObject"
  >;
  createRows?(
    task: ClaimedOperationsExportTask
  ): AsyncIterable<readonly OperationsCsvCell[]>;
  now(): Date;
  createToken(): string;
  leaseRenewIntervalMs?: number;
};

/** 七天清理可替换端口。 */
export type OperationsExportCleanupDependencies = {
  repository: Pick<
    OperationsExportTaskRepository,
    | "expireDue"
    | "markDeleted"
    | "markCleanupFailed"
    | "listOrphans"
    | "markOrphanDeleted"
    | "findReferencedObjectKeys"
    | "findActiveExportLeases"
  >;
  storage: Pick<
    OperationsExportStorage,
    | "bucket"
    | "deleteObject"
    | "listObjects"
    | "listMultipartUploads"
    | "abortMultipartUpload"
  >;
  now(): Date;
};

/** 独立于数据库行产出续租，避免慢查询或慢上传期间租约静默过期。 */
function startLeaseRenewal(
  task: ClaimedOperationsExportTask,
  dependencies: OperationsExportWorkerDependencies
): {
  signal: AbortSignal;
  stop(): Promise<void>;
  throwIfLost(): void;
} {
  const controller = new AbortController();
  let stopped = false;
  let failure: unknown;
  let renewal: Promise<void> | null = null;
  const interval = Math.max(
    1,
    dependencies.leaseRenewIntervalMs ?? EXPORT_LEASE_RENEW_INTERVAL_MS
  );

  /** 单次续租失败即终止底层存储 I/O；不允许陈旧 worker 继续生成完整对象。 */
  const renew = async () => {
    try {
      const renewed = await dependencies.repository.renewLease({
        taskId: task.id,
        leaseToken: task.leaseToken,
        now: dependencies.now(),
      });
      if (!renewed) throw new Error("运营导出租约已失效");
    } catch (error) {
      failure = error;
      controller.abort(error);
    }
  };

  const timer = setInterval(() => {
    if (stopped || failure !== undefined || renewal) return;
    renewal = renew().finally(() => {
      renewal = null;
    });
  }, interval);

  const throwIfLost = () => {
    if (failure !== undefined) throw failure;
    if (controller.signal.aborted) throw new Error("运营导出租约已失效");
  };
  return {
    signal: controller.signal,
    throwIfLost,
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (renewal) await renewal;
      throwIfLost();
    },
  };
}

/** 在每次拉取业务行前后检查独立租约守护的取消状态。 */
function withLeaseSignal(
  source: AsyncIterable<readonly OperationsCsvCell[]>,
  signal: AbortSignal
): AsyncIterable<readonly OperationsCsvCell[]> {
  return (async function* () {
    if (signal.aborted) throw signal.reason;
    for await (const row of source) {
      if (signal.aborted) throw signal.reason;
      yield row;
    }
    if (signal.aborted) throw signal.reason;
  })();
}

type CsvDefinition = {
  headers: readonly string[];
  mapRow(
    row: OperationsDetailRow,
    timeZone: string
  ): readonly OperationsCsvCell[];
};

type ExportQuerySpec = {
  kind: OperationsDetailQuery["kind"];
  label: string;
  activityKind?: "login" | "creation" | "payment";
  cohortDate?: string;
  retentionDay?: 1 | 7 | 30;
};

/** 登记孤儿候选；审计不可用时记录错误，但不能改变 fencing 后的对象决策。 */
async function recordOrphanBestEffort(
  repository: Pick<OperationsExportTaskRepository, "recordOrphan">,
  input: Parameters<OperationsExportTaskRepository["recordOrphan"]>[0]
): Promise<void> {
  try {
    await repository.recordOrphan(input);
  } catch (error) {
    logError(error, {
      source: "operations-export-orphan-audit",
      taskId: input.taskId,
      errorCode: input.errorCode,
    });
  }
}

/** 按币种最小单位固定小数位导出金额，避免 CSV 浮点表示丢失尾随零。 */
export function formatOperationsExportAmount(
  amountMinor: number,
  currency: string
): string {
  return amountMinorToMajor(amountMinor, currency).toFixed(
    getCurrencyMinorUnitExponent(currency)
  );
}

/** 把具体 UTC 瞬间导出为带应用时区偏移的 ISO 8601。 */
export function formatOperationsExportDateTime(
  date: Date,
  timeZone: string
): string {
  const normalized = normalizeTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: normalized,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hourCycle: "h23",
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const offsetMinutes = getTimeZoneOffsetMinutes(date, normalized);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
  return `${read("year")}-${read("month")}-${read("day")}T${read("hour")}:${read("minute")}:${read("second")}.${read("fractionalSecond")}${offset}`;
}

/** 三类 CSV 的稳定中文表头、数据源顺序和安全字段映射。 */
const CSV_DEFINITIONS: Record<OperationsExportType, CsvDefinition> = {
  user_growth: {
    headers: [
      "记录类型",
      "用户 ID",
      "名称",
      "邮箱",
      "业务时间",
      "角色",
      "封禁",
      "留存",
    ],
    mapRow(row, timeZone) {
      if (!("userId" in row) || "taskId" in row || "paymentOrderId" in row)
        throw new Error("运营增长导出收到不匹配的行");
      return [
        row.kind,
        row.userId,
        row.name,
        row.email,
        formatOperationsExportDateTime(row.businessTime, timeZone),
        row.role,
        row.banned,
        row.retained,
      ];
    },
  },
  commercialization: {
    headers: [
      "记录类型",
      "平台订单 ID",
      "支付渠道交易号",
      "用户 ID",
      "币种",
      "金额",
      "订单状态",
      "创建时间",
      "履约时间",
      "生命周期事件",
    ],
    mapRow(row, timeZone) {
      if (!("paymentOrderId" in row))
        throw new Error("商业化导出收到不匹配的行");
      return [
        row.kind,
        row.paymentOrderId,
        row.providerTradeNo,
        row.userId,
        row.currency,
        formatOperationsExportAmount(row.amountMinor, row.currency),
        row.orderStatus,
        formatOperationsExportDateTime(row.createdAt, timeZone),
        row.fulfilledAt
          ? formatOperationsExportDateTime(row.fulfilledAt, timeZone)
          : null,
        row.eventType,
      ];
    },
  },
  content_production: {
    headers: [
      "任务 ID",
      "用户 ID",
      "模型",
      "媒体类型",
      "业务时间",
      "状态",
      "数量",
      "视频秒数",
      "积分净用量",
    ],
    mapRow(row, timeZone) {
      if (!("taskId" in row)) throw new Error("内容生产导出收到不匹配的行");
      return [
        row.taskId,
        row.userId,
        row.model,
        row.mediaType,
        formatOperationsExportDateTime(row.businessTime, timeZone),
        row.status,
        row.quantity,
        row.videoSeconds,
        row.netCredits.toFixed(2),
      ];
    },
  },
};

/** 从冻结范围构造不依赖页面 cursor 的 UTC 半开边界。 */
function resolveFrozenRange(task: ClaimedOperationsExportTask): {
  start: Date;
  end: Date;
} {
  if (task.query.range.kind !== "custom") {
    throw new Error("导出任务未冻结为自定义日期范围");
  }
  const start = parseDateInputInTimeZone(task.query.range.from, {
    timeZone: task.timeZone,
  });
  const nextDate = new Date(`${task.query.range.to}T00:00:00.000Z`);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  const fullEnd = parseDateInputInTimeZone(
    nextDate.toISOString().slice(0, 10),
    {
      timeZone: task.timeZone,
    }
  );
  if (!start || !fullEnd) throw new Error("导出任务日期范围无效");
  return { start, end: fullEnd > task.snapshotAt ? task.snapshotAt : fullEnd };
}

/** 按导出类型构造与 detail repository 同源的查询序列。 */
function buildQueries(input: {
  task: ClaimedOperationsExportTask;
  cursor: OperationsDetailCursor | null;
  highWatermarks: OperationsDetailHighWatermarks;
  kind: OperationsDetailQuery["kind"];
  cohortDate?: string;
  retentionDay?: 1 | 7 | 30;
}): OperationsDetailQuery {
  const range = resolveFrozenRange(input.task);
  const base = {
    start:
      range.start < input.task.epochStartsAt
        ? input.task.epochStartsAt
        : range.start,
    end: range.end,
    epochStart: input.task.epochStartsAt,
    asOf: input.task.snapshotAt,
    cursor: input.cursor,
    limit: EXPORT_PAGE_SIZE + 1,
    highWatermarks: input.highWatermarks,
  };
  if (base.start >= base.end) {
    throw new Error("导出任务日期范围位于统计起点之前");
  }
  if (input.kind === "users") return { ...base, kind: "users" };
  if (input.kind === "orders") return { ...base, kind: "orders" };
  if (input.kind === "payment_lifecycle")
    return { ...base, kind: "payment_lifecycle" };
  if (input.kind === "content")
    return { ...base, kind: "content", detail: "credit_usage" };
  if (input.kind === "activity")
    return { ...base, kind: "activity", activityKind: "login" };
  if (input.kind === "cohort" && input.cohortDate && input.retentionDay) {
    const cohortStart = parseDateInputInTimeZone(input.cohortDate, {
      timeZone: input.task.timeZone,
    });
    const cohortEnd = parseDateInputInTimeZone(
      addOperationsCalendarDays(input.cohortDate, 1),
      { timeZone: input.task.timeZone }
    );
    const targetStart = parseDateInputInTimeZone(
      addOperationsCalendarDays(input.cohortDate, input.retentionDay),
      { timeZone: input.task.timeZone }
    );
    const targetEnd = parseDateInputInTimeZone(
      addOperationsCalendarDays(input.cohortDate, input.retentionDay + 1),
      { timeZone: input.task.timeZone }
    );
    if (!cohortStart || !cohortEnd || !targetStart || !targetEnd)
      throw new Error("导出 Cohort 日期无效");
    return {
      ...base,
      kind: "cohort",
      start: cohortStart,
      end: cohortEnd,
      targetStart,
      targetEnd:
        targetEnd > input.task.snapshotAt ? input.task.snapshotAt : targetEnd,
    };
  }
  throw new Error("导出 Cohort 参数不完整");
}

/** 构造模块 CSV 的封闭记录类型，含每个已成熟 Cohort 单元。 */
function buildExportQuerySpecs(
  task: ClaimedOperationsExportTask
): ExportQuerySpec[] {
  if (task.exportType === "commercialization")
    return [
      { kind: "orders", label: "orders" },
      { kind: "payment_lifecycle", label: "payment_lifecycle" },
    ];
  if (task.exportType === "content_production")
    return [{ kind: "content", label: "content" }];
  const specs: ExportQuerySpec[] = [
    { kind: "users", label: "users" },
    { kind: "activity", label: "login_activity", activityKind: "login" },
    { kind: "activity", label: "creation_activity", activityKind: "creation" },
    { kind: "activity", label: "payment_activity", activityKind: "payment" },
  ];
  if (task.query.range.kind !== "custom") return specs;
  let cohortDate =
    task.query.range.from < task.epochAppDate
      ? task.epochAppDate
      : task.query.range.from;
  while (cohortDate <= task.query.range.to) {
    for (const retentionDay of [1, 7, 30] as const) {
      const targetStart = parseDateInputInTimeZone(
        addOperationsCalendarDays(cohortDate, retentionDay),
        { timeZone: task.timeZone }
      );
      if (targetStart && targetStart <= task.snapshotAt) {
        specs.push({
          kind: "cohort",
          label: `retention_d${retentionDay}`,
          cohortDate,
          retentionDay,
        });
      }
    }
    cohortDate = addOperationsCalendarDays(cohortDate, 1);
  }
  return specs;
}

/**
 * 从同一只读快照按 `business_time + stable_id` 分页生成完整业务行。
 *
 * 用户增长模块导出新增用户及登录、创作、付费三类活跃，并为每个已成熟 Cohort
 * 目标日输出用户行。记录类型区分重复用户，使全部增长指标都可离线反算。
 */
async function* streamRowsFromReader(
  task: ClaimedOperationsExportTask,
  reader: Parameters<
    Parameters<OperationsDetailRepository["withReadOnlySnapshot"]>[0]
  >[0]
): AsyncGenerator<readonly OperationsCsvCell[]> {
  const range = resolveFrozenRange(task);
  if (
    (range.start < task.epochStartsAt ? task.epochStartsAt : range.start) >=
    range.end
  ) {
    return;
  }
  const definition = CSV_DEFINITIONS[task.exportType];
  const highWatermarks = parseOperationsExportHighWatermarks(
    task.highWatermarks
  );
  const specs = buildExportQuerySpecs(task);
  for (const spec of specs) {
    let cursor: OperationsDetailCursor | null = null;
    while (true) {
      let query = buildQueries({
        task,
        cursor,
        highWatermarks,
        kind: spec.kind,
        cohortDate: spec.cohortDate,
        retentionDay: spec.retentionDay,
      });
      if (query.kind === "activity") {
        query = { ...query, activityKind: spec.activityKind ?? "login" };
      }
      const rows = await reader.readRows(query);
      const page = rows.slice(0, EXPORT_PAGE_SIZE);
      for (const row of page) {
        const cells = definition.mapRow(row, task.timeZone);
        yield task.exportType === "user_growth"
          ? [spec.label, ...cells.slice(1)]
          : cells;
      }
      if (rows.length <= EXPORT_PAGE_SIZE) break;
      const last = page.at(-1);
      if (!last) break;
      cursor = {
        businessTime: last.businessTime,
        stableId: "stableId" in last ? last.stableId : last.userId,
      };
    }
  }
}

/** 分类错误为不包含 SQL、文件内容或凭据的稳定短码。 */
function exportErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown";
  if (message.includes("流式")) return "storage_stream_unsupported";
  if (message.includes("日期范围")) return "invalid_frozen_range";
  return "export_failed";
}

/** 处理一条已认领任务；异常收敛为 failed，陈旧 worker 的 CAS 不产生覆盖。 */
async function processClaimedTask(
  task: ClaimedOperationsExportTask,
  dependencies: OperationsExportWorkerDependencies
): Promise<void> {
  const startedAt = Date.now();
  const objectKey = buildOperationsExportObjectKey({
    taskId: task.id,
    leaseToken: task.leaseToken,
  });
  const definition = CSV_DEFINITIONS[task.exportType];
  if (
    !(await dependencies.repository.renewLease({
      taskId: task.id,
      leaseToken: task.leaseToken,
      now: dependencies.now(),
    }))
  ) {
    logger.warn(
      {
        operation: "operations.processExports",
        exportTaskId: task.id,
        exportType: task.exportType,
        granularity: task.query.granularity,
        attempt: task.attemptCount,
        leaseStatus: "lost_before_start",
        durationMs: Math.max(0, Date.now() - startedAt),
      },
      "Operations export task lease lost before processing"
    );
    return;
  }
  const lease = startLeaseRenewal(task, dependencies);
  let objectWriteStarted = false;
  try {
    const upload = async (
      rows: AsyncIterable<readonly OperationsCsvCell[]>
    ) => {
      const measured = createMeasuredExportStream(
        streamOperationsCsv({
          headers: definition.headers,
          rows: withLeaseSignal(rows, lease.signal),
        }),
        { headerRows: 1 }
      );
      objectWriteStarted = true;
      await dependencies.storage.putObjectStream(
        objectKey,
        dependencies.storage.bucket,
        measured.stream,
        "text/csv; charset=utf-8",
        { signal: lease.signal }
      );
      return measured.result;
    };
    const stats = dependencies.createRows
      ? await upload(dependencies.createRows(task))
      : await databaseOperationsGrowthDetailRepository.withReadOnlySnapshot(
          async (reader) => upload(streamRowsFromReader(task, reader))
        );
    lease.throwIfLost();
    const completedAt = dependencies.now();
    let completed: boolean;
    try {
      completed = await dependencies.repository.complete({
        taskId: task.id,
        leaseToken: task.leaseToken,
        objectBucket: dependencies.storage.bucket,
        objectKey,
        ...stats,
        completedAt,
        expiresAt: new Date(
          completedAt.getTime() + OPERATIONS_EXPORT_RETENTION_MS
        ),
      });
    } catch {
      // WHY：事务提交响应丢失时，数据库可能已经引用这个对象。此时直接删除会让
      // completed 任务永久损坏；登记候选后由清理查询先排除仍被任务引用的对象。
      await recordOrphanBestEffort(dependencies.repository, {
        taskId: task.id,
        leaseToken: task.leaseToken,
        objectBucket: dependencies.storage.bucket,
        objectKey,
        errorCode: "completion_result_unknown",
        now: dependencies.now(),
      });
      logger.warn(
        {
          operation: "operations.processExports",
          exportTaskId: task.id,
          exportType: task.exportType,
          granularity: task.query.granularity,
          attempt: task.attemptCount,
          leaseStatus: "completion_unknown",
          errorCode: "completion_result_unknown",
          durationMs: Math.max(0, Date.now() - startedAt),
        },
        "Operations export task completion result is unknown"
      );
      return;
    }
    if (completed) {
      logger.info(
        {
          operation: "operations.processExports",
          exportTaskId: task.id,
          exportType: task.exportType,
          granularity: task.query.granularity,
          attempt: task.attemptCount,
          leaseStatus: "completed",
          rowCount: stats.rowCount,
          byteCount: stats.byteCount,
          durationMs: Math.max(0, Date.now() - startedAt),
        },
        "Operations export task completed"
      );
      return;
    }
    try {
      await dependencies.storage.deleteObject(
        objectKey,
        dependencies.storage.bucket
      );
    } catch {
      await recordOrphanBestEffort(dependencies.repository, {
        taskId: task.id,
        leaseToken: task.leaseToken,
        objectBucket: dependencies.storage.bucket,
        objectKey,
        errorCode: "orphan_delete_failed",
        now: dependencies.now(),
      });
    }
    logger.warn(
      {
        operation: "operations.processExports",
        exportTaskId: task.id,
        exportType: task.exportType,
        granularity: task.query.granularity,
        attempt: task.attemptCount,
        leaseStatus: "superseded",
        durationMs: Math.max(0, Date.now() - startedAt),
      },
      "Operations export task completion was superseded"
    );
  } catch (error) {
    const errorCode = exportErrorCode(error);
    if (objectWriteStarted) {
      try {
        await dependencies.storage.deleteObject(
          objectKey,
          dependencies.storage.bucket
        );
      } catch {
        await recordOrphanBestEffort(dependencies.repository, {
          taskId: task.id,
          leaseToken: task.leaseToken,
          objectBucket: dependencies.storage.bucket,
          objectKey,
          errorCode: "orphan_delete_failed",
          now: dependencies.now(),
        });
      }
    }
    await dependencies.repository.fail({
      taskId: task.id,
      leaseToken: task.leaseToken,
      errorCode,
      now: dependencies.now(),
    });
    logger.warn(
      {
        operation: "operations.processExports",
        exportTaskId: task.id,
        exportType: task.exportType,
        granularity: task.query.granularity,
        attempt: task.attemptCount,
        leaseStatus: "failed",
        errorCode,
        durationMs: Math.max(0, Date.now() - startedAt),
      },
      "Operations export task failed"
    );
  } finally {
    try {
      await lease.stop();
    } catch {
      // 主流程已经用相同 fencing token 收敛；finally 只负责释放定时器。
    }
  }
}

/** 认领并串行处理有界批次；SKIP LOCKED 允许多进程安全并行。 */
export async function processOperationsExportBatch(
  input: { limit: number; workerId: string },
  dependencies: OperationsExportWorkerDependencies
): Promise<{ processed: number }> {
  let processed = 0;
  while (processed < input.limit) {
    const task = await dependencies.repository.claimNext({
      workerId: input.workerId,
      leaseToken: dependencies.createToken(),
      now: dependencies.now(),
    });
    if (!task) break;
    logger.info(
      {
        operation: "operations.processExports",
        exportTaskId: task.id,
        exportType: task.exportType,
        granularity: task.query.granularity,
        attempt: task.attemptCount,
        leaseStatus: "claimed",
      },
      "Operations export task claimed"
    );
    await processClaimedTask(task, dependencies);
    processed += 1;
  }
  return { processed };
}

/** 生产 worker 每次固定同一存储配置快照，并使用不可预测的 worker/lease token。 */
export async function processDatabaseOperationsExports(
  limit: number
): Promise<{ processed: number }> {
  const storage = await getOperationsExportStorage();
  return processOperationsExportBatch(
    { limit, workerId: `operations-export:${process.pid}:${randomUUID()}` },
    {
      repository: databaseOperationsExportTaskRepository,
      storage,
      now: () => new Date(),
      createToken: randomUUID,
    }
  );
}

/** 为 task/lease 组合构造仅在进程内使用的集合键。 */
function exportLeaseKey(input: { taskId: string; leaseToken: string }): string {
  return `${input.taskId}:${input.leaseToken}`;
}

/** 批量查询对象键对应的仍有效租约，避免清理长时间运行的上传。 */
async function findActiveObjectLeaseKeys(
  objectKeys: string[],
  dependencies: OperationsExportCleanupDependencies
): Promise<Set<string>> {
  const parsedObjects = objectKeys.flatMap((key) => {
    const parsed = parseOperationsExportObjectKey(key);
    return parsed ? [parsed] : [];
  });
  const activeLeases = await dependencies.repository.findActiveExportLeases({
    taskIds: [...new Set(parsedObjects.map((object) => object.taskId))],
    now: dependencies.now(),
  });
  return new Set(activeLeases.map(exportLeaseKey));
}

/**
 * 清理一页硬崩溃遗留对象。
 *
 * 只处理早于一个完整租约窗口的对象，并在每页删除前一次性查询数据库引用集合；
 * completed、expired 或其它状态任务只要仍引用对象就永久保留。删除失败时不推进
 * cursor，使下一批优先重试同一页，其余已删除对象按幂等缺失处理。
 */
async function cleanupUnreferencedStoragePage(
  input: { limit: number; olderThan: Date },
  dependencies: OperationsExportCleanupDependencies
): Promise<number> {
  const currentCursor = storageObjectScanCursor;
  try {
    const page = await dependencies.storage.listObjects(
      EXPORT_ORPHAN_SCAN_PREFIX,
      dependencies.storage.bucket,
      { cursor: currentCursor, limit: input.limit }
    );
    const staleObjects = page.objects.filter(
      (object) => object.lastModified < input.olderThan
    );
    const referenced = await dependencies.repository.findReferencedObjectKeys({
      objectBucket: dependencies.storage.bucket,
      objectKeys: staleObjects.map((object) => object.key),
    });
    const activeLeaseKeys = await findActiveObjectLeaseKeys(
      staleObjects.map((object) => object.key),
      dependencies
    );
    let deleted = 0;
    let failed = false;
    for (const object of staleObjects) {
      if (referenced.has(object.key)) continue;
      const parsed = parseOperationsExportObjectKey(object.key);
      if (parsed && activeLeaseKeys.has(exportLeaseKey(parsed))) continue;
      try {
        await dependencies.storage.deleteObject(
          object.key,
          dependencies.storage.bucket
        );
        deleted += 1;
      } catch {
        failed = true;
      }
    }
    if (!failed) storageObjectScanCursor = page.nextCursor;
    return deleted;
  } catch {
    logger.warn(
      {
        operation: "operations.expireExports",
        leaseStatus: "orphan_scan_failed",
        errorCode: "orphan_scan_failed",
      },
      "Operations export orphan scan failed"
    );
    return 0;
  }
}

/**
 * 清理一页陈旧 S3 multipart 上传；local provider 没有该能力时为空操作。
 *
 * worker 批量排除仍有效的 task/lease，provider 负责分页和 NoSuchUpload 幂等；
 * 失败不推进 cursor，下次 cron 从相同页继续，且不回滚数据库过期边界。
 */
async function cleanupStaleMultipartUploadPage(
  input: { limit: number; olderThan: Date },
  dependencies: OperationsExportCleanupDependencies
): Promise<number> {
  if (
    !dependencies.storage.listMultipartUploads ||
    !dependencies.storage.abortMultipartUpload
  ) {
    return 0;
  }
  try {
    const page = await dependencies.storage.listMultipartUploads(
      EXPORT_ORPHAN_SCAN_PREFIX,
      dependencies.storage.bucket,
      {
        cursor: multipartUploadScanCursor,
        limit: input.limit,
      }
    );
    const staleUploads = page.uploads.filter(
      (upload) => upload.initiatedAt < input.olderThan
    );
    const activeLeaseKeys = await findActiveObjectLeaseKeys(
      staleUploads.map((upload) => upload.key),
      dependencies
    );
    let aborted = 0;
    let failed = false;
    for (const upload of staleUploads) {
      const parsed = parseOperationsExportObjectKey(upload.key);
      if (parsed && activeLeaseKeys.has(exportLeaseKey(parsed))) {
        continue;
      }
      try {
        await dependencies.storage.abortMultipartUpload(
          upload.key,
          dependencies.storage.bucket,
          upload.cleanupToken
        );
        aborted += 1;
      } catch {
        failed = true;
      }
    }
    if (!failed) multipartUploadScanCursor = page.nextCursor;
    return aborted;
  } catch {
    logger.warn(
      {
        operation: "operations.expireExports",
        leaseStatus: "multipart_cleanup_failed",
        errorCode: "multipart_cleanup_failed",
      },
      "Operations export multipart cleanup failed"
    );
    return 0;
  }
}

/** 先批量转 expired，再逐对象幂等删除；删除失败不恢复下载权限。 */
export async function expireOperationsExportBatch(
  input: { limit: number },
  dependencies: OperationsExportCleanupDependencies
): Promise<{ processed: number }> {
  const now = dependencies.now();
  const tasks = await dependencies.repository.expireDue({
    now,
    limit: input.limit,
  });
  for (const task of tasks) {
    const startedAt = Date.now();
    try {
      await dependencies.storage.deleteObject(
        task.objectKey,
        task.objectBucket
      );
      await dependencies.repository.markDeleted({
        taskId: task.id,
        objectKey: task.objectKey,
        now: dependencies.now(),
      });
      logger.info(
        {
          operation: "operations.expireExports",
          exportTaskId: task.id,
          leaseStatus: "object_deleted",
          durationMs: Math.max(0, Date.now() - startedAt),
        },
        "Operations export object deleted"
      );
    } catch {
      await dependencies.repository.markCleanupFailed({
        taskId: task.id,
        objectKey: task.objectKey,
        errorCode: "object_delete_failed",
        now: dependencies.now(),
      });
      logger.warn(
        {
          operation: "operations.expireExports",
          exportTaskId: task.id,
          leaseStatus: "cleanup_failed",
          errorCode: "object_delete_failed",
          durationMs: Math.max(0, Date.now() - startedAt),
        },
        "Operations export object cleanup failed"
      );
    }
  }
  const remaining = Math.max(0, input.limit - tasks.length);
  const orphans =
    remaining > 0
      ? await dependencies.repository.listOrphans({ limit: remaining })
      : [];
  for (const orphan of orphans) {
    try {
      await dependencies.storage.deleteObject(
        orphan.objectKey,
        orphan.objectBucket
      );
      await dependencies.repository.markOrphanDeleted({
        auditId: orphan.auditId,
        taskId: orphan.taskId,
        objectKey: orphan.objectKey,
        now: dependencies.now(),
      });
    } catch {
      // 孤儿审计记录保持未完成，后续清理批次会再次尝试。
    }
  }
  const olderThan = new Date(now.getTime() - EXPORT_ORPHAN_SAFETY_MS);
  const deletedOrphans = await cleanupUnreferencedStoragePage(
    { limit: input.limit, olderThan },
    dependencies
  );
  const abortedUploads = await cleanupStaleMultipartUploadPage(
    { limit: input.limit, olderThan },
    dependencies
  );
  return {
    processed: tasks.length + orphans.length + deletedOrphans + abortedUploads,
  };
}

/** 生产清理任务读取单一存储快照并执行数据库过期边界。 */
export async function expireDatabaseOperationsExports(
  limit: number
): Promise<{ processed: number }> {
  const storage = await getOperationsExportStorage();
  return expireOperationsExportBatch(
    { limit },
    {
      repository: databaseOperationsExportTaskRepository,
      storage,
      now: () => new Date(),
    }
  );
}
