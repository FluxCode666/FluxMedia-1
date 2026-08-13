/**
 * 公告列表的数据库无关分页编排。
 *
 * 使用方：生产数据库适配器与聚焦单元测试。服务强制先读取精确总数，再在同一
 * 快照中按收敛后的页码读取记录，确保 count 失败时不会继续伪造空列表。
 */
import {
  type PaginationState,
  resolvePaginationState,
} from "../pagination/state";
import type {
  AdminAnnouncementItem,
  AdminAnnouncementListOutput,
  UserAnnouncementListOutput,
  UserAnnouncementListRecord,
} from "./list-contract";

export type AnnouncementListSnapshot = {
  countActiveForUser: () => Promise<number>;
  listActiveForUser: (input: {
    limit: number;
    offset: number;
    userId: string;
  }) => Promise<UserAnnouncementListRecord[]>;
  countForAdmin: (
    published: AdminAnnouncementPageRequest["published"]
  ) => Promise<number>;
  listForAdmin: (input: {
    limit: number;
    offset: number;
    published: AdminAnnouncementPageRequest["published"];
  }) => Promise<AdminAnnouncementItem[]>;
  readAdminStats: () => Promise<AdminAnnouncementListOutput["stats"]>;
};

export type AnnouncementListRepository = {
  withReadSnapshot: <Result>(
    work: (snapshot: AnnouncementListSnapshot) => Promise<Result>
  ) => Promise<Result>;
};

export type AdminAnnouncementPageRequest = PaginationState & {
  published: "all" | "published" | "unpublished";
};

/**
 * 读取当前用户可见的一页活跃公告。
 *
 * @param userId - 来自 Principal 的当前用户 ID。
 * @param input - 已通过 UOL 校验的页码和页大小。
 * @param repository - 提供单一只读快照的仓储端口。
 * @returns 越界收敛后的记录和精确分页元数据。
 * @throws count 或 rows 任一读取失败时原样上抛，不返回伪空态。
 */
export async function listUserAnnouncementsPage(
  userId: string,
  input: PaginationState,
  repository: AnnouncementListRepository
): Promise<UserAnnouncementListOutput> {
  return repository.withReadSnapshot(async (snapshot) => {
    const totalCount = await snapshot.countActiveForUser();
    const pagination = resolvePaginationState(input, totalCount);
    const records = await snapshot.listActiveForUser({
      userId,
      limit: pagination.pageSize,
      offset: (pagination.page - 1) * pagination.pageSize,
    });
    return {
      records,
      page: pagination.page,
      pageSize: pagination.pageSize,
      totalCount: pagination.totalCount,
      totalPages: pagination.totalPages,
    };
  });
}

/**
 * 读取管理员公告页及独立全局统计。
 *
 * @param input - 已通过 UOL 校验的分页和发布状态筛选。
 * @param repository - 提供单一只读快照的仓储端口。
 * @returns 筛选口径的精确分页结果，以及不随当前页或筛选变化的全局统计。
 * @throws count、rows 或统计读取失败时原样上抛。
 */
export async function listAdminAnnouncementsPage(
  input: AdminAnnouncementPageRequest,
  repository: AnnouncementListRepository
): Promise<AdminAnnouncementListOutput> {
  return repository.withReadSnapshot(async (snapshot) => {
    const totalCount = await snapshot.countForAdmin(input.published);
    const pagination = resolvePaginationState(input, totalCount);
    const [records, stats] = await Promise.all([
      snapshot.listForAdmin({
        limit: pagination.pageSize,
        offset: (pagination.page - 1) * pagination.pageSize,
        published: input.published,
      }),
      snapshot.readAdminStats(),
    ]);
    return {
      records,
      page: pagination.page,
      pageSize: pagination.pageSize,
      totalCount: pagination.totalCount,
      totalPages: pagination.totalPages,
      stats,
    };
  });
}
