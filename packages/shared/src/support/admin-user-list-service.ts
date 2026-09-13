/** Go/PostgreSQL adapter for the admin user list operation. */
import { requestGoBackendJson } from "../http/go-backend";
import type {
  AdminUserListInput,
  AdminUserListOutput,
} from "./admin-user-list-contract";

/**
 * 读取受筛选管理用户页及精确总数。
 *
 * @param input - 已经 UOL schema 校验的页码、页大小与筛选。
 * @returns 越界收敛后的当前页、精确总数、用户行及全局摘要。
 */
export async function listAdminUsers(
  input: AdminUserListInput
): Promise<AdminUserListOutput> {
  const query = new URLSearchParams({
    page: String(input.page),
    pageSize: String(input.pageSize),
    status: input.status,
    creditsStatus: input.creditsStatus,
  });
  if (input.query) query.set("query", input.query);
  return requestGoBackendJson<AdminUserListOutput>(
    `/api/admin/users?${query.toString()}`
  );
}
