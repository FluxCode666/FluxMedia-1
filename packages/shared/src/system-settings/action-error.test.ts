/**
 * 系统设置更新 Action 错误提示测试。
 *
 * 职责：锁定可信设置校验错误可展示字段名与原因，同时确保未知或内部错误不会把
 * 服务端异常文本直接暴露给管理员页面。
 */
import { describe, expect, it } from "vitest";

import { OperationError } from "../uol/errors";
import { getSystemSettingsUpdateUserMessage } from "./action-error";

describe("getSystemSettingsUpdateUserMessage", () => {
  it("返回可信设置校验错误的字段名与具体原因", () => {
    const error = new OperationError(
      "validation_error",
      "System setting validation failed",
      {
        fieldLabel: "单次上传总量 MB",
        kind: "system_setting_validation",
        reason: "不能大于 512",
      }
    );

    expect(getSystemSettingsUpdateUserMessage(error)).toBe(
      "单次上传总量 MB：不能大于 512"
    );
  });

  it("不透传普通 UOL 输入校验或内部错误文本", () => {
    expect(
      getSystemSettingsUpdateUserMessage(
        new OperationError("validation_error", "Input validation failed")
      )
    ).toBe("系统设置参数格式不正确，请检查后重试");
    expect(
      getSystemSettingsUpdateUserMessage(
        new OperationError("internal_error", "secret database failure")
      )
    ).toBeUndefined();
  });

  it("为权限错误返回稳定提示但不吞掉基础设施错误", () => {
    expect(
      getSystemSettingsUpdateUserMessage(
        new OperationError("forbidden", "Admin access required")
      )
    ).toBe("无权修改系统设置");
    expect(
      getSystemSettingsUpdateUserMessage(
        new OperationError("timeout", "Database query timed out")
      )
    ).toBeUndefined();
  });

  it("让非 OperationError 保持上抛", () => {
    expect(
      getSystemSettingsUpdateUserMessage(new Error("unexpected"))
    ).toBeUndefined();
  });
});
