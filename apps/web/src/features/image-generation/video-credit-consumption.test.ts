/**
 * 视频扣费提交结果对账策略的 DB-free 单测。
 *
 * 职责：覆盖扣费成功、明确失败、提交后响应中断，以及账本不可查询四个边界。
 */
import { describe, expect, it, vi } from "vitest";

import { reconcileVideoCreditConsumption } from "./video-credit-consumption";

describe("video credit consumption reconciliation", () => {
  it("扣费成功时不额外查询账本", async () => {
    const hasLedgerConsumption = vi.fn();

    await expect(
      reconcileVideoCreditConsumption({
        consume: async () => undefined,
        hasLedgerConsumption,
        isDefinitiveRejection: () => false,
      })
    ).resolves.toEqual({ consumed: true });
    expect(hasLedgerConsumption).not.toHaveBeenCalled();
  });

  it("扣费响应中断但账本已提交时按已扣费继续", async () => {
    await expect(
      reconcileVideoCreditConsumption({
        consume: async () => {
          throw new Error("connection reset after commit");
        },
        hasLedgerConsumption: async () => true,
        isDefinitiveRejection: () => false,
      })
    ).resolves.toEqual({ consumed: true });
  });

  it("扣费失败且账本不存在时保留原错误", async () => {
    const error = new Error("insufficient credits");

    await expect(
      reconcileVideoCreditConsumption({
        consume: async () => {
          throw error;
        },
        hasLedgerConsumption: async () => false,
        isDefinitiveRejection: (candidate) => candidate === error,
      })
    ).resolves.toEqual({ consumed: false, error });
  });

  it("扣费结果和账本都不确定时上抛并等待 worker 重试", async () => {
    const ledgerError = new Error("ledger unavailable");

    await expect(
      reconcileVideoCreditConsumption({
        consume: async () => {
          throw new Error("connection reset");
        },
        hasLedgerConsumption: async () => {
          throw ledgerError;
        },
        isDefinitiveRejection: () => false,
      })
    ).rejects.toBe(ledgerError);
  });

  it("未知错误即使首次未命中账本也保留 charged 重试", async () => {
    const connectionError = new Error("commit response interrupted");

    await expect(
      reconcileVideoCreditConsumption({
        consume: async () => {
          throw connectionError;
        },
        hasLedgerConsumption: async () => false,
        isDefinitiveRejection: () => false,
      })
    ).rejects.toBe(connectionError);
  });
});
