import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL ??=
    "postgresql://unit-test:unit-test@127.0.0.1:5432/unit-test";
  return { requestGoJson: vi.fn() };
});
vi.mock("@/server/go-backend-client", () => ({
  requestGoJson: mocks.requestGoJson,
}));

import { invokeOperation } from "@repo/shared/uol";
import "@repo/shared/uol/operations";
import "./support";

describe("support Go bindings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requestGoJson.mockImplementation(async (path: string) => {
      if (path.includes("/seen")) return { seenAt: "2026-09-13T00:00:00.000Z" };
      return {
        items: [
          {
            id: "ticket-1",
            userId: "user-1",
            subject: "Issue",
            category: "bug",
            priority: "medium",
            status: "open",
            unread: true,
            createdAt: "2026-09-13T00:00:00.000Z",
            updatedAt: "2026-09-13T00:00:00.000Z",
            userName: "User",
            userEmail: "u***@example.test",
          },
        ],
        page: 1,
        pageSize: 20,
        total: 1,
        totalPages: 1,
      };
    });
  });

  it("routes user ticket list and seen writes to Go", async () => {
    const principal = { type: "user" as const, userId: "user-1", role: "user" as const };
    await expect(
      invokeOperation("support.getMyTickets", { page: 1, pageSize: 20, status: "all", search: "" }, principal)
    ).resolves.toMatchObject({ totalCount: 1 });
    await expect(
      invokeOperation("support.markMyTicketSeen", { ticketId: "ticket-1" }, principal)
    ).resolves.toMatchObject({ seenAt: new Date("2026-09-13T00:00:00.000Z") });
    expect(mocks.requestGoJson).toHaveBeenNthCalledWith(1, expect.stringContaining("/api/support/tickets?"));
    expect(mocks.requestGoJson).toHaveBeenNthCalledWith(
      2,
      "/api/support/tickets/ticket-1/seen",
      { method: "POST", body: "{}" }
    );
  });

  it("rejects non-user principals before contacting Go", async () => {
    await expect(
      invokeOperation("support.getMyUnreadCount", {}, { type: "system", reason: "test" })
    ).rejects.toMatchObject({ code: "unauthenticated" });
    expect(mocks.requestGoJson).not.toHaveBeenCalled();
  });
});
