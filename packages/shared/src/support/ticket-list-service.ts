/** Go/PostgreSQL adapter for support ticket reads and seen markers. */
import { requestGoBackendJson } from "../http/go-backend";
import type { Principal } from "../uol/principal";
import type {
  MarkTicketSeenOutput,
  TicketListInput,
  TicketListOutput,
  TicketMessageListInput,
  TicketMessageListOutput,
} from "./ticket-list-contract";

/** Go authenticates the forwarded Better Auth cookie and applies ownership and role checks. */
export async function listTickets(input: TicketListInput, _principal: Principal): Promise<TicketListOutput> {
  const query = new URLSearchParams({ page: String(input.page), pageSize: String(input.pageSize), status: input.status, search: input.search });
  const payload = await requestGoBackendJson<TicketListOutput & { items?: TicketListOutput["records"]; total?: number }>(`/api/support/tickets?${query.toString()}`);
  return { records: payload.records ?? payload.items ?? [], page: payload.page, pageSize: payload.pageSize, totalCount: payload.totalCount ?? payload.total ?? 0, totalPages: payload.totalPages };
}

export async function listTicketMessages(input: TicketMessageListInput, _principal: Principal): Promise<TicketMessageListOutput> {
  const query = new URLSearchParams({ page: String(input.page), pageSize: String(input.pageSize) });
  const payload = await requestGoBackendJson<TicketMessageListOutput & { messages: TicketMessageListOutput["messages"] & { items?: TicketMessageListOutput["messages"]["records"]; total?: number } }>(`/api/support/tickets/${encodeURIComponent(input.ticketId)}/messages?${query.toString()}`);
  const messages = payload.messages;
  return { ticket: payload.ticket, ticketUser: payload.ticketUser ?? null, messages: { records: messages.records ?? messages.items ?? [], page: messages.page, pageSize: messages.pageSize, totalCount: messages.totalCount ?? messages.total ?? 0, totalPages: messages.totalPages } };
}

export async function markTicketSeen(ticketId: string, _principal: Principal): Promise<MarkTicketSeenOutput> {
  return requestGoBackendJson<MarkTicketSeenOutput>(`/api/support/tickets/${encodeURIComponent(ticketId)}/seen`, { method: "POST", body: "{}" });
}
