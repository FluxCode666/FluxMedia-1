/**
 * 运营 CSV 导出 worker。
 *
 * 使用方：operations.processExports 内部 UOL binding。worker 从仓储领取带 fencing
 * token 的冻结任务，按 keyset 读取同源事实、流式上传并条件完成。
 */
import { randomUUID } from "node:crypto";

import {
  amountMinorToMajor,
  getCurrencyMinorUnitExponent,
} from "@repo/shared/credits/top-up";
import { logError, logger } from "@repo/shared/logger";
import type { OperationsExportType } from "@repo/shared/operations-dashboard/contracts";
import {
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
} from "./export-storage";
import {
  type ClaimedOperationsExportTask,
  databaseOperationsExportTaskRepository,
  OPERATIONS_EXPORT_RETENTION_MS,
  type OperationsExportTaskRepository,
  parseOperationsExportHighWatermarks,
} from "./export-task-repository";

const EXPORT_PAGE_SIZE = 1_000;
const EXPORT_LEASE_RENEW_INTERVAL_MS = 30_000;

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
    formatDateTime: OperationsExportDateTimeFormatter
  ): readonly OperationsCsvCell[];
};

type OperationsExportDateTimeFormatter = (date: Date) => string;

type ExportQuerySpec = {
  kind: OperationsDetailQuery["kind"];
  label: string;
  activityKind?: "login" | "creation" | "payment";
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

/**
 * 为单个导出任务创建可复用的 ISO 8601 格式化器。
 *
 * @param timeZone 任务冻结的应用时区。
 * @returns 复用同一个 Intl formatter 的纯日期转换函数。
 * @failure 非法时区按 normalizeTimeZone 的既有规则回退，不吞掉非法 Date 错误。
 */
function createOperationsExportDateTimeFormatter(
  timeZone: string
): OperationsExportDateTimeFormatter {
  const normalized = normalizeTimeZone(timeZone);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: normalized,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hourCycle: "h23",
  });
  return (date) => {
    const values: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
    for (const part of formatter.formatToParts(date)) {
      values[part.type] = part.value;
    }
    const read = (type: Intl.DateTimeFormatPartTypes) => values[type] ?? "";
    const dateWithoutMilliseconds = new Date(
      date.getTime() - date.getMilliseconds()
    );
    const localTimeAsUtc = Date.UTC(
      Number(read("year")),
      Number(read("month")) - 1,
      Number(read("day")),
      Number(read("hour")),
      Number(read("minute")),
      Number(read("second"))
    );
    const offsetMinutes =
      (localTimeAsUtc - dateWithoutMilliseconds.getTime()) / 60_000;
    const sign = offsetMinutes >= 0 ? "+" : "-";
    const absolute = Math.abs(offsetMinutes);
    const offset = `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
    return `${read("year")}-${read("month")}-${read("day")}T${read("hour")}:${read("minute")}:${read("second")}.${read("fractionalSecond")}${offset}`;
  };
}

/** 把具体 UTC 瞬间导出为带应用时区偏移的 ISO 8601。 */
export function formatOperationsExportDateTime(
  date: Date,
  timeZone: string
): string {
  return createOperationsExportDateTimeFormatter(timeZone)(date);
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
    mapRow(row, formatDateTime) {
      if (!("userId" in row) || "taskId" in row || "paymentOrderId" in row)
        throw new Error("运营增长导出收到不匹配的行");
      return [
        row.kind,
        row.userId,
        row.name,
        row.email,
        formatDateTime(row.businessTime),
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
    mapRow(row, formatDateTime) {
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
        formatDateTime(row.createdAt),
        row.fulfilledAt ? formatDateTime(row.fulfilledAt) : null,
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
    mapRow(row, formatDateTime) {
      if (!("taskId" in row)) throw new Error("内容生产导出收到不匹配的行");
      return [
        row.taskId,
        row.userId,
        row.model,
        row.mediaType,
        formatDateTime(row.businessTime),
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
  if (input.kind === "cohort_export" && input.retentionDay) {
    return {
      ...base,
      kind: "cohort_export",
      retentionDay: input.retentionDay,
      timeZone: input.task.timeZone,
    };
  }
  throw new Error("导出 Cohort 参数不完整");
}

/** 构造模块 CSV 的封闭记录类型，含每个已成熟 Cohort 单元。 */
export function buildOperationsExportQuerySpecs(
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
  for (const retentionDay of [1, 7, 30] as const) {
    specs.push({
      kind: "cohort_export",
      label: `retention_d${retentionDay}`,
      retentionDay,
    });
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
  const specs = buildOperationsExportQuerySpecs(task);
  const formatDateTime = createOperationsExportDateTimeFormatter(task.timeZone);
  for (const spec of specs) {
    let cursor: OperationsDetailCursor | null = null;
    while (true) {
      let query = buildQueries({
        task,
        cursor,
        highWatermarks,
        kind: spec.kind,
        retentionDay: spec.retentionDay,
      });
      if (query.kind === "activity") {
        query = { ...query, activityKind: spec.activityKind ?? "login" };
      }
      const rows = await reader.readRows(query);
      const page = rows.slice(0, EXPORT_PAGE_SIZE);
      for (const row of page) {
        const cells = definition.mapRow(row, formatDateTime);
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

export {
  expireDatabaseOperationsExports,
  expireOperationsExportBatch,
  type OperationsExportCleanupDependencies,
} from "./export-cleanup";
