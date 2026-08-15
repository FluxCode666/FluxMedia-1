/**
 * 自动确保运营统计 epoch 命令的 DB-free 测试。
 *
 * 使用方：Vitest；锁定发布身份校验、system Principal 和稳定 operation 名称，避免部署
 * 流水线直接访问数据库或接受调用方日期。
 */
import { describe, expect, it, vi } from "vitest";

import {
  executeEnsureCurrentOperationsEpochCommand,
  parseEnsureCurrentOperationsEpochCommand,
} from "./operations-epoch-ensure-command";

describe("ensure current operations epoch command", () => {
  it("只读取发布身份且拒绝空值", () => {
    expect(
      parseEnsureCurrentOperationsEpochCommand({
        OPERATIONS_EPOCH_INITIALIZED_BY: " release-v0.25.1 ",
        OPERATIONS_EPOCH_APP_DATE: "2020-01-01",
        OPERATIONS_EPOCH_STARTS_AT: "2020-01-01T00:00:00.000Z",
      })
    ).toEqual({ initializedBy: "release-v0.25.1" });
    expect(() => parseEnsureCurrentOperationsEpochCommand({})).toThrow(
      "OPERATIONS_EPOCH_INITIALIZED_BY"
    );
  });

  it("通过 system-only UOL operation 确保当前应用日 epoch", async () => {
    const invoke = vi.fn().mockResolvedValue({
      appDate: "2026-08-16",
      startsAt: "2026-08-15T16:00:00.000Z",
      initialized: true,
    });

    await expect(
      executeEnsureCurrentOperationsEpochCommand(
        { initializedBy: "release-v0.25.1" },
        invoke
      )
    ).resolves.toMatchObject({ initialized: true });
    expect(invoke).toHaveBeenCalledWith(
      "operations.ensureCurrentEpoch",
      { initializedBy: "release-v0.25.1" },
      {
        type: "system",
        reason: "operations-epoch-deployment-gate",
      }
    );
  });
});
