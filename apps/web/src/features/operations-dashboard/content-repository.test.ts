/**
 * 运营总览内容生产仓储 SQL 与事务边界测试。
 *
 * 不连接数据库；通过 PostgreSQL dialect 编译查询，证明三张趋势图只由成功
 * 产物事件驱动，积分按完整稳定身份关联且以百分之一积分精确聚合。
 */
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import {
  buildOperationsContentHeaderSql,
  buildOperationsContentSeriesSql,
  createOperationsContentRepository,
} from "./content-repository";

const dialect = new PgDialect();
const buckets = [
  {
    key: "day:2026-08-01",
    dataFrom: new Date("2026-08-01T00:00:00.000Z"),
    end: new Date("2026-08-02T00:00:00.000Z"),
  },
  {
    key: "day:2026-08-02",
    dataFrom: new Date("2026-08-02T00:00:00.000Z"),
    end: new Date("2026-08-03T00:00:00.000Z"),
  },
];

/** 将 Drizzle SQL 编译成可检查文本与参数。 */
function compile(query: Parameters<PgDialect["sqlToQuery"]>[0]) {
  return dialect.sqlToQuery(query);
}

describe("operations content repository SQL", () => {
  it("首条 SQL 同时捕获数据库时钟、epoch 与两个 v1 读模型状态", () => {
    const compiled = compile(buildOperationsContentHeaderSql());

    expect(compiled.sql).toContain("transaction_timestamp()");
    expect(compiled.sql).toContain('from "operations_analytics_epoch"');
    expect(compiled.sql).toContain('from "analytics_read_model_state"');
    expect(compiled.sql).toContain("output_usage");
    expect(compiled.sql).toContain("credit_usage");
  });

  it("三类趋势只由成功事件驱动并按完整稳定身份关联净积分", () => {
    const compiled = compile(buildOperationsContentSeriesSql(buckets));

    expect(compiled.sql).toContain('join "user_output_usage_event"');
    expect(compiled.sql).toContain(
      'left join "credit_usage_operation" as credit_lookup'
    );
    expect(compiled.sql).toContain(
      "credit_lookup.user_id = scoped_outputs.user_id"
    );
    expect(compiled.sql).toContain(
      "credit_lookup.operation_id = scoped_outputs.source_task_id"
    );
    expect(compiled.sql).toContain(
      "credit_lookup.operation_type = scoped_outputs.operation_type"
    );
    expect(compiled.sql).toMatch(
      /credit_lookup\.operation_created_at\s*= scoped_outputs\.operation_created_at/
    );
    expect(compiled.sql).toMatch(
      /mismatch_lookup\.operation_created_at\s*<> scoped_outputs\.operation_created_at/
    );
    expect(compiled.sql).toContain(
      "coalesce(credit_lookup.net_consumed, 0) * 100"
    );
    expect(compiled.sql).toContain("sum(scoped_outputs.image_count)");
    expect(compiled.sql).toMatch(
      /count\(\*\) filter \(\s*where scoped_outputs\.output_kind = 'video'/
    );
    expect(compiled.sql).toContain("sum(scoped_outputs.video_seconds)");
    expect(compiled.sql).not.toContain("credits_transaction");
    expect(compiled.sql).not.toContain('from "generation"');
    expect(compiled.sql).not.toContain('from "video_generation"');
  });

  it("完整关联条件防止跨用户和跨媒体任务串接", () => {
    const compiled = compile(buildOperationsContentSeriesSql(buckets));

    expect(compiled.sql).toContain(
      'when "user_output_usage_event"."output_kind" = \'image\''
    );
    expect(compiled.sql).toContain("then 'image_generation'");
    expect(compiled.sql).toContain("else 'video_generation'");
    expect(compiled.sql).toContain(
      "mismatch_lookup.user_id = scoped_outputs.user_id"
    );
    expect(compiled.sql).toMatch(
      /mismatch_lookup\.operation_type\s*= scoped_outputs\.operation_type/
    );
    expect(compiled.sql).toMatch(
      /mismatch_lookup\.operation_id\s*= scoped_outputs\.source_task_id/
    );
  });

  it("整个内容读取使用唯一只读 repeatable-read 事务", async () => {
    const connection = {
      marker: "content-transaction",
      execute: vi.fn(async function (this: { marker: string }) {
        expect(this.marker).toBe("content-transaction");
        return {
          rows: [
            {
              as_of: new Date(),
              app_date: null,
              starts_at: null,
              output_version: null,
              output_status: null,
              credit_version: null,
              credit_status: null,
            },
          ],
        };
      }),
    };
    const transaction = vi.fn(async (work) => work(connection));
    const repository = createOperationsContentRepository({ transaction });

    await repository.withReadOnlySnapshot((reader) => reader.readHeader());

    expect(transaction).toHaveBeenCalledOnce();
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
    expect(connection.execute).toHaveBeenCalledOnce();
  });
});
