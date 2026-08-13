/**
 * 运营增长明细 SQL 同源谓词与 keyset 测试。
 *
 * 不连接数据库；通过编译 SQL 证明新增、活跃与 Cohort 均可逐行反算，
 * 且分页始终比较原始 business_time 和用户主键。
 */
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  buildOperationsActivityDetailSql,
  buildOperationsCohortDetailSql,
  buildOperationsNewUserDetailSql,
  createOperationsGrowthDetailRepository,
  paginateOperationsGrowthDetailRows,
} from "./detail-repository";

const dialect = new PgDialect();
const base = {
  start: new Date("2026-08-01T00:00:00.000Z"),
  end: new Date("2026-08-08T00:00:00.000Z"),
  epochStart: new Date("2026-08-01T00:00:00.000Z"),
  asOf: new Date("2026-08-08T00:00:00.000Z"),
  cursor: {
    businessTime: new Date("2026-08-05T12:00:00.000Z"),
    stableId: "user-5",
  },
  limit: 101,
};

describe("operations growth detail repository SQL", () => {
  it("新增用户明细无角色过滤并使用双列 keyset", () => {
    const compiled = dialect.sqlToQuery(
      buildOperationsNewUserDetailSql({ ...base, kind: "users" })
    );

    expect(compiled.sql).toContain('from "user"');
    expect(compiled.sql).toContain('"user"."created_at" <');
    expect(compiled.sql).toContain('"user"."id" <');
    expect(compiled.sql).toContain(
      'order by "user"."created_at" desc, "user"."id" desc'
    );
    expect(compiled.sql).not.toContain("role =");
    expect(compiled.sql).not.toContain("banned =");
  });

  it("创作活跃明细复用成功产物事实并每用户仅一行", () => {
    const compiled = dialect.sqlToQuery(
      buildOperationsActivityDetailSql({
        ...base,
        kind: "activity",
        activityKind: "creation",
      })
    );

    expect(compiled.sql).toContain('from "user_output_usage_event"');
    expect(compiled.sql).toContain("group by scoped_activity.user_id");
    expect(compiled.sql).toContain("min(scoped_activity.business_time)");
    expect(compiled.sql).toContain("activity_users.business_time <");
    expect(compiled.sql).toContain("activity_users.user_id <");
  });

  it("付费活跃明细只使用已履约充值订单", () => {
    const compiled = dialect.sqlToQuery(
      buildOperationsActivityDetailSql({
        ...base,
        kind: "activity",
        activityKind: "payment",
      })
    );

    expect(compiled.sql).toContain('from "payment_order"');
    expect(compiled.sql).toContain("= 'fulfilled'");
    expect(compiled.sql).toContain("in ('credit_top_up', 'credit_package')");
  });

  it("Cohort 明细每注册用户一行且目标日创作投影为 retained", () => {
    const compiled = dialect.sqlToQuery(
      buildOperationsCohortDetailSql({
        ...base,
        kind: "cohort",
        targetStart: new Date("2026-08-02T00:00:00.000Z"),
        targetEnd: new Date("2026-08-03T00:00:00.000Z"),
      })
    );

    expect(compiled.sql).toContain("exists (");
    expect(compiled.sql).toContain('from "user_output_usage_event"');
    expect(compiled.sql).toContain("as retained");
    expect(compiled.sql).not.toContain("join user_output_usage_event");
  });

  it("拒绝无界、未成熟或过大的明细读取", () => {
    expect(() =>
      buildOperationsNewUserDetailSql({
        ...base,
        kind: "users",
        limit: 10_002,
      })
    ).toThrow("运营增长明细查询无效");
    expect(() =>
      buildOperationsCohortDetailSql({
        ...base,
        kind: "cohort",
        targetStart: new Date("2026-08-09T00:00:00.000Z"),
        targetEnd: new Date("2026-08-10T00:00:00.000Z"),
      })
    ).toThrow("Cohort 目标日范围无效");
  });

  it("以最后一个已返回行签发下一页原始 keyset", () => {
    const makeRow = (userId: string, businessTime: string) => ({
      userId,
      name: userId,
      email: `${userId}@example.com`,
      role: "user",
      banned: false,
      businessTime: new Date(businessTime),
      retained: null,
    });
    const page = paginateOperationsGrowthDetailRows(
      [
        makeRow("user-3", "2026-08-03T00:00:00.000Z"),
        makeRow("user-2", "2026-08-02T00:00:00.000Z"),
        makeRow("user-1", "2026-08-01T00:00:00.000Z"),
      ],
      2
    );

    expect(page.rows.map((row) => row.userId)).toEqual(["user-3", "user-2"]);
    expect(page.nextCursor).toEqual({
      businessTime: new Date("2026-08-02T00:00:00.000Z"),
      stableId: "user-2",
    });
  });

  it("明细头与行读取共享单一只读 repeatable-read 事务", async () => {
    const execute = async () => ({
      rows: [
        {
          as_of: "2026-08-08T00:00:00.000Z",
          app_date: "2026-08-01",
          starts_at: "2026-08-01T00:00:00.000Z",
        },
      ],
    });
    const transaction = async <T>(
      work: (transaction: { execute: typeof execute }) => Promise<T>,
      config: {
        isolationLevel: "repeatable read";
        accessMode: "read only";
      }
    ): Promise<T> => {
      expect(config).toEqual({
        isolationLevel: "repeatable read",
        accessMode: "read only",
      });
      return work({ execute });
    };
    const repository = createOperationsGrowthDetailRepository({ transaction });

    await expect(
      repository.withReadOnlySnapshot((reader) => reader.readHeader())
    ).resolves.toEqual({
      asOf: new Date("2026-08-08T00:00:00.000Z"),
      epoch: {
        appDate: "2026-08-01",
        startsAt: new Date("2026-08-01T00:00:00.000Z"),
      },
    });
  });
});
