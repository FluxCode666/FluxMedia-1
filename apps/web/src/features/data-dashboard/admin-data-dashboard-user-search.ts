/**
 * 管理端数据看板用户下拉搜索服务。
 *
 * 使用方：管理员数据看板 UOL binding。服务只返回下拉所需的用户 ID、名称和邮箱，
 * 输入经过 shared schema 校验，仓储实现使用参数化 ILIKE，不把名称或邮箱带入统计 SQL。
 */
import { user } from "@repo/database/schema";
import {
  type AdminDataDashboardUserOption,
  type AdminDataDashboardUserSearchOutput,
  adminDataDashboardUserSearchInputSchema,
  adminDataDashboardUserSearchOutputSchema,
} from "@repo/shared/analytics/contracts";
import { asc, eq, ilike, or } from "drizzle-orm";

/** 管理端用户搜索仓储端口，便于服务层使用 DB-free 单测。 */
export interface AdminDataDashboardUserSearchRepository {
  searchUsers(input: {
    query: string;
    limit: number;
    selectedUserId?: string;
  }): Promise<AdminDataDashboardUserOption[]>;
}

/** 对 ILIKE 通配符做字面量转义，避免搜索输入扩大匹配范围。 */
function escapeLikePattern(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

/** 生产 PostgreSQL 用户搜索；选中用户优先按 ID 精确读取以保证深链可恢复。 */
const databaseAdminDataDashboardUserSearchRepository: AdminDataDashboardUserSearchRepository =
  {
    async searchUsers(input) {
      const { db } = await import("@repo/database");
      const search = escapeLikePattern(input.query);
      const predicate = input.selectedUserId
        ? eq(user.id, input.selectedUserId)
        : search
          ? or(
              ilike(user.name, `%${search}%`),
              ilike(user.email, `%${search}%`)
            )
          : undefined;
      const rows = await db
        .select({ id: user.id, name: user.name, email: user.email })
        .from(user)
        .where(predicate)
        .orderBy(asc(user.name), asc(user.email), asc(user.id))
        .limit(input.limit);
      return rows;
    },
  };

/** 搜索并严格收敛管理员用户下拉输出。 */
export async function searchAdminDataDashboardUsers(
  input: unknown,
  repository: AdminDataDashboardUserSearchRepository = databaseAdminDataDashboardUserSearchRepository
): Promise<AdminDataDashboardUserSearchOutput> {
  const parsed = adminDataDashboardUserSearchInputSchema.parse(input);
  return adminDataDashboardUserSearchOutputSchema.parse({
    users: await repository.searchUsers(parsed),
  });
}
