/**
 * 运营导出任务仓储 SQL 契约测试。
 *
 * 使用方：U6。防止认领退化为 offset/无锁扫描，且确保陈旧 running 与删除失败的
 * expired 对象能够恢复。数据库行为集成将在生产规模核对阶段执行。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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
  });
});
