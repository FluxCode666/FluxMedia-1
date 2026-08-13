/**
 * 管理状态历史错误 UOL 数据库 binding。
 *
 * 使用方：UOL 启动聚合器。精确计数、页码收敛和结果行在 repeatable-read 只读事务
 * 完成，并使用 createdAt/id 稳定排序，防止同时间写入造成页内顺序漂移。
 */
import { db } from "@repo/database";
import { generation, user } from "@repo/database/schema";
import type {
  AdminStatusErrorListInput,
  AdminStatusErrorListOutput,
} from "@repo/shared/image-generation/admin-status-errors-contract";
import { bindOperationExecute } from "@repo/shared/uol";
import { listAdminStatusErrors } from "@repo/shared/uol/operations";
import { and, count, desc, eq, gte, lte, type SQL } from "drizzle-orm";
import {
  classifyGenerationError,
  type GenerationErrorCategory,
} from "@/features/image-generation/sla";

/** 根据 UOL 已校验的绝对时间边界构造失败记录条件。 */
function buildAdminStatusErrorWhere(input: AdminStatusErrorListInput) {
  const conditions: SQL[] = [eq(generation.status, "failed")];
  if (input.fromDate)
    conditions.push(gte(generation.createdAt, input.fromDate));
  if (input.toDate) conditions.push(lte(generation.createdAt, input.toDate));
  return and(...conditions);
}

/** 读取越界收敛后的管理状态错误页与精确总数。 */
async function executeListAdminStatusErrors(
  input: AdminStatusErrorListInput
): Promise<AdminStatusErrorListOutput> {
  const where = buildAdminStatusErrorWhere(input);
  const result = await db.transaction(
    async (tx) => {
      const totalRows = await tx
        .select({ totalCount: count() })
        .from(generation)
        .where(where);
      const totalCount = totalRows[0]?.totalCount ?? 0;
      const totalPages = Math.max(1, Math.ceil(totalCount / input.pageSize));
      const page = Math.min(input.page, totalPages);
      const rows = await tx
        .select({
          id: generation.id,
          userId: generation.userId,
          userEmail: user.email,
          userName: user.name,
          prompt: generation.prompt,
          model: generation.model,
          size: generation.size,
          creditsConsumed: generation.creditsConsumed,
          error: generation.error,
          createdAt: generation.createdAt,
          completedAt: generation.completedAt,
        })
        .from(generation)
        .leftJoin(user, eq(user.id, generation.userId))
        .where(where)
        .orderBy(desc(generation.createdAt), desc(generation.id))
        .limit(input.pageSize)
        .offset((page - 1) * input.pageSize);
      return {
        records: rows.map((row) => ({
          ...row,
          category: classifyGenerationError(
            row.error
          ) as GenerationErrorCategory,
        })),
        page,
        pageSize: input.pageSize,
        totalCount,
        totalPages,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" }
  );
  return result satisfies AdminStatusErrorListOutput;
}

bindOperationExecute(listAdminStatusErrors, executeListAdminStatusErrors);
