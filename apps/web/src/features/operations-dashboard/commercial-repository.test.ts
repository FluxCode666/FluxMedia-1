/**
 * 运营总览商业化仓储 SQL 与事务边界测试。
 *
 * 不连接数据库；通过 PostgreSQL dialect 编译查询，证明漏斗只依赖不可变
 * 生命周期事实、收入只取已履约充值，且重复事件不会膨胀订单数量。
 */
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import {
  buildOperationsCommercialLifecycleSql,
  buildOperationsCommercialPayingUsersSql,
  buildOperationsCommercialRevenueSql,
  createOperationsCommercialRepository,
} from "./commercial-repository";

const dialect = new PgDialect();
const range = {
  start: new Date("2026-08-01T00:00:00.000Z"),
  end: new Date("2026-08-08T00:00:00.000Z"),
};

/** 将 Drizzle SQL 编译成可检查文本与参数。 */
function compile(query: Parameters<PgDialect["sqlToQuery"]>[0]) {
  return dialect.sqlToQuery(query);
}

describe("operations commercial repository SQL", () => {
  it("漏斗按订单去重并仅从生命周期事件推导历史阶段", () => {
    const compiled = compile(buildOperationsCommercialLifecycleSql(range));

    expect(compiled.sql).toContain('from "payment_lifecycle_event"');
    expect(compiled.sql).toContain('join "payment_order"');
    expect(compiled.sql).toContain("in ('credit_top_up', 'credit_package')");
    expect(compiled.sql).toContain("group by scoped_events.payment_order_id");
    expect(compiled.sql).toContain("bool_or(");
    expect(compiled.sql).toContain("event_type = 'order_created'");
    expect(compiled.sql).toContain("event_type = 'payment_confirmed'");
    expect(compiled.sql).toContain("event_type = 'fulfillment_succeeded'");
    expect(compiled.sql).toContain("event_type in (");
    expect(compiled.sql).not.toContain('"payment_order"."status"');
  });

  it("收入只按 fulfilled_at 汇总已履约充值且不读取积分退款", () => {
    const compiled = compile(buildOperationsCommercialRevenueSql(range));

    expect(compiled.sql).toContain('from "payment_order"');
    expect(compiled.sql).toContain("= 'fulfilled'");
    expect(compiled.sql).toContain("in ('credit_top_up', 'credit_package')");
    expect(compiled.sql).toContain('"payment_order"."fulfilled_at" >=');
    expect(compiled.sql).toContain("group by upper(");
    expect(compiled.sql).not.toContain("credits_transaction");
    expect(compiled.sql).not.toContain("credit_usage_operation");
  });

  it("付费用户以已履约充值用户去重", () => {
    const compiled = compile(buildOperationsCommercialPayingUsersSql(range));

    expect(compiled.sql).toContain('count(distinct "payment_order"."user_id")');
    expect(compiled.sql).toContain('"payment_order"."fulfilled_at" >=');
    expect(compiled.sql).toContain('"payment_order"."fulfilled_at" <');
  });

  it("整个商业化读取使用唯一只读 repeatable-read 事务", async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [{ as_of: new Date(), app_date: null, starts_at: null }],
    });
    const transaction = vi.fn(async (work) => work({ execute }));
    const repository = createOperationsCommercialRepository({ transaction });

    await repository.withReadOnlySnapshot((reader) => reader.readHeader());

    expect(transaction).toHaveBeenCalledOnce();
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
    expect(execute).toHaveBeenCalledOnce();
  });
});
