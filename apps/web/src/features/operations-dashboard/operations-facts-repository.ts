/**
 * 运营总览基础事实 PostgreSQL 仓储。
 *
 * 使用方：epoch 初始化与网页访问服务。所有数据库返回都先经 Zod 校验；epoch 在同一
 * 事务内使用 advisory lock 串行化首次初始化，网页访问依靠复合主键幂等去重。
 */
import { adminAuditLog } from "@repo/database/schema";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { extractExecuteRows } from "@/server/database-result";

const OPERATIONS_EPOCH_LOCK_KEY = 6_799_527_419;

const epochRowSchema = z.object({
  app_date: z.string(),
  starts_at: z.coerce.date(),
  initialized_by: z.string().nullable(),
  initialization_request_id: z.string(),
});

/** 已持久化的生产运营 epoch。 */
export type StoredOperationsEpoch = {
  appDate: string;
  startsAt: Date;
  initializedBy: string | null;
  initializationRequestId: string;
};

/** epoch 首次初始化和审计所需输入。 */
export type InsertOperationsEpochInput = StoredOperationsEpoch & {
  auditId: string;
  createdAt: Date;
};

/** 访问事实幂等写入端口。 */
export interface OperationsFactsRepository {
  recordWebVisit(input: {
    userId: string;
    appDate: string;
    visitedAt: Date;
  }): Promise<boolean>;
  initializeEpoch(input: InsertOperationsEpochInput): Promise<{
    epoch: StoredOperationsEpoch;
    inserted: boolean;
  }>;
}

/** 从未知数据库结果读取并校验单个 epoch 行。 */
function parseEpochRow(result: unknown): StoredOperationsEpoch | null {
  const row = extractExecuteRows(result)[0];
  if (!row) return null;
  const parsed = epochRowSchema.parse(row);
  return {
    appDate: parsed.app_date,
    startsAt: parsed.starts_at,
    initializedBy: parsed.initialized_by,
    initializationRequestId: parsed.initialization_request_id,
  };
}

/** PostgreSQL 运营事实仓储；连接在调用时延迟导入，避免测试加载环境连接。 */
export const databaseOperationsFactsRepository: OperationsFactsRepository = {
  /**
   * 幂等写入当前用户的应用自然日访问事实。
   *
   * @returns 首次插入返回 true，同日重放返回 false。
   * @failure 数据库异常显式上抛，由 dashboard shell 记录告警并继续主流程。
   */
  async recordWebVisit(input) {
    const { db } = await import("@repo/database");
    const result = await db.execute(sql`
      insert into user_web_visit (
        user_id,
        app_date,
        first_visited_at
      ) values (
        ${input.userId},
        ${input.appDate},
        ${input.visitedAt}
      )
      on conflict (user_id, app_date) do nothing
      returning user_id
    `);
    return extractExecuteRows(result).length === 1;
  },

  /**
   * 串行化并幂等初始化生产 epoch。
   *
   * @returns 首次写入或已经存在的固定 epoch；同事务写管理员审计。
   * @failure SQL 失败整笔回滚；不同值冲突由领域服务比较后拒绝。
   */
  async initializeEpoch(input) {
    const { db } = await import("@repo/database");
    return db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(${OPERATIONS_EPOCH_LOCK_KEY})`
      );
      const existing = parseEpochRow(
        await transaction.execute(sql`
          select
            app_date,
            starts_at,
            initialized_by,
            initialization_request_id
          from operations_analytics_epoch
          where id = 1
          limit 1
        `)
      );
      if (existing) return { epoch: existing, inserted: false };

      const inserted = parseEpochRow(
        await transaction.execute(sql`
          insert into operations_analytics_epoch (
            id,
            app_date,
            starts_at,
            initialized_by,
            initialization_request_id,
            created_at
          ) values (
            1,
            ${input.appDate},
            ${input.startsAt},
            ${input.initializedBy},
            ${input.initializationRequestId},
            ${input.createdAt}
          )
          returning
            app_date,
            starts_at,
            initialized_by,
            initialization_request_id
        `)
      );
      if (!inserted) {
        throw new Error("Operations analytics epoch insert returned no row");
      }
      await transaction.insert(adminAuditLog).values({
        id: input.auditId,
        adminUserId: null,
        targetUserId: null,
        action: "operations.initializeEpoch",
        reason: "初始化运营总览生产统计起点",
        before: null,
        after: {
          appDate: input.appDate,
          startsAt: input.startsAt.toISOString(),
        },
        metadata: {
          initializedBy: input.initializedBy,
          requestId: input.initializationRequestId,
        },
        createdAt: input.createdAt,
      });
      return { epoch: inserted, inserted: true };
    });
  },
};
