/**
 * 历史记录 URL 状态纯函数测试。
 *
 * 覆盖不可信参数收窄、筛选序列化和双向签名 cursor 导航。
 */

import { describe, expect, it } from "vitest";

import {
  buildHistoryHref,
  buildNextHistoryHref,
  buildPreviousHistoryHref,
  hasActiveHistoryFilters,
  parseHistorySearchParams,
} from "./history-query";

describe("history query", () => {
  it("解析公开筛选并忽略非法枚举和日期", () => {
    expect(
      parseHistorySearchParams({
        createdFrom: "2026-07-01",
        createdTo: "2026-02-30",
        cursor: "signed-cursor",
        model: "  gpt-image-2  ",
        status: "completed",
        type: "audio",
      })
    ).toEqual({
      createdFrom: "2026-07-01",
      createdTo: null,
      cursor: "signed-cursor",
      model: "gpt-image-2",
      status: "completed",
      type: null,
      userEmail: null,
    });
  });

  it("数组标量和超长 cursor 不进入查询状态", () => {
    expect(
      parseHistorySearchParams({
        cursor: "x".repeat(4097),
        model: ["a", "b"],
        status: ["failed"],
      })
    ).toMatchObject({ cursor: null, model: null, status: null });
  });

  it("个人历史路径忽略用户邮箱参数", () => {
    expect(
      parseHistorySearchParams({ userEmail: "member@example.com" }).userEmail
    ).toBeNull();
  });

  it("构造不带 locale 的筛选 URL", () => {
    expect(
      buildHistoryHref({
        createdFrom: "2026-07-01",
        createdTo: "2026-07-22",
        cursor: null,
        model: "firefly-image-4",
        status: "failed",
        type: "image",
        userEmail: null,
      })
    ).toBe(
      "/dashboard/history?createdFrom=2026-07-01&createdTo=2026-07-22&model=firefly-image-4&status=failed&type=image"
    );
  });

  it("下一页和上一页只替换当前签名 cursor", () => {
    const firstPage = parseHistorySearchParams({ type: "video" });
    const nextHref = buildNextHistoryHref(firstPage, "next+/=cursor");
    expect(nextHref).toBe(
      "/dashboard/history?type=video&cursor=next%2B%2F%3Dcursor"
    );

    const secondPage = parseHistorySearchParams({
      cursor: "next+/=cursor",
      type: "video",
    });
    expect(buildPreviousHistoryHref(secondPage, "previous-cursor")).toBe(
      "/dashboard/history?type=video&cursor=previous-cursor"
    );
  });

  it("只把业务筛选视为活动状态", () => {
    const cursorOnly = parseHistorySearchParams({ cursor: "signed" });
    expect(hasActiveHistoryFilters(cursorOnly)).toBe(false);
    expect(
      hasActiveHistoryFilters({ ...cursorOnly, status: "processing" })
    ).toBe(true);
  });

  it("解析图片 processing 与视频 queued/in_progress 筛选", () => {
    expect(parseHistorySearchParams({ status: "processing" }).status).toBe(
      "processing"
    );
    expect(parseHistorySearchParams({ status: "queued" }).status).toBe(
      "queued"
    );
    expect(parseHistorySearchParams({ status: "in_progress" }).status).toBe(
      "in_progress"
    );
  });

  it("为管理端保留用户邮箱筛选并使用指定路由", () => {
    const state = parseHistorySearchParams(
      {
        userEmail: "member@example.com",
        type: "image",
      },
      { allowUserEmail: true }
    );
    expect(buildHistoryHref(state, { path: "/dashboard/admin/history" })).toBe(
      "/dashboard/admin/history?type=image&userEmail=member%40example.com"
    );
    expect(hasActiveHistoryFilters(state)).toBe(true);
  });
});
