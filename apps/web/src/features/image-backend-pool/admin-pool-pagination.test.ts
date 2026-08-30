/**
 * 账号池成员与分组 URL 分页状态测试。
 *
 * 职责：锁定两个 namespace、严格筛选恢复、页大小白名单和重复参数回退；不加载
 * React、数据库或 Server Action。
 */
import { parsePaginationConfig } from "@repo/shared/pagination/config";
import { describe, expect, it } from "vitest";

import {
  ADMIN_POOL_GROUP_PAGINATION_NAMES,
  ADMIN_POOL_MEMBER_PAGINATION_NAMES,
  parseAdminPoolGroupListInput,
  parseAdminPoolMemberListInput,
} from "./admin-pool-pagination";

const paginationConfig = parsePaginationConfig([10, 20, 50]);

describe("admin pool pagination", () => {
  it("成员与分组使用互不覆盖的 URL namespace", () => {
    expect(ADMIN_POOL_MEMBER_PAGINATION_NAMES).toMatchObject({
      page: "memberPage",
      pageSize: "memberPageSize",
    });
    expect(ADMIN_POOL_GROUP_PAGINATION_NAMES).toMatchObject({
      page: "groupPage",
      pageSize: "groupPageSize",
    });
  });

  it("恢复成员分页、凭据、模型、分辨率和日期筛选", () => {
    const input = parseAdminPoolMemberListInput(
      new URLSearchParams(
        "memberPage=3&memberPageSize=50&memberName=API&memberCredential=not_applicable&memberModel=gpt-image-2&memberResolution=2k&memberCreatedFrom=2026-08-01&memberCreatedTo=2026-08-13"
      ),
      paginationConfig,
      "Asia/Shanghai"
    );
    expect(input).toEqual({
      page: 3,
      pageSize: 50,
      name: "API",
      credentialStatus: "not_applicable",
      modelId: "gpt-image-2",
      resolution: "2k",
      createdFrom: "2026-08-01",
      createdTo: "2026-08-13",
      timeZone: "Asia/Shanghai",
    });
  });

  it("非法或重复参数回退安全默认值", () => {
    const input = parseAdminPoolMemberListInput(
      new URLSearchParams(
        "memberPage=2&memberPage=4&memberPageSize=30&memberCredential=secret&memberCreatedFrom=tomorrow"
      ),
      paginationConfig,
      "UTC"
    );
    expect(input).toMatchObject({
      page: 1,
      pageSize: 20,
      credentialStatus: "all",
      createdFrom: "",
    });
  });

  it("独立解析分组页码、页大小与名称", () => {
    expect(
      parseAdminPoolGroupListInput(
        new URLSearchParams(
          "memberPage=9&groupPage=2&groupPageSize=10&groupName=主分组"
        ),
        paginationConfig
      )
    ).toEqual({ page: 2, pageSize: 10, name: "主分组" });
  });
});
