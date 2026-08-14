/**
 * 运营总览 Server Action 安全错误映射测试。
 *
 * 使用方：Vitest。锁定客户端允许识别的白名单错误码，并确保未知内部异常不会
 * 泄露为不稳定的页面契约。
 */
import { OperationError } from "@repo/shared/uol";
import { describe, expect, it } from "vitest";

import { mapOperationsActionError } from "./action-result";

describe("mapOperationsActionError", () => {
  it.each([
    "validation_error",
    "not_ready",
    "rate_limited",
    "timeout",
  ] as const)("保留客户端白名单错误码 %s", (code) => {
    expect(mapOperationsActionError(new OperationError(code, "internal"))).toBe(
      code
    );
  });

  it("未知 UOL 错误和普通异常统一降级为 unavailable", () => {
    expect(
      mapOperationsActionError(
        new OperationError("internal_error", "secret database detail")
      )
    ).toBe("unavailable");
    expect(mapOperationsActionError(new Error("secret runtime detail"))).toBe(
      "unavailable"
    );
  });
});
