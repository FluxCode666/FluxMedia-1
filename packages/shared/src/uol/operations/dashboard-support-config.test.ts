/**
 * 控制台支持配置 UOL operation 的权限、元数据与安全降级测试。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DASHBOARD_SUPPORT_CONFIG,
  dashboardSupportConfigSchema,
} from "../../support/dashboard-config";
import { getRuntimeSettingJson } from "../../system-settings/index";
import type { OperationContext } from "../types";

vi.mock("../../system-settings/index", () => ({
  getRuntimeSettingJson: vi.fn(),
}));

vi.mock("../../logger", () => ({
  logError: vi.fn(),
}));

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

import { getDashboardConfiguration } from "./support";

const context: OperationContext = {
  requestId: "dashboard-support-test",
  assertOwnership: () => undefined,
};

describe("support.getDashboardConfiguration", () => {
  beforeEach(() => {
    vi.mocked(getRuntimeSettingJson).mockReset();
  });

  it("declares a user-only, read-only and non-destructive operation", () => {
    expect(getDashboardConfiguration.access).toEqual({ kind: "user" });
    expect(getDashboardConfiguration.readOnly).toBe(true);
    expect(getDashboardConfiguration.destructive).toBe(false);
    expect(getDashboardConfiguration.sideEffects).toEqual([]);
  });

  it("returns only the validated dashboard support contract", async () => {
    const configured = structuredClone(DEFAULT_DASHBOARD_SUPPORT_CONFIG);
    configured.services = [];
    vi.mocked(getRuntimeSettingJson).mockResolvedValue(configured);

    const output = await getDashboardConfiguration.execute(
      {},
      { type: "user", userId: "user-1", role: "user" },
      context
    );

    expect(dashboardSupportConfigSchema.parse(output)).toEqual(configured);
  });

  it("falls back when a historical stored value is invalid", async () => {
    vi.mocked(getRuntimeSettingJson).mockResolvedValue({ version: 2 });

    await expect(
      getDashboardConfiguration.execute(
        {},
        { type: "user", userId: "user-1", role: "user" },
        context
      )
    ).resolves.toEqual(DEFAULT_DASHBOARD_SUPPORT_CONFIG);
  });

  it("falls back when an environment JSON value cannot be read", async () => {
    vi.mocked(getRuntimeSettingJson).mockRejectedValue(
      new Error("invalid environment JSON")
    );

    await expect(
      getDashboardConfiguration.execute(
        {},
        { type: "user", userId: "user-1", role: "user" },
        context
      )
    ).resolves.toEqual(DEFAULT_DASHBOARD_SUPPORT_CONFIG);
  });
});
