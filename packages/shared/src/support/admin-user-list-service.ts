/**
 * 管理用户列表数据库读取服务。
 *
 * 使用方：user.list UOL operation。精确计数、越界收敛与当前页记录在同一个
 * repeatable-read 只读事务完成，避免并发注册或删除导致页码元数据相互矛盾。
 */
import { db } from "@repo/database";
import {
  creditsBalance,
  externalApiKey,
  generation,
  user,
} from "@repo/database/schema";
import { and, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { ADMIN_MANAGEMENT_ROLES } from "../auth/roles";
import type {
  AdminUserListInput,
  AdminUserListOutput,
} from "./admin-user-list-contract";

/** 根据已校验筛选条件构造用户列表查询条件。 */
function buildAdminUserListWhere(input: AdminUserListInput) {
  const filters = [];
  const normalizedQuery = input.query?.trim();
  if (normalizedQuery) {
    const query = `%${normalizedQuery}%`;
    filters.push(
      or(
        ilike(user.id, query),
        ilike(user.name, query),
        ilike(user.email, query)
      )
    );
  }
  if (input.status === "active") filters.push(eq(user.banned, false));
  else if (input.status === "banned") filters.push(eq(user.banned, true));
  else if (input.status === "unverified") {
    filters.push(eq(user.emailVerified, false));
  }
  if (input.creditsStatus !== "all") {
    filters.push(eq(creditsBalance.status, input.creditsStatus));
  }
  return filters.length > 0 ? and(...filters) : undefined;
}

/**
 * 读取受筛选管理用户页及精确总数。
 *
 * @param input - 已经 UOL schema 校验的页码、页大小与筛选。
 * @returns 越界收敛后的当前页、精确总数、用户行及全局摘要。
 */
export async function listAdminUsers(
  input: AdminUserListInput
): Promise<AdminUserListOutput> {
  const where = buildAdminUserListWhere(input);

  const result = await db.transaction(
    async (tx) => {
      const countQuery = tx
        .select({ count: count() })
        .from(user)
        .leftJoin(creditsBalance, eq(creditsBalance.userId, user.id));
      const totalResult = await (where ? countQuery.where(where) : countQuery);
      const totalCount = totalResult[0]?.count ?? 0;
      const totalPages = Math.max(1, Math.ceil(totalCount / input.pageSize));
      const page = Math.min(input.page, totalPages);

      const baseQuery = tx
        .select({
          id: user.id,
          name: user.name,
          email: user.email,
          image: user.image,
          role: user.role,
          banned: user.banned,
          bannedReason: user.bannedReason,
          emailVerified: user.emailVerified,
          imageGenerationConcurrencyOverride:
            user.imageGenerationConcurrencyOverride,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
          creditsBalance:
            sql<number>`coalesce(${creditsBalance.balance}, 0)`.mapWith(Number),
          creditsTotalEarned:
            sql<number>`coalesce(${creditsBalance.totalEarned}, 0)`.mapWith(
              Number
            ),
          creditsTotalSpent:
            sql<number>`coalesce(${creditsBalance.totalSpent}, 0)`.mapWith(
              Number
            ),
          creditsStatus: creditsBalance.status,
        })
        .from(user)
        .leftJoin(creditsBalance, eq(creditsBalance.userId, user.id));
      const [rows, totalUsers, adminUsers, bannedUsers] = await Promise.all([
        (where ? baseQuery.where(where) : baseQuery)
          .orderBy(desc(user.createdAt), desc(user.id))
          .limit(input.pageSize)
          .offset((page - 1) * input.pageSize),
        tx.select({ count: count() }).from(user),
        tx
          .select({ count: count() })
          .from(user)
          .where(
            inArray(user.role, ["observer_admin", ...ADMIN_MANAGEMENT_ROLES])
          ),
        tx.select({ count: count() }).from(user).where(eq(user.banned, true)),
      ]);

      const userIds = rows.map((row) => row.id);
      const [generationCounts, apiKeyCounts] =
        userIds.length > 0
          ? await Promise.all([
              tx
                .select({
                  userId: generation.userId,
                  total: sql<number>`count(*)`.mapWith(Number),
                  failed:
                    sql<number>`sum(case when ${generation.status} = 'failed' then 1 else 0 end)`.mapWith(
                      Number
                    ),
                })
                .from(generation)
                .where(inArray(generation.userId, userIds))
                .groupBy(generation.userId),
              tx
                .select({
                  userId: externalApiKey.userId,
                  total: sql<number>`count(*)`.mapWith(Number),
                  active:
                    sql<number>`sum(case when ${externalApiKey.isActive} then 1 else 0 end)`.mapWith(
                      Number
                    ),
                })
                .from(externalApiKey)
                .where(inArray(externalApiKey.userId, userIds))
                .groupBy(externalApiKey.userId),
            ])
          : [[], []];
      const generationMap = new Map(
        generationCounts.map((item) => [item.userId, item])
      );
      const apiKeyMap = new Map(
        apiKeyCounts.map((item) => [item.userId, item])
      );

      return {
        users: rows.map((row) => ({
          ...row,
          role: row.role ?? "user",
          creditsStatus: row.creditsStatus ?? "active",
          generationCount: generationMap.get(row.id)?.total ?? 0,
          failedGenerationCount: generationMap.get(row.id)?.failed ?? 0,
          apiKeyCount: apiKeyMap.get(row.id)?.total ?? 0,
          activeApiKeyCount: apiKeyMap.get(row.id)?.active ?? 0,
        })),
        pagination: { page, pageSize: input.pageSize, totalCount, totalPages },
        stats: {
          totalUsers: totalUsers[0]?.count ?? 0,
          admins: adminUsers[0]?.count ?? 0,
          banned: bannedUsers[0]?.count ?? 0,
        },
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" }
  );
  return result satisfies AdminUserListOutput;
}
