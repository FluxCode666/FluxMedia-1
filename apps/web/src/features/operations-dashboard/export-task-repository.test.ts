/**
 * 运营导出任务仓储 SQL 契约测试。
 *
 * 使用方：U6。防止认领退化为 offset/无锁扫描，且确保陈旧 running 与删除失败的
 * expired 对象能够恢复。数据库行为集成将在生产规模核对阶段执行。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseClaimedOperationsExportTaskRow } from "./export-task-repository";

describe("operations export repository SQL contract", () => {
  const source = readFileSync(
    new URL("./export-task-repository.ts", import.meta.url),
    "utf8"
  ).toLowerCase();

  it("使用 skip locked、lease token 条件终态和陈旧租约恢复", () => {
    expect(source).toContain("for update skip locked");
    expect(source).toContain("lease_expires_at <=");
    expect(source).toContain(
      "eq(operationsexporttask.leasetoken, input.leasetoken)"
    );
  });

  it("创建配额由全局和管理员锁串行，并审计容量拒绝", () => {
    expect(source).toContain("operations-export:global");
    expect(source).toContain("operations.rejectcreateexport");
    expect(source).toContain("operations.rejectretryexport");
  });

  it("删除失败的 expired 对象和 CAS 失败孤儿都有后续重试扫描", () => {
    expect(source).toContain(
      "status = 'expired' and object_deleted_at is null"
    );
    expect(source).toContain("operations.exportorphandeleted");
    expect(source).toContain("referenced_task.object_key");
    expect(source).toContain("referenced_task.object_deleted_at is null");
    expect(source).toContain("operations.exportorphancleanupfailed");
    expect(source).toContain("latest_failure.created_at nulls first");
    expect(source).toContain("cleanup_error_code is not null");
    expect(source).toContain("else updated_at");
  });

  it("存储前缀清理保留任意任务引用，并能排除仍有效的运行租约", () => {
    const referencesStart = source.indexOf("async findreferencedobjectkeys");
    const referencesEnd = source.indexOf(
      "async findactiveexportleases",
      referencesStart
    );
    const referencesMethod = source.slice(referencesStart, referencesEnd);

    expect(referencesMethod).toContain("operationsexporttask.objectbucket");
    expect(referencesMethod).toContain("operationsexporttask.objectkey");
    expect(referencesMethod).not.toContain("objectdeletedat");
    expect(source).toContain('eq(operationsexporttask.status, "running")');
    expect(source).toContain(
      "gt(operationsexporttask.leaseexpiresat, input.now)"
    );
  });

  it("认领结果通过统一运行时解析器读取，禁止 query 类型断言回退", () => {
    const claimStart = source.indexOf("async claimnext");
    const claimEnd = source.indexOf("async renewlease", claimStart);
    const claimMethod = source.slice(claimStart, claimEnd);

    expect(claimMethod).toContain("parseclaimedoperationsexporttaskrow");
    expect(claimMethod).not.toContain("query as operationsdashboardqueryinput");
  });
});

describe("parseClaimedOperationsExportTaskRow", () => {
  const validRow = {
    id: "task-1",
    created_by: "admin-1",
    export_type: "user_growth",
    query: {
      granularity: "day",
      range: { kind: "custom", from: "2026-01-01", to: "2026-01-31" },
    },
    time_zone: "UTC",
    epoch_app_date: "2026-01-01",
    epoch_starts_at: "2026-01-01T00:00:00.000Z",
    schema_version: 1,
    snapshot_at: "2026-02-01T00:00:00.000Z",
    high_watermarks: {
      users: null,
      webVisits: null,
      outputs: null,
      paymentOrders: null,
      paymentLifecycle: null,
      creditContributions: null,
    },
    lease_owner: "worker-1",
    lease_token: "lease-1",
    attempt_count: 1,
  };

  it("解析合法认领行并规范化日期", () => {
    expect(parseClaimedOperationsExportTaskRow(validRow)).toEqual(
      expect.objectContaining({
        id: "task-1",
        query: validRow.query,
        epochStartsAt: new Date("2026-01-01T00:00:00.000Z"),
        snapshotAt: new Date("2026-02-01T00:00:00.000Z"),
      })
    );
  });

  it("拒绝数据库中的非法 query JSON", () => {
    expect(() =>
      parseClaimedOperationsExportTaskRow({
        ...validRow,
        query: {
          granularity: "day",
          range: { kind: "all_time" },
        },
      })
    ).toThrow();
  });
});
