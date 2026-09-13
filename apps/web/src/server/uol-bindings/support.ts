/** User support ticket UOL bindings backed by the Go support API. */
import {
  markTicketSeenInputSchema,
  ticketListInputSchema,
  ticketMessageListInputSchema,
  ticketListOutputSchema,
  ticketMessageListOutputSchema,
} from "@repo/shared/support/ticket-list-contract";
import { bindExecute, OperationError } from "@repo/shared/uol";
import { requestGoJson } from "@/server/go-backend-client";

const userOnly = (principal: { type: string }) => {
  if (principal.type !== "user") {
    throw new OperationError("unauthenticated", "User session authentication required");
  }
};

bindExecute("support.getMyTickets", async (input, principal) => {
  userOnly(principal);
  const parsedInput = ticketListInputSchema.parse(input);
  const q = new URLSearchParams({
    page: String(parsedInput.page),
    pageSize: String(parsedInput.pageSize),
    status: parsedInput.status,
    search: parsedInput.search,
  });
  const raw = await requestGoJson<any>(`/api/support/tickets?${q}`);
  return ticketListOutputSchema.parse({
    records: (raw.items ?? raw.records ?? []).map((item: any) => ({
      ...item,
      createdAt: new Date(item.createdAt),
      updatedAt: new Date(item.updatedAt),
    })),
    page: raw.page,
    pageSize: raw.pageSize,
    totalCount: raw.total ?? raw.totalCount ?? 0,
    totalPages: raw.totalPages ?? 1,
  });
});

bindExecute("support.getTicketDetail", async (input, principal) => {
  userOnly(principal);
  const parsedInput = ticketMessageListInputSchema.parse(input);
  const q = new URLSearchParams({
    page: String(parsedInput.page),
    pageSize: String(parsedInput.pageSize),
  });
  const raw = await requestGoJson<any>(
    `/api/support/tickets/${encodeURIComponent(parsedInput.ticketId)}/messages?${q}`
  );
  const ticket = raw.ticket;
  const messages = raw.messages ?? {};
  return ticketMessageListOutputSchema.parse({
    ticket: {
      ...ticket,
      userLastSeenAt: new Date(ticket.userLastSeenAt),
      lastAdminActivityAt: ticket.lastAdminActivityAt
        ? new Date(ticket.lastAdminActivityAt)
        : null,
      adminLastSeenAt: ticket.adminLastSeenAt
        ? new Date(ticket.adminLastSeenAt)
        : null,
      lastUserActivityAt: ticket.lastUserActivityAt
        ? new Date(ticket.lastUserActivityAt)
        : null,
      createdAt: new Date(ticket.createdAt),
      updatedAt: new Date(ticket.updatedAt),
    },
    ticketUser: raw.ticketUser ?? null,
    messages: {
      records: (messages.items ?? messages.records ?? []).map((item: any) => ({
        ...item,
        createdAt: new Date(item.createdAt),
      })),
      page: messages.page ?? parsedInput.page,
      pageSize: messages.pageSize ?? parsedInput.pageSize,
      totalCount: messages.total ?? messages.totalCount ?? 0,
      totalPages: messages.totalPages ?? 1,
    },
  });
});

bindExecute("support.markMyTicketSeen", async (input, principal) => {
  userOnly(principal);
  const parsedInput = markTicketSeenInputSchema.parse(input);
  const raw = await requestGoJson<{ seenAt: string }>(
    `/api/support/tickets/${encodeURIComponent(parsedInput.ticketId)}/seen`,
    { method: "POST", body: "{}" }
  );
  return { seenAt: new Date(raw.seenAt) };
});

bindExecute("support.getMyUnreadCount", async (_input, principal) => {
  userOnly(principal);
  return requestGoJson<{ count: number }>("/api/support/tickets/unread-count");
});

bindExecute("support.createTicket", async (input, principal) => {
  userOnly(principal);
  const parsed = input as {
    subject: string;
    message: string;
    category?: "bug" | "feature" | "billing" | "account" | "other";
  };
  return requestGoJson<{ ticketId: string; createdAt: string }>(
    "/api/support/tickets",
    {
      method: "POST",
      body: JSON.stringify({
        subject: parsed.subject,
        message: parsed.message,
        category: parsed.category,
      }),
    }
  );
});

bindExecute("support.addMessage", async (input, principal) => {
  userOnly(principal);
  const parsed = input as { ticketId: string; message: string };
  return requestGoJson<{ messageId: string; createdAt: string }>(
    `/api/support/tickets/${encodeURIComponent(parsed.ticketId)}/messages`,
    {
      method: "POST",
      body: JSON.stringify({ content: parsed.message }),
    }
  );
});
