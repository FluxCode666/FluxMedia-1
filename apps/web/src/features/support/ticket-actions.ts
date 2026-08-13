"use server";

/**
 * 客服工单分页的 Server Action 薄适配器。
 *
 * 使用方：工单列表与详情 Server Components。这里只获取人工会话角色、构造
 * Principal 并调用 UOL；查询、归属、计数与已读写入都留在统一接口层。
 */
import { getUserRoleById } from "@repo/shared/auth/role-server";
import { protectedAction } from "@repo/shared/safe-action";
import {
  type MarkTicketSeenOutput,
  markTicketSeenInputSchema,
  type TicketListOutput,
  type TicketMessageListOutput,
  ticketListInputSchema,
  ticketMessageListInputSchema,
} from "@repo/shared/support/ticket-list-contract";
import { invokeOperation } from "@repo/shared/uol";

import { ensureUolInitialized } from "@/server/uol-init";

/** 分页读取当前人工会话可见的工单。 */
export const listTicketsAction = protectedAction
  .metadata({ action: "support.listTickets" })
  .schema(ticketListInputSchema)
  .action(async ({ parsedInput, ctx }): Promise<TicketListOutput> => {
    await ensureUolInitialized();
    const role = await getUserRoleById(ctx.userId);
    const operationName =
      role === "admin" || role === "super_admin"
        ? "support.getAllTickets"
        : "support.getMyTickets";
    return invokeOperation<TicketListOutput>(operationName, parsedInput, {
      type: "user",
      userId: ctx.userId,
      role,
    });
  });

/** 分页读取当前会话可见的工单详情与消息历史。 */
export const listTicketMessagesAction = protectedAction
  .metadata({ action: "support.listTicketMessages" })
  .schema(ticketMessageListInputSchema)
  .action(async ({ parsedInput, ctx }): Promise<TicketMessageListOutput> => {
    await ensureUolInitialized();
    const role = await getUserRoleById(ctx.userId);
    const operationName =
      role === "admin" || role === "super_admin"
        ? "support.getAdminTicketDetail"
        : "support.getTicketDetail";
    return invokeOperation<TicketMessageListOutput>(
      operationName,
      parsedInput,
      { type: "user", userId: ctx.userId, role }
    );
  });

/** 独立标记当前会话视角下的工单已读。 */
export const markTicketSeenAction = protectedAction
  .metadata({ action: "support.markTicketSeen" })
  .schema(markTicketSeenInputSchema)
  .action(async ({ parsedInput, ctx }): Promise<MarkTicketSeenOutput> => {
    await ensureUolInitialized();
    const role = await getUserRoleById(ctx.userId);
    const operationName =
      role === "admin" || role === "super_admin"
        ? "support.markAdminTicketSeen"
        : "support.markMyTicketSeen";
    return invokeOperation<MarkTicketSeenOutput>(operationName, parsedInput, {
      type: "user",
      userId: ctx.userId,
      role,
    });
  });
