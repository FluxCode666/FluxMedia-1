/**
 * 客服工单与消息的数据库分页服务。
 *
 * 使用方：support UOL operations。每次列表读取都在只读 repeatable-read
 * 事务内完成精确计数、越界收敛和当前页查询，避免并发写入产生矛盾元数据。
 */
import { db } from "@repo/database";
import { ticket, ticketMessage, user } from "@repo/database/schema";
import { and, count, desc, eq, ilike, or, type SQL, sql } from "drizzle-orm";
import { OperationError } from "../uol/errors";
import type { Principal } from "../uol/principal";
import type {
  TicketListInput,
  TicketListOutput,
  TicketMessageListInput,
  TicketMessageListOutput,
} from "./ticket-list-contract";

const adminUnreadSql =
  sql<boolean>`${ticket.lastUserActivityAt} is not null and (${ticket.adminLastSeenAt} is null or ${ticket.lastUserActivityAt} > ${ticket.adminLastSeenAt})`.mapWith(
    Boolean
  );
const userUnreadSql =
  sql<boolean>`${ticket.lastAdminActivityAt} > ${ticket.userLastSeenAt}`.mapWith(
    Boolean
  );

/** 判断人工会话是否按管理员视角读取工单。 */
function isAdminPrincipal(principal: Principal): boolean {
  return (
    principal.type === "user" &&
    (principal.role === "admin" || principal.role === "super_admin")
  );
}

/** 从人工会话提取用户 ID，拒绝 API Key 或系统身份读取人工客服数据。 */
function requireUserPrincipal(principal: Principal) {
  if (principal.type !== "user") {
    throw new OperationError(
      "unauthenticated",
      "User session authentication required"
    );
  }
  return principal;
}

