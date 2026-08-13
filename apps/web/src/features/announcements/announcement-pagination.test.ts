/** 公告 URL 分页与筛选契约的聚焦测试。 */
import { describe, expect, it } from "vitest";

import {
  buildAdminAnnouncementHref,
  buildAnnouncementHref,
  parseAdminAnnouncementQuery,
  parseAnnouncementPagination,
} from "./announcement-pagination";

describe("announcement pagination URL", () => {
  it("parses valid state and falls back from repeated or unsupported values", () => {
    expect(parseAnnouncementPagination({ page: "3", pageSize: "50" })).toEqual({
      page: 3,
      pageSize: 50,
    });
    expect(
      parseAnnouncementPagination({ page: ["3"], pageSize: "25" })
    ).toEqual({ page: 1, pageSize: 20 });
  });

  it("parses only the published filter allowlist", () => {
    expect(
      parseAdminAnnouncementQuery({
        page: "2",
        pageSize: "10",
        published: "unpublished",
      })
    ).toEqual({ page: 2, pageSize: 10, published: "unpublished" });
    expect(parseAdminAnnouncementQuery({ published: "deleted" })).toEqual({
      page: 1,
      pageSize: 20,
      published: "all",
    });
  });

  it("omits defaults and preserves the admin published filter", () => {
    expect(buildAnnouncementHref({ page: 1, pageSize: 20 })).toBe(
      "/dashboard/announcements"
    );
    expect(buildAnnouncementHref({ page: 4, pageSize: 50 })).toBe(
      "/dashboard/announcements?page=4&pageSize=50"
    );
    expect(
      buildAdminAnnouncementHref({
        page: 1,
        pageSize: 10,
        published: "published",
      })
    ).toBe("/dashboard/admin/announcements?pageSize=10&published=published");
  });
});
