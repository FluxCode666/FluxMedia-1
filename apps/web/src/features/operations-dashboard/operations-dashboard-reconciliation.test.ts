/**
 * 运营总览汇总、全分页明细与真实 worker CSV 的同源反算测试。
 *
 * 使用方：U3、U4、U6 精确性发布门禁。测试不预制 CSV，而是让生产 worker 从
 * 同一内存事实仓储分页、编码、上传，再从实际 UTF-8 BOM CSV 逐行反算汇总。
 */
import { getCurrencyMinorUnitExponent } from "@repo/shared/credits/top-up";
import type {
  OperationsDetailSelection,
  OperationsPaymentLifecycleStage,
} from "@repo/shared/operations-dashboard/contracts";
import {
  type OperationsDetailOutput,
  operationsDetailOutputSchema,
} from "@repo/shared/operations-dashboard/output-contracts";
import { describe, expect, it } from "vitest";

import { buildOperationsCommercialSnapshot } from "./commercial-service";
import { buildOperationsContentSnapshot } from "./content-service";
import { loadOperationsDetail } from "./detail-service";
import type { OperationsExportWorkerDependencies } from "./export-worker";
import { processOperationsExportBatch } from "./export-worker";
import { buildOperationsGrowthSnapshot } from "./growth-service";
import {
  createOperationsReconciliationFixture,
  createReconciliationExportTasks,
  RECONCILIATION_AS_OF,
  RECONCILIATION_QUERY,
  RECONCILIATION_TIME_ZONE,
  toDetailBucket,
} from "./operations-dashboard-reconciliation-fixture";

type DetailRow = OperationsDetailOutput["rows"][number];
type CsvTable = { headers: string[]; rows: string[][] };

/** 解析 worker 生成的 RFC 4180 CSV，并保留空单元格。 */
function parseCsv(bytes: Uint8Array): CsvTable {
  const text = Buffer.from(bytes)
    .toString("utf8")
    .replace(/^\uFEFF/, "");
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      record.push(cell);
      cell = "";
    } else if (character === "\r" && text[index + 1] === "\n") {
      record.push(cell);
      records.push(record);
      record = [];
      cell = "";
      index += 1;
    } else {
      cell += character;
    }
  }
  if (quoted) throw new Error("CSV 引号未闭合");
  const [headers, ...rows] = records;
  if (!headers) throw new Error("CSV 缺少表头");
  return { headers, rows };
}

/** 按中文表头安全读取 CSV 单元格。 */
function readCsvCell(
  table: CsvTable,
  row: readonly string[],
  header: string
): string {
  const index = table.headers.indexOf(header);
  if (index < 0) throw new Error(`CSV 缺少列：${header}`);
  return row[index] ?? "";
}

/** 判断传输行是否为增长用户明细。 */
function isGrowthRow(
  row: DetailRow
): row is Extract<DetailRow, { email: string }> {
  return "email" in row;
}

/** 判断传输行是否为商业化订单明细。 */
function isCommercialRow(
  row: DetailRow
): row is Extract<DetailRow, { paymentOrderId: string }> {
  return "paymentOrderId" in row;
}

/** 判断传输行是否为内容产物明细。 */
function isContentRow(
  row: DetailRow
): row is Extract<DetailRow, { taskId: string }> {
  return "taskId" in row;
}

/** 使用真实签名 cursor 遍历一个 selection 的全部明细页。 */
async function loadAllDetailRows(
  selection: OperationsDetailSelection,
  repository: ReturnType<
    typeof createOperationsReconciliationFixture
  >["detailRepository"]
): Promise<DetailRow[]> {
  const rows: DetailRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await loadOperationsDetail(
      {
        actorUserId: "admin-reconciliation",
        timeZone: RECONCILIATION_TIME_ZONE,
        input: {
          ...RECONCILIATION_QUERY,
          selection,
          cursor,
          limit: 1,
        },
      },
      {
        repository,
        tokenSecret: "reconciliation-secret-at-least-32-characters",
      }
    );
    const parsed = operationsDetailOutputSchema.parse(page);
    rows.push(...parsed.rows);
    cursor = parsed.nextCursor ?? undefined;
  } while (cursor);
  return rows;
}

/** 把明细中按币种的最小单位金额聚合成稳定对象。 */
function sumDetailRevenue(rows: readonly DetailRow[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const row of rows) {
    if (!isCommercialRow(row)) continue;
    result[row.currency] = (result[row.currency] ?? 0) + row.amountMinor;
  }
  return result;
}

/** 把 CSV 展示金额无损还原为币种最小单位整数。 */
function parseCsvAmountMinor(amount: string, currency: string): number {
  const exponent = getCurrencyMinorUnitExponent(currency);
  return Math.round(Number(amount) * 10 ** exponent);
}