/** 根据权限范围和公开筛选构造工单列表条件。 */
function buildTicketListWhere(
  input: TicketListInput,
  principal: Principal
): SQL | undefined {
  const currentUser = requireUserPrincipal(principal);
  const conditions: SQL[] = [];
  if (!isAdminPrincipal(principal)) {
    conditions.push(eq(ticket.userId, currentUser.userId));
  }
  if (input.status !== "all") conditions.push(eq(ticket.status, input.status));
  if (input.search) {
    const pattern = `%${input.search}%`;
    const search = isAdminPrincipal(principal)
      ? or(
          ilike(ticket.subject, pattern),
          ilike(user.name, pattern),
          ilike(user.email, pattern)
        )
      : ilike(ticket.subject, pattern);
    if (search) conditions.push(search);
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

/**
 * 分页读取当前会话可见的工单。
 *
 * @param input 已经 UOL 校验的分页与筛选状态。
 * @param principal 只接受人工 user Principal；普通用户按归属过滤。
 * @returns 越界收敛后的稳定工单页和精确总数。
 */
export async function listTickets(
  input: TicketListInput,
  principal: Principal
): Promise<TicketListOutput> {
  const where = buildTicketListWhere(input, principal);
  const unread = isAdminPrincipal(principal) ? adminUnreadSql : userUnreadSql;
  return db.transaction(
    async (tx) => {
      const countQuery = tx
        .select({ totalCount: count() })
        .from(ticket)
        .leftJoin(user, eq(ticket.userId, user.id));
      const countRows = await (where ? countQuery.where(where) : countQuery);
      const totalCount = countRows[0]?.totalCount ?? 0;
      const totalPages = Math.max(1, Math.ceil(totalCount / input.pageSize));
      const page = Math.min(input.page, totalPages);
      const rowsQuery = tx
        .select({
          id: ticket.id,
          userId: ticket.userId,
          subject: ticket.subject,
          category: ticket.category,
          priority: ticket.priority,
          status: ticket.status,
          unread,
          createdAt: ticket.createdAt,
          updatedAt: ticket.updatedAt,
          userName: user.name,
          userEmail: user.email,
        })
        .from(ticket)
        .leftJoin(user, eq(ticket.userId, user.id));
      const records = await (where ? rowsQuery.where(where) : rowsQuery)
        .orderBy(desc(ticket.createdAt), desc(ticket.id))
        .limit(input.pageSize)
        .offset((page - 1) * input.pageSize);
      return {
        records,
        page,
        pageSize: input.pageSize,
        totalCount,
        totalPages,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" }
  );
}

/**
 * 分页读取工单详情和消息历史。
 *
 * @param input 工单 ID 与消息 namespace 分页状态。
 * @param principal 管理员可读任意工单，普通用户只读本人资源。
 * @returns 工单主体、创建者以及按时间稳定排序的消息页。
 * @throws 工单不存在时抛 not_found，越权时不泄露资源是否存在。
 */
export async function listTicketMessages(
  input: TicketMessageListInput,
  principal: Principal
): Promise<TicketMessageListOutput> {
  const currentUser = requireUserPrincipal(principal);
  return db.transaction(
    async (tx) => {
      const ticketWhere = isAdminPrincipal(principal)
        ? eq(ticket.id, input.ticketId)
        : and(
            eq(ticket.id, input.ticketId),
            eq(ticket.userId, currentUser.userId)
          );
      const ticketRows = await tx
        .select({
          ticket,
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
            image: user.image,
          },
        })
        .from(ticket)
        .leftJoin(user, eq(ticket.userId, user.id))
        .where(ticketWhere)
        .limit(1);
      const ticketRecord = ticketRows[0];
      if (!ticketRecord) {
        throw new OperationError(
          "not_found",
          "Ticket not found",
          undefined,
          404
        );
      }

      const countRows = await tx
        .select({ totalCount: count() })
        .from(ticketMessage)
        .where(eq(ticketMessage.ticketId, input.ticketId));
      const totalCount = countRows[0]?.totalCount ?? 0;
      const totalPages = Math.max(1, Math.ceil(totalCount / input.pageSize));
      const page = Math.min(input.page, totalPages);
      const records = await tx
        .select({
          id: ticketMessage.id,
          content: ticketMessage.content,
          isAdminResponse: ticketMessage.isAdminResponse,
          createdAt: ticketMessage.createdAt,
          user: { id: user.id, name: user.name, image: user.image },
        })
        .from(ticketMessage)
        .leftJoin(user, eq(ticketMessage.userId, user.id))
        .where(eq(ticketMessage.ticketId, input.ticketId))
        .orderBy(desc(ticketMessage.createdAt), desc(ticketMessage.id))
        .limit(input.pageSize)
        .offset((page - 1) * input.pageSize);
      return {
        ticket: ticketRecord.ticket,
        ticketUser: ticketRecord.user
          ? {
              id: ticketRecord.user.id,
              name: ticketRecord.user.name,
              email: ticketRecord.user.email,
              image: ticketRecord.user.image,
            }
          : null,
        messages: {
          records: records.reverse(),
          page,
          pageSize: input.pageSize,
          totalCount,
          totalPages,
        },
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" }
  );
}

/**
 * 独立标记工单已读，不与分页消息读取耦合。
 *
 * @param ticketId 目标工单 ID。
 * @param principal 管理员更新管理员视角时间，普通用户更新本人视角时间。
 * @returns 本次写入的服务端时间。
 */
export async function markTicketSeen(
  ticketId: string,
  principal: Principal
): Promise<{ seenAt: Date }> {
  const currentUser = requireUserPrincipal(principal);
  const seenAt = new Date();
  const where = isAdminPrincipal(principal)
    ? eq(ticket.id, ticketId)
    : and(eq(ticket.id, ticketId), eq(ticket.userId, currentUser.userId));
  const rows = await db
    .update(ticket)
    .set(
      isAdminPrincipal(principal)
        ? { adminLastSeenAt: seenAt }
        : { userLastSeenAt: seenAt }
    )
    .where(where)
    .returning({ id: ticket.id });
  if (!rows[0]) {
    throw new OperationError("not_found", "Ticket not found", undefined, 404);
  }
  return { seenAt };
}
