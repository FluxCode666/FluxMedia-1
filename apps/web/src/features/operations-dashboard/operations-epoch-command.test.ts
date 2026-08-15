/**
 * 运营统计 epoch 初始化命令的 DB-free 测试。
 *
 * 使用方：Vitest；锁定环境输入、默认预演、显式写入和自然日零点校验，避免运维
 * 命令在参数不完整或时区边界错误时触发不可变数据库写入。
 */
import { describe, expect, it, vi } from "vitest";

import {
  executeOperationsEpochCommand,
  parseOperationsEpochCommand,
} from "./operations-epoch-command";

const validEnvironment = {
  OPERATIONS_EPOCH_APP_DATE: "2026-08-15",
  OPERATIONS_EPOCH_STARTS_AT: "2026-08-14T16:00:00.000Z",
  OPERATIONS_EPOCH_INITIALIZED_BY: "release-v0.9.0",
  OPERATIONS_EPOCH_REQUEST_ID: "operations-epoch-2026-08-15",
};

describe("operations epoch command", () => {
  it("默认只预演并规范化显式环境输入", () => {
    expect(
      parseOperationsEpochCommand([], validEnvironment, "Asia/Shanghai")
    ).toEqual({
      apply: false,
      input: {
        appDate: "2026-08-15",
        startsAt: "2026-08-14T16:00:00.000Z",
        initializedBy: "release-v0.9.0",
        requestId: "operations-epoch-2026-08-15",
      },
      timeZone: "Asia/Shanghai",
    });
  });

  it("只有显式 --apply 才调用 UOL operation", async () => {
    const invoke = vi.fn().mockResolvedValue({
      appDate: "2026-08-15",
      startsAt: "2026-08-14T16:00:00.000Z",
      initialized: true,
    });
    const preview = parseOperationsEpochCommand(
      [],
      validEnvironment,
      "Asia/Shanghai"
    );
    const apply = parseOperationsEpochCommand(
      ["--apply"],
      validEnvironment,
      "Asia/Shanghai"
    );

    await expect(
      executeOperationsEpochCommand(preview, invoke)
    ).resolves.toEqual({ mode: "preview", ...preview });
    expect(invoke).not.toHaveBeenCalled();

    await expect(executeOperationsEpochCommand(apply, invoke)).resolves.toEqual(
      {
        mode: "applied",
        result: {
          appDate: "2026-08-15",
          startsAt: "2026-08-14T16:00:00.000Z",
          initialized: true,
        },
        timeZone: "Asia/Shanghai",
      }
    );
    expect(invoke).toHaveBeenCalledWith(
      "operations.initializeEpoch",
      apply.input,
      {
        type: "system",
        reason: "operations-epoch-initialization-command",
      }
    );
  });

  it("拒绝缺失输入、未知参数和不匹配的应用日零点", () => {
    expect(() =>
      parseOperationsEpochCommand(
        [],
        { ...validEnvironment, OPERATIONS_EPOCH_REQUEST_ID: undefined },
        "Asia/Shanghai"
      )
    ).toThrow("OPERATIONS_EPOCH_REQUEST_ID");
    expect(() =>
      parseOperationsEpochCommand(
        ["--force"],
        validEnvironment,
        "Asia/Shanghai"
      )
    ).toThrow("未知参数");
    expect(() =>
      parseOperationsEpochCommand(
        [],
        {
          ...validEnvironment,
          OPERATIONS_EPOCH_STARTS_AT: "2026-08-15T00:00:00.000Z",
        },
        "Asia/Shanghai"
      )
    ).toThrow("应用时区自然日零点");
  });
});