/** 从支付生命周期 CSV 重建与商业化汇总一致的阶段数量。 */
function aggregateLifecycleCsv(
  table: CsvTable
): Record<OperationsPaymentLifecycleStage, number> {
  const eventsByOrder = new Map<string, Set<string>>();
  for (const row of table.rows) {
    if (readCsvCell(table, row, "记录类型") !== "payment_lifecycle") {
      continue;
    }
    const orderId = readCsvCell(table, row, "平台订单 ID");
    const event = readCsvCell(table, row, "生命周期事件");
    const events = eventsByOrder.get(orderId) ?? new Set<string>();
    events.add(event);
    eventsByOrder.set(orderId, events);
  }
  const result: Record<OperationsPaymentLifecycleStage, number> = {
    created_orders: 0,
    pending_orders: 0,
    payment_confirmed_orders: 0,
    paid_not_fulfilled_orders: 0,
    fulfilled_orders: 0,
    failed_orders: 0,
  };
  for (const events of eventsByOrder.values()) {
    const hasCreated = events.has("order_created");
    const hasPayment = events.has("payment_confirmed");
    const hasFulfillment = events.has("fulfillment_succeeded");
    const hasFailure =
      events.has("checkout_failed") ||
      events.has("fulfillment_failed_terminal") ||
      events.has("expired");
    if (hasCreated) result.created_orders += 1;
    if (hasCreated && !hasPayment && !hasFulfillment && !hasFailure) {
      result.pending_orders += 1;
    }
    if (hasPayment) result.payment_confirmed_orders += 1;
    if (hasPayment && !hasFulfillment && !hasFailure) {
      result.paid_not_fulfilled_orders += 1;
    }
    if (hasFulfillment) result.fulfilled_orders += 1;
    if (hasFailure) result.failed_orders += 1;
  }
  return result;
}

/** 运行三类真实 worker 导出并按 exportType 返回实际上传字节。 */
async function runActualWorkerExports(
  detailRepository: ReturnType<
    typeof createOperationsReconciliationFixture
  >["detailRepository"]
): Promise<Map<string, Uint8Array>> {
  const tasks = createReconciliationExportTasks();
  const pending = [...tasks];
  const uploaded = new Map<string, Uint8Array>();
  const taskObjectKeys = new Map<string, string>();
  const dependencies: OperationsExportWorkerDependencies = {
    repository: {
      async claimNext() {
        return pending.shift() ?? null;
      },
      async renewLease() {
        return true;
      },
      async complete(input) {
        taskObjectKeys.set(input.taskId, input.objectKey);
        return true;
      },
      async fail() {
        throw new Error("对账导出不应失败");
      },
      async recordOrphan() {
        throw new Error("对账导出不应产生孤儿对象");
      },
    },
    storage: {
      bucket: "operations-reconciliation",
      async putObjectStream(key, _bucket, data) {
        const chunks: Buffer[] = [];
        for await (const chunk of data) chunks.push(Buffer.from(chunk));
        uploaded.set(key, Buffer.concat(chunks));
      },
      async deleteObject() {
        throw new Error("对账导出不应删除对象");
      },
    },
    detailRepository,
    now: () => new Date("2026-08-15T04:00:01.000Z"),
    createToken: () => "claim-token",
    leaseRenewIntervalMs: 60_000,
  };

  await expect(
    processOperationsExportBatch(
      { limit: tasks.length, workerId: "worker-reconciliation" },
      dependencies
    )
  ).resolves.toEqual({ processed: tasks.length });

  const result = new Map<string, Uint8Array>();
  for (const task of tasks) {
    const objectKey = taskObjectKeys.get(task.id);
    const bytes = objectKey ? uploaded.get(objectKey) : undefined;
    if (!bytes) throw new Error(`对账导出缺少对象：${task.exportType}`);
    result.set(task.exportType, bytes);
  }
  return result;
}

