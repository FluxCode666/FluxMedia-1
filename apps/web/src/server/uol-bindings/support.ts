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

type TicketListItemResponse = Record<string, unknown> & {
  createdAt: string;
  updatedAt: string;
};

type TicketListResponse = {
  items?: TicketListItemResponse[];
  records?: TicketListItemResponse[];
  page: number;
  pageSize: number;
  total?: number;
  totalCount?: number;
  totalPages?: number;
};

type TicketMessageResponse = Record<string, unknown> & { createdAt: string };
type TicketDetailResponse = Record<string, unknown> & {
  userLastSeenAt: string;
  lastAdminActivityAt?: string | null;
  adminLastSeenAt?: string | null;
  lastUserActivityAt?: string | null;
  createdAt: string;
  updatedAt: string;
};
type TicketMessagesPageResponse = {
  items?: TicketMessageResponse[];
  records?: TicketMessageResponse[];
  page?: number;
  pageSize?: number;
  total?: number;
  totalCount?: number;
  totalPages?: number;
};
type TicketDetailEnvelope = {
  ticket: TicketDetailResponse;
  ticketUser?: unknown;
  messages?: TicketMessagesPageResponse;
};

const userOnly = (principal: { type: string }) => {
  if (principal.type !== "user") {
    throw new OperationError("unauthenticated", "User session authentication required");
  }
};
const adminOnly = (principal: { type: string; role?: string }) => {
  if (
    principal.type !== "user" ||
    (principal.role !== "admin" && principal.role !== "super_admin")
  ) {
    throw new OperationError("forbidden", "Admin access required");
  }
};

const listTicketsFromGo = async (input: unknown) => {
  const parsedInput = ticketListInputSchema.parse(input);
  const q = new URLSearchParams({
    page: String(parsedInput.page),
    pageSize: String(parsedInput.pageSize),
    status: parsedInput.status,
    search: parsedInput.search,
  });
  const raw = await requestGoJson<TicketListResponse>(
    `/api/support/tickets?${q}`
  );
  return ticketListOutputSchema.parse({
    records: (raw.items ?? raw.records ?? []).map((item) => ({
      ...item,
      createdAt: new Date(item.createdAt),
      updatedAt: new Date(item.updatedAt),
    })),
    page: raw.page,
    pageSize: raw.pageSize,
    totalCount: raw.total ?? raw.totalCount ?? 0,
    totalPages: raw.totalPages ?? 1,
  });
};

bindExecute("support.getMyTickets", async (input, principal) => {
  userOnly(principal);
  return listTicketsFromGo(input);
});

bindExecute("support.getAllTickets", async (input, principal) => {
  adminOnly(principal);
  return listTicketsFromGo(input);
});

bindExecute("support.getTicketDetail", async (input, principal) => {
  userOnly(principal);
  const parsedInput = ticketMessageListInputSchema.parse(input);
  const q = new URLSearchParams({
    page: String(parsedInput.page),
    pageSize: String(parsedInput.pageSize),
  });
  const raw = await requestGoJson<TicketDetailEnvelope>(
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
      records: (messages.items ?? messages.records ?? []).map((item) => ({
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

bindExecute("support.markAdminTicketSeen", async (input, principal) => {
  adminOnly(principal);
  const parsedInput = markTicketSeenInputSchema.parse(input);
  const raw = await requestGoJson<{ seenAt: string }>(
    `/api/support/tickets/${encodeURIComponent(parsedInput.ticketId)}/seen`,
    { method: "POST", body: "{}" }
  );
  return { seenAt: new Date(raw.seenAt) };
});

bindExecute("support.getAdminTicketDetail", async (input, principal) => {
  adminOnly(principal);
  const parsedInput = ticketMessageListInputSchema.parse(input);
  const q = new URLSearchParams({
    page: String(parsedInput.page),
    pageSize: String(parsedInput.pageSize),
  });
  const raw = await requestGoJson<TicketDetailEnvelope>(
    `/api/support/tickets/${encodeURIComponent(parsedInput.ticketId)}/messages?${q}`
  );
  const ticket = raw.ticket;
  const messages = raw.messages ?? {};
  return ticketMessageListOutputSchema.parse({
    ticket: {
      ...ticket,
      userLastSeenAt: new Date(ticket.userLastSeenAt),
      lastAdminActivityAt: ticket.lastAdminActivityAt ? new Date(ticket.lastAdminActivityAt) : null,
      adminLastSeenAt: ticket.adminLastSeenAt ? new Date(ticket.adminLastSeenAt) : null,
      lastUserActivityAt: ticket.lastUserActivityAt ? new Date(ticket.lastUserActivityAt) : null,
      createdAt: new Date(ticket.createdAt),
      updatedAt: new Date(ticket.updatedAt),
    },
    ticketUser: raw.ticketUser ?? null,
    messages: {
      records: (messages.items ?? messages.records ?? []).map((item) => ({ ...item, createdAt: new Date(item.createdAt) })),
      page: messages.page ?? parsedInput.page,
      pageSize: messages.pageSize ?? parsedInput.pageSize,
      totalCount: messages.total ?? messages.totalCount ?? 0,
      totalPages: messages.totalPages ?? 1,
    },
  });
});

bindExecute("support.getMyUnreadCount", async (_input, principal) => {
  userOnly(principal);
  return requestGoJson<{ count: number }>("/api/support/tickets/unread-count");
});

bindExecute("support.getAdminUnreadCount", async (_input, principal) => {
  adminOnly(principal);
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

bindExecute("support.adminReply", async (input, principal) => {
  adminOnly(principal);
  const parsed = input as { ticketId: string; message: string };
  return requestGoJson<{ messageId: string; createdAt: string }>(
    `/api/support/tickets/${encodeURIComponent(parsed.ticketId)}/messages`,
    { method: "POST", body: JSON.stringify({ content: parsed.message }) }
  );
});

bindExecute("support.updateTicketStatus", async (input, principal) => {
  adminOnly(principal);
  const parsed = input as { ticketId: string; status: string };
  return requestGoJson<{ ticketId: string; status: string; updatedAt: string }>(
    `/api/support/tickets/${encodeURIComponent(parsed.ticketId)}/status`,
    { method: "PATCH", body: JSON.stringify({ status: parsed.status }) }
  );
});
