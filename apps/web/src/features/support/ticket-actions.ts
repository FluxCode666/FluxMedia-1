"use server";

/**
 * 客服工单分页的 Server Action 薄适配器。
 *
 * 使用方：工单列表与详情 Server Components。这里只获取人工会话角色、构造
 * Principal 并调用 UOL；查询、归属、计数与已读写入都留在统一接口层。
 */
import { protectedAction } from "@repo/shared/safe-action";
import {
  type MarkTicketSeenOutput,
  markTicketSeenInputSchema,
  type TicketListOutput,
  type TicketMessageListOutput,
  ticketListInputSchema,
  ticketMessageListInputSchema,
} from "@repo/shared/support/ticket-list-contract";
import { requestGoJson } from "@/server/go-backend-client";

/** 分页读取当前人工会话可见的工单。 */
export const listTicketsAction = protectedAction
  .metadata({ action: "support.listTickets" })
  .schema(ticketListInputSchema)
  .action(async ({ parsedInput }): Promise<TicketListOutput> => {
    const q = new URLSearchParams({ page: String(parsedInput.page), pageSize: String(parsedInput.pageSize), status: parsedInput.status, search: parsedInput.search });
    const raw = await requestGoJson<{ items: TicketListOutput["records"]; page: number; pageSize: number; total: number; totalPages: number }>(`/api/support/tickets?${q}`);
    return { records: raw.items ?? [], page: raw.page, pageSize: raw.pageSize, totalCount: raw.total ?? 0, totalPages: raw.totalPages ?? 1 };
  });

/** 分页读取当前会话可见的工单详情与消息历史。 */
export const listTicketMessagesAction = protectedAction
  .metadata({ action: "support.listTicketMessages" })
  .schema(ticketMessageListInputSchema)
  .action(async ({ parsedInput }): Promise<TicketMessageListOutput> => {
    const q = new URLSearchParams({ page: String(parsedInput.page), pageSize: String(parsedInput.pageSize) });
    const raw = await requestGoJson<{ ticket: TicketMessageListOutput["ticket"]; ticketUser?: TicketMessageListOutput["ticketUser"]; messages: { items: TicketMessageListOutput["messages"]["records"]; page?: number; pageSize?: number; total?: number; totalPages?: number } }>(`/api/support/tickets/${encodeURIComponent(parsedInput.ticketId)}/messages?${q}`);
    const msg = raw.messages;
    return { ticket: raw.ticket, ticketUser: raw.ticketUser ?? null, messages: { records: msg.items ?? [], page: msg.page ?? parsedInput.page, pageSize: msg.pageSize ?? parsedInput.pageSize, totalCount: msg.total ?? (msg.items?.length ?? 0), totalPages: msg.totalPages ?? 1 } };
  });

/** 独立标记当前会话视角下的工单已读。 */
export const markTicketSeenAction = protectedAction
  .metadata({ action: "support.markTicketSeen" })
  .schema(markTicketSeenInputSchema)
  .action(async ({ parsedInput }): Promise<MarkTicketSeenOutput> => {
    return requestGoJson<MarkTicketSeenOutput>(`/api/support/tickets/${encodeURIComponent(parsedInput.ticketId)}/seen`, { method: "POST", body: "{}" });
  });