describe("operations dashboard reconciliation", () => {
  it("从同源事实逐值对齐 overview、全分页 detail 与 worker CSV", async () => {
    const fixture = createOperationsReconciliationFixture();
    const growth = await buildOperationsGrowthSnapshot(
      RECONCILIATION_QUERY,
      RECONCILIATION_TIME_ZONE,
      fixture.growthReader
    );
    const commercial = await buildOperationsCommercialSnapshot(
      RECONCILIATION_QUERY,
      RECONCILIATION_TIME_ZONE,
      fixture.commercialReader
    );
    const content = await buildOperationsContentSnapshot(
      RECONCILIATION_QUERY,
      RECONCILIATION_TIME_ZONE,
      fixture.contentReader
    );

    const cumulativeRows = await loadAllDetailRows(
      {
        module: "growth",
        detail: "cumulative_users",
        cutoffDate: growth.range.to,
      },
      fixture.detailRepository
    );
    const newUserRows = await loadAllDetailRows(
      { module: "growth", detail: "users" },
      fixture.detailRepository
    );
    const loginRows = await loadAllDetailRows(
      { module: "growth", detail: "login_activity" },
      fixture.detailRepository
    );
    const creationRows = await loadAllDetailRows(
      { module: "growth", detail: "creation_activity" },
      fixture.detailRepository
    );
    const paymentRows = await loadAllDetailRows(
      { module: "growth", detail: "payment_activity" },
      fixture.detailRepository
    );
    expect(cumulativeRows).toHaveLength(growth.metrics.cumulativeUsers.current);
    expect(newUserRows).toHaveLength(growth.metrics.newUsers.current);
    expect(loginRows).toHaveLength(growth.metrics.loginActiveUsers.current);
    expect(creationRows).toHaveLength(
      growth.metrics.creationActiveUsers.current
    );
    expect(paymentRows).toHaveLength(growth.metrics.paymentActiveUsers.current);

    for (const [seriesKind, activityKind] of [
      ["newUsers", "new_users"],
      ["loginActiveUsers", "login"],
      ["creationActiveUsers", "creation"],
      ["paymentActiveUsers", "payment"],
    ] as const) {
      for (const bucket of growth.series[seriesKind]) {
        if (bucket.status !== "value") continue;
        const rows = await loadAllDetailRows(
          {
            module: "growth",
            detail: "activity_bucket",
            activityKind,
            bucket: toDetailBucket(bucket),
          },
          fixture.detailRepository
        );
        expect(rows, `${seriesKind}:${bucket.key}`).toHaveLength(bucket.value);
      }
    }

    for (const retentionDay of [1, 7, 30] as const) {
      let cohortSize = 0;
      let retainedCount = 0;
      for (const cohort of growth.cohorts) {
        const value = cohort[`d${retentionDay}`];
        if (value.status !== "value") continue;
        const rows = await loadAllDetailRows(
          {
            module: "growth",
            detail: "retention_cohorts",
            cohortDate: cohort.cohortDate,
            retentionDay,
          },
          fixture.detailRepository
        );
        const growthRows = rows.filter(isGrowthRow);
        expect(growthRows).toHaveLength(value.cohortSize);
        expect(growthRows.filter((row) => row.retained)).toHaveLength(
          value.retainedCount
        );
        cohortSize += growthRows.length;
        retainedCount += growthRows.filter((row) => row.retained).length;
      }
      expect(growth.metrics[`d${retentionDay}Retention`].current).toMatchObject(
        { status: "value", cohortSize, retainedCount }
      );
    }

    const lifecycleStages = [
      ["createdOrders", "created_orders"],
      ["pendingOrders", "pending_orders"],
      ["paymentConfirmedOrders", "payment_confirmed_orders"],
      ["paidNotFulfilledOrders", "paid_not_fulfilled_orders"],
      ["fulfilledOrders", "fulfilled_orders"],
      ["failedOrders", "failed_orders"],
    ] as const;
    for (const [metric, stage] of lifecycleStages) {
      const rows = await loadAllDetailRows(
        { module: "commercialization", detail: "payment_stage", stage },
        fixture.detailRepository
      );
      expect(rows, stage).toHaveLength(commercial.lifecycle[metric].current);
    }
    const fulfilledRows = await loadAllDetailRows(
      { module: "commercialization", detail: "fulfilled_orders" },
      fixture.detailRepository
    );
    expect(sumDetailRevenue(fulfilledRows)).toEqual(
      Object.fromEntries(
        commercial.revenue.current.map((value) => [
          value.currency,
          value.amountMinor,
        ])
      )
    );

    const contentSelections = {
      imageCount: { detail: "image_outputs", sum: "quantity" },
      videoCount: { detail: "video_outputs", sum: "quantity" },
      videoSeconds: { detail: "video_outputs", sum: "videoSeconds" },
      netCredits: { detail: "credit_usage", sum: "netCredits" },
    } as const;
    for (const [metric, selection] of Object.entries(
      contentSelections
    ) as Array<
      [
        keyof typeof contentSelections,
        (typeof contentSelections)[keyof typeof contentSelections],
      ]
    >) {
      const rows = await loadAllDetailRows(
        { module: "content", detail: selection.detail },
        fixture.detailRepository
      );
      const total = rows
        .filter(isContentRow)
        .reduce((sum, row) => sum + row[selection.sum], 0);
      expect(total, metric).toBe(content.metrics[metric].current);
    }
    for (const [seriesKind, contentKind, sum] of [
      ["imageCount", "image", "quantity"],
      ["videoCount", "video", "quantity"],
      ["videoSeconds", "video", "videoSeconds"],
      ["netCredits", "credits", "netCredits"],
    ] as const) {
      for (const bucket of content.series[seriesKind]) {
        if (bucket.status !== "value") continue;
        const rows = await loadAllDetailRows(
          {
            module: "content",
            detail: "content_bucket",
            contentKind,
            bucket: toDetailBucket(bucket),
          },
          fixture.detailRepository
        );
        const total = rows
          .filter(isContentRow)
          .reduce((value, row) => value + row[sum], 0);
        expect(total, `${seriesKind}:${bucket.key}`).toBe(bucket.value);
      }
    }

    const exports = await runActualWorkerExports(fixture.detailRepository);
    const growthCsv = parseCsv(exports.get("user_growth") ?? new Uint8Array());
    const growthRowsByType = (type: string) =>
      growthCsv.rows.filter(
        (row) => readCsvCell(growthCsv, row, "记录类型") === type
      );
    expect(growthRowsByType("cumulative_users")).toHaveLength(
      growth.metrics.cumulativeUsers.current
    );
    expect(growthRowsByType("users")).toHaveLength(
      growth.metrics.newUsers.current
    );
    expect(growthRowsByType("login_activity")).toHaveLength(
      growth.metrics.loginActiveUsers.current
    );
    expect(growthRowsByType("creation_activity")).toHaveLength(
      growth.metrics.creationActiveUsers.current
    );
    expect(growthRowsByType("payment_activity")).toHaveLength(
      growth.metrics.paymentActiveUsers.current
    );
    for (const retentionDay of [1, 7, 30] as const) {
      const rows = growthRowsByType(`retention_d${retentionDay}`);
      const retainedCount = rows.filter(
        (row) => readCsvCell(growthCsv, row, "留存") === "true"
      ).length;
      expect(growth.metrics[`d${retentionDay}Retention`].current).toMatchObject(
        { status: "value", cohortSize: rows.length, retainedCount }
      );
    }

    const commercialCsv = parseCsv(
      exports.get("commercialization") ?? new Uint8Array()
    );
    const lifecycleCsv = aggregateLifecycleCsv(commercialCsv);
    for (const [metric, stage] of lifecycleStages) {
      expect(lifecycleCsv[stage], stage).toBe(
        commercial.lifecycle[metric].current
      );
    }
    const csvRevenue: Record<string, number> = {};
    for (const row of commercialCsv.rows) {
      if (readCsvCell(commercialCsv, row, "记录类型") !== "fulfilled_orders") {
        continue;
      }
      const currency = readCsvCell(commercialCsv, row, "币种");
      csvRevenue[currency] =
        (csvRevenue[currency] ?? 0) +
        parseCsvAmountMinor(readCsvCell(commercialCsv, row, "金额"), currency);
    }
    expect(csvRevenue).toEqual(
      Object.fromEntries(
        commercial.revenue.current.map((value) => [
          value.currency,
          value.amountMinor,
        ])
      )
    );

    const contentCsv = parseCsv(
      exports.get("content_production") ?? new Uint8Array()
    );
    const contentCsvRows = contentCsv.rows.map((row) => ({
      mediaType: readCsvCell(contentCsv, row, "媒体类型"),
      quantity: Number(readCsvCell(contentCsv, row, "数量")),
      videoSeconds: Number(readCsvCell(contentCsv, row, "视频秒数")),
      netCredits: Number(readCsvCell(contentCsv, row, "积分净用量")),
    }));
    expect(
      contentCsvRows
        .filter((row) => row.mediaType === "image")
        .reduce((sum, row) => sum + row.quantity, 0)
    ).toBe(content.metrics.imageCount.current);
    expect(
      contentCsvRows.filter((row) => row.mediaType === "video")
    ).toHaveLength(content.metrics.videoCount.current);
    expect(contentCsvRows.reduce((sum, row) => sum + row.videoSeconds, 0)).toBe(
      content.metrics.videoSeconds.current
    );
    expect(
      Math.round(
        contentCsvRows.reduce((sum, row) => sum + row.netCredits, 0) * 100
      )
    ).toBe(Math.round(content.metrics.netCredits.current * 100));

    expect(growth.generatedAt).toBe(RECONCILIATION_AS_OF.toISOString());
    expect(commercial.generatedAt).toBe(RECONCILIATION_AS_OF.toISOString());
    expect(content.generatedAt).toBe(RECONCILIATION_AS_OF.toISOString());
    expect(growth.range).toEqual(commercial.range);
    expect(growth.range).toEqual(content.range);
  });
});
