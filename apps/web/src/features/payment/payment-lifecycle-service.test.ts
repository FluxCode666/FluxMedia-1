/**
 * 支付生命周期过期扫描的 DB-free SQL 契约测试。
 *
 * 使用方：防止运营漏斗的 expired 事实因并发竞态、范围放宽或误改订单状态而失真。
 * 关键依赖：可注入最小数据库端口与 Drizzle PostgreSQL SQL 编译器。
 */
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  db: {
    transaction: vi.fn(),
  },
}));
vi.mock("@repo/database/schema", () => ({
  epayOrder: {},
  paymentFulfillmentWorkItem: {},
  paymentLifecycleEvent: {},
  paymentOrder: {},
}));

import {
  createCreemAmountMismatchRecorder,
  createPaymentExpirationRecorder,
} from "./payment-lifecycle-service";

const NOW = new Date("2026-08-13T04:00:00.000Z");

/** 构造记录事务 SQL 且可控制 returning 行数的测试数据库。 */
function createDatabase(resultRows: unknown[][]) {
  const queries: SQL[] = [];
  let callIndex = 0;
  const database = {
    async transaction<T>(
      work: (transaction: {
        execute(query: SQL): Promise<unknown>;
      }) => Promise<T>
    ): Promise<T> {
      return work({
        async execute(query) {
          queries.push(query);
          const rows = resultRows[callIndex] ?? [];
          callIndex += 1;
          return { rows };
        },
      });
    },
  };
  return { database, queries };
}

describe("payment expiration recorder", () => {
  it("仅锁定已到期充值订单并幂等追加事实", async () => {
    const { database, queries } = createDatabase([[{ id: "event-1" }]]);
    const recordExpired = createPaymentExpirationRecorder(database);

    await expect(recordExpired(NOW)).resolves.toBe(1);

    const compiled = new PgDialect().sqlToQuery(queries[0] as SQL);
    expect(compiled.sql).toContain("for update of payment skip locked");
    expect(compiled.sql).toContain(
      "payment.purpose in ('credit_top_up', 'credit_package')"
    );
    expect(compiled.sql).toContain("payment.status in ('creating', 'pending')");
    expect(compiled.sql).toContain("payment.expires_at <=");
    expect(compiled.sql).toContain("payment.expires_at asc");
    expect(compiled.sql).toContain("not exists");
    expect(compiled.sql).toContain("event.event_type = 'expired'");
    expect(compiled.sql).toContain("on conflict (");
    expect(compiled.sql).toContain("do nothing");
    expect(compiled.sql).not.toMatch(/update\s+payment_order/i);
    expect(compiled.sql).not.toMatch(/payment\.status\s*=/i);
    expect(compiled.params).toEqual([NOW, 100, NOW]);
  });

  it("数据库未返回新事件时重跑报告零且不伪造写入数", async () => {
    const { database } = createDatabase([[], []]);
    const recordExpired = createPaymentExpirationRecorder(database);

    await expect(recordExpired(NOW)).resolves.toBe(0);
    await expect(recordExpired(NOW)).resolves.toBe(0);
  });
});

describe("Creem amount mismatch recorder", () => {
  it("原子确认支付并终结异常金额订单且不创建可领取工作项", async () => {
    const { database, queries } = createDatabase([[{ id: "event-terminal" }]]);
    const rejectMismatch = createCreemAmountMismatchRecorder(database);

    await expect(
      rejectMismatch({
        orderId: "order-1",
        userId: "user-1",
        providerTradeNo: "creem-order-1",
        eventSourceRef: "creem:creem-order-1",
        occurredAt: NOW,
      })
    ).resolves.toBe(true);

    const compiled = new PgDialect().sqlToQuery(queries[0] as SQL);
    expect(compiled.sql.toLowerCase()).toContain("update payment_order");
    expect(compiled.sql).toContain("payment_confirmed");
    expect(compiled.sql).toContain("fulfillment_failed_terminal");
    expect(compiled.sql).toContain("provider_amount_mismatch");
    expect(compiled.sql).not.toContain(
      "insert into payment_fulfillment_work_item"
    );
  });
});
