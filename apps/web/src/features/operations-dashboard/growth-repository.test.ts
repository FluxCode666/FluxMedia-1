/**
 * 运营增长仓储 SQL 与事务边界测试。
 *
 * 不连接数据库；通过 PostgreSQL dialect 编译查询，证明累计用户无身份过滤、
 * 三类活跃同源、趋势逐桶去重以及 Cohort 行为不被注册范围结束日截断。
 */
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import {
  buildOperationsActivitySeriesSql,
  buildOperationsActivityUserCountSql,
  buildOperationsCohortSql,
  buildOperationsCumulativeUserCountSql,
  buildOperationsNewUserCountSql,
  buildOperationsNewUserSeriesSql,
  createOperationsGrowthRepository,
} from "./growth-repository";

const dialect = new PgDialect();
const range = {
  start: new Date("2026-08-01T00:00:00.000Z"),
  end: new Date("2026-08-08T00:00:00.000Z"),
};
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

describe("operations growth repository SQL", () => {
  it("累计用户包含所有角色和封禁状态", () => {
    const compiled = compile(buildOperationsCumulativeUserCountSql(range.end));

    expect(compiled.sql).toContain('from "user"');
    expect(compiled.sql).toContain('"user"."created_at" <');
    expect(compiled.sql).not.toContain("role");
    expect(compiled.sql).not.toContain("banned");
  });

  it("新增用户使用服务层已截断 epoch 的范围边界", () => {
    const compiled = compile(buildOperationsNewUserCountSql(range));

    expect(compiled.sql).toMatch(/"user"\."created_at" >= \$\d+/);
    expect(compiled.params).toEqual([
      range.start.toISOString(),
      range.end.toISOString(),
    ]);
  });

  it("登录、创作与付费活跃使用各自权威成功事实", () => {
    const login = compile(buildOperationsActivityUserCountSql("login", range));
    const creation = compile(
      buildOperationsActivityUserCountSql("creation", range)
    );
    const payment = compile(
      buildOperationsActivityUserCountSql("payment", range)
    );

    expect(login.sql).toContain('from "user_web_visit"');
    expect(login.sql).toContain("count(distinct user_id)");
    expect(creation.sql).toContain('from "user_output_usage_event"');
    expect(creation.sql).not.toContain("user_web_visit");
    expect(payment.sql).toContain('from "payment_order"');
    expect(payment.sql).toContain("= 'fulfilled'");
    expect(payment.sql).toContain("in ('credit_top_up', 'credit_package')");
  });

  it("趋势使用参数化桶并在每个桶内独立去重", () => {
    const newUsers = compile(buildOperationsNewUserSeriesSql(buckets));
    const creation = compile(
      buildOperationsActivitySeriesSql("creation", buckets)
    );

    expect(newUsers.sql).toContain(
      "with buckets(bucket_key, bucket_start, bucket_end)"
    );
    expect(newUsers.params).toEqual(
      expect.arrayContaining(["day:2026-08-01", "day:2026-08-02"])
    );
    expect(creation.sql).toContain("count(distinct scoped_activity.user_id)");
    expect(creation.sql).toContain(
      "scoped_activity.business_time >= buckets.bucket_start"
    );
    expect(creation.sql).not.toContain("sql.raw");
  });

  it("Cohort 以注册范围筛选用户但以 asOf 筛选后续创作", () => {
    const asOf = new Date("2026-09-08T12:00:00.000Z");
    const compiled = compile(
      buildOperationsCohortSql({
        ...range,
        epochStart: range.start,
        asOf,
        timeZone: "Asia/Shanghai",
      })
    );

    expect(compiled.sql).toContain("cohort_date + 1");
    expect(compiled.sql).toContain("cohort_date + 7");
    expect(compiled.sql).toContain("cohort_date + 30");
    expect(compiled.sql).toContain(
      'join cohort_users\n        on cohort_users.user_id = "user_output_usage_event"."user_id"'
    );
    expect(compiled.params).toContain(asOf.toISOString());
    expect(
      compiled.params.filter((value) => value === range.end.toISOString())
    ).toHaveLength(1);
    expect(compiled.params).toContain("Asia/Shanghai");
  });

  it("整个增长读取使用唯一只读 repeatable-read 事务", async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [{ as_of: new Date(), app_date: null, starts_at: null }],
    });
    const transaction = vi.fn(async (work) => work({ execute }));
    const repository = createOperationsGrowthRepository({ transaction });

    await repository.withReadOnlySnapshot((reader) => reader.readHeader());

    expect(transaction).toHaveBeenCalledOnce();
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
    expect(execute).toHaveBeenCalledOnce();
  });
});
