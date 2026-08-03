/**
 * 供应商账号身份快照测试。
 *
 * 使用方：apps/web Vitest。覆盖名称规范化与缺失 ID 的失败关闭，防止凭据或不完整
 * 身份进入历史任务元数据。
 */

import { describe, expect, it } from "vitest";
import { buildBackendAccountSnapshot } from "./backend-account-snapshot";

describe("buildBackendAccountSnapshot", () => {
  it("keeps only the normalized supplier account name and ID", () => {
    expect(
      buildBackendAccountSnapshot({
        id: " backend-1 ",
        name: " Primary supplier ",
      })
    ).toEqual({ id: "backend-1", name: "Primary supplier" });
  });

  it("returns null without a stable account ID", () => {
    expect(buildBackendAccountSnapshot({ name: "Supplier" })).toBeNull();
  });
});
