/** 公告分页 Zod 契约与 UOL 暴露面的聚焦测试。 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./actions", () => ({
  countUnreadAnnouncementsForUser: vi.fn(),
  markAnnouncementIdsReadForUser: vi.fn(),
}));

vi.mock("./list-service", () => ({
  markAllActiveAnnouncementsReadForUser: vi.fn(),
  readAdminAnnouncementsPage: vi.fn(),
  readUserAnnouncementsPage: vi.fn(),
}));

vi.mock("../support/ticket-list-service", () => ({
  listTickets: vi.fn(),
  listTicketMessages: vi.fn(),
  markTicketSeen: vi.fn(),
}));

vi.mock("../system-settings/index", () => ({
  getRuntimeSettingJson: vi.fn(),
}));

import {
  listAdminAnnouncementPage,
  listMyAnnouncementPage,
  markAllAnnouncementsRead,
} from "../uol/operations/support";
import {
  adminAnnouncementListInputSchema,
  adminAnnouncementListOutputSchema,
  userAnnouncementListInputSchema,
} from "./list-contract";

describe("announcement list contracts", () => {
  it("uses page one and twenty rows by default", () => {
    expect(userAnnouncementListInputSchema.parse({})).toEqual({
      page: 1,
      pageSize: 20,
    });
    expect(adminAnnouncementListInputSchema.parse({})).toEqual({
      page: 1,
      pageSize: 20,
      published: "all",
    });
  });

  it("accepts only 10, 20 and 50 as page sizes", () => {
    for (const pageSize of [10, 20, 50]) {
      expect(
        userAnnouncementListInputSchema.safeParse({ pageSize }).success
      ).toBe(true);
    }
    expect(
      userAnnouncementListInputSchema.safeParse({ pageSize: 25 }).success
    ).toBe(false);
  });

  it("requires exact pagination metadata and independent admin stats", () => {
    expect(
      adminAnnouncementListOutputSchema.safeParse({
        records: [],
        page: 1,
        pageSize: 20,
        totalCount: 0,
        totalPages: 1,
        stats: { active: 0, drafts: 0, pinned: 0 },
      }).success
    ).toBe(true);
    expect(
      adminAnnouncementListOutputSchema.safeParse({
        records: [],
        page: 1,
        pageSize: 20,
        totalCount: 0,
        totalPages: 1,
      }).success
    ).toBe(false);
  });

  it("keeps both full-page operations human-only", () => {
    expect(listMyAnnouncementPage).toMatchObject({
      access: { kind: "user" },
      agentExposure: "human-only",
      readOnly: true,
    });
    expect(listAdminAnnouncementPage).toMatchObject({
      access: { kind: "admin" },
      agentExposure: "human-only",
      readOnly: true,
    });
    expect(markAllAnnouncementsRead).toMatchObject({
      access: { kind: "user" },
      agentExposure: "human-only",
      readOnly: false,
    });
  });
});
