/**
 * 客服工单分页 UOL 的 DB-free 契约测试。
 *
 * 职责：锁定真实状态枚举、10/20/50 页大小、严格 DTO、人工会话权限、
 * human-only 暴露，以及消息读取与已读写入分离。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../announcements/actions", () => ({
  countUnreadAnnouncementsForUser: vi.fn(),
  listActiveAnnouncementsForUser: vi.fn(),
  listAnnouncementsForAdmin: vi.fn(),
  markAnnouncementIdsReadForUser: vi.fn(),
}));

vi.mock("../../announcements/list-service", () => ({
  markAllActiveAnnouncementsReadForUser: vi.fn(),
  readAdminAnnouncementsPage: vi.fn(),
  readUserAnnouncementsPage: vi.fn(),
}));

vi.mock("../../support/ticket-list-service", () => ({
  listTickets: vi.fn(),
  listTicketMessages: vi.fn(),
  markTicketSeen: vi.fn(),
}));

vi.mock("../../system-settings/index", () => ({
  getRuntimeSettingJson: vi.fn(),
}));

import {
  getAdminTicketDetail,
  getAllTickets,
  getMyTickets,
  getTicketDetail,
  markAdminTicketSeen,
  markMyTicketSeen,
  updateTicketStatus,
} from "./support";

const listOutput = {
  records: [
    {
      id: "ticket-1",
      userId: "user-1",
      subject: "Subject",
      category: "technical",
      priority: "medium",
      status: "in_progress",
      unread: true,
      createdAt: new Date("2026-08-12T10:00:00.000Z"),
      updatedAt: new Date("2026-08-12T11:00:00.000Z"),
      userName: "User",
      userEmail: "user@example.com",
    },
  ],
  page: 2,
  pageSize: 20,
  totalCount: 21,
  totalPages: 2,
};

describe("support ticket list operation contracts", () => {
  it("declares list reads as human-only and uses the settled status enum", () => {
    for (const operation of [getMyTickets, getAllTickets]) {
      expect(operation).toMatchObject({
        agentExposure: "human-only",
        readOnly: true,
        destructive: false,
        idempotency: { kind: "natural" },
        sideEffects: [],
      });
      expect(
        operation.input.safeParse({
          page: 1,
          pageSize: 20,
          status: "in_progress",
          search: "subject",
        }).success
      ).toBe(true);
      expect(
        operation.input.safeParse({
          page: 1,
          pageSize: 25,
          status: "pending",
        }).success
      ).toBe(false);
    }
    expect(getMyTickets.access).toEqual({ kind: "user" });
    expect(getAllTickets.access).toEqual({ kind: "admin" });
  });

  it("accepts the strict offset envelope and rejects legacy fields", () => {
    expect(getMyTickets.output.safeParse(listOutput).success).toBe(true);
    expect(
      getMyTickets.output.safeParse({
        tickets: listOutput.records,
        total: listOutput.totalCount,
      }).success
    ).toBe(false);
  });
});

describe("support ticket message and seen operation contracts", () => {
  it("keeps message reads pure and seen writes independent", () => {
    for (const operation of [getTicketDetail, getAdminTicketDetail]) {
      expect(operation).toMatchObject({
        agentExposure: "human-only",
        readOnly: true,
        sideEffects: [],
      });
      expect(operation.hasMaintenanceWrite).toBeUndefined();
      expect(
        operation.input.safeParse({
          ticketId: "ticket-1",
          page: 3,
          pageSize: 50,
        }).success
      ).toBe(true);
    }
    for (const operation of [markMyTicketSeen, markAdminTicketSeen]) {
      expect(operation).toMatchObject({
        agentExposure: "human-only",
        readOnly: false,
        destructive: false,
        idempotency: { kind: "natural" },
      });
      expect(operation.input.safeParse({ ticketId: "ticket-1" }).success).toBe(
        true
      );
    }
  });

  it("uses the database ticket status enum for status updates", () => {
    for (const status of ["open", "in_progress", "resolved", "closed"]) {
      expect(
        updateTicketStatus.input.safeParse({ ticketId: "ticket-1", status })
          .success
      ).toBe(true);
    }
    expect(
      updateTicketStatus.input.safeParse({
        ticketId: "ticket-1",
        status: "pending",
      }).success
    ).toBe(false);
  });
});
