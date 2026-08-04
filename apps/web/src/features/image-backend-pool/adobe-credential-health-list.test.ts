/**
 * 账号池凭据健康状态批量映射测试。
 *
 * 职责：锁定严格数据库结果校验、缺失摘要回退和动态失约计算；不连接数据库。
 */
import { describe, expect, it } from "vitest";

import { mapAdobeCredentialHealthStatusRows } from "./adobe-credential-health-list";

const NOW = new Date("2026-08-04T01:00:00.000Z");

/** 构造一条完整且默认健康的数据库投影。 */
function createRow(overrides: Record<string, unknown> = {}) {
  return {
    member_id: "member-a",
    status: "healthy",
    failure_profiles: [],
    last_check_at: "2026-08-04T00:45:00.000Z",
    last_success_at: "2026-08-04T00:45:00.000Z",
    next_check_at: "2026-08-04T01:30:00.000Z",
    ...overrides,
  };
}

describe("Adobe credential health status list", () => {
  it("映射真实状态并把超过检查窗口的健康摘要标为失约", () => {
    expect(
      mapAdobeCredentialHealthStatusRows(
        [
          createRow(),
          createRow({
            member_id: "member-overdue",
            next_check_at: "2026-08-04T00:54:59.999Z",
          }),
          createRow({
            member_id: "member-isolated",
            status: "isolated",
            next_check_at: "2026-08-03T00:00:00.000Z",
          }),
        ],
        NOW
      )
    ).toEqual([
      { memberId: "member-a", status: "healthy" },
      { memberId: "member-overdue", status: "overdue" },
      { memberId: "member-isolated", status: "isolated" },
    ]);
  });

  it("缺少健康行的 Adobe Direct 成员回退为待首次检查", () => {
    expect(
      mapAdobeCredentialHealthStatusRows(
        [
          createRow({
            status: null,
            failure_profiles: null,
            last_check_at: null,
            last_success_at: null,
            next_check_at: null,
          }),
        ],
        NOW
      )
    ).toEqual([{ memberId: "member-a", status: "pending" }]);
  });

  it("拒绝数据库返回未知凭据健康状态", () => {
    expect(() =>
      mapAdobeCredentialHealthStatusRows(
        [createRow({ status: "unhealthy" })],
        NOW
      )
    ).toThrow();
  });
});
