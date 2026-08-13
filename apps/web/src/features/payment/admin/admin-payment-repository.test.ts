/**
 * 管理端支付仓储事务测试。
 *
 * 不连接数据库，证明订单列表仓储固定建立 read-only repeatable-read 事务，避免
 * 精确总数与分页行落入不同 PostgreSQL 快照。
 */

import { describe, expect, it, vi } from "vitest";

const { transaction } = vi.hoisted(() => ({ transaction: vi.fn() }));

vi.mock("@repo/database", () => ({ db: { transaction } }));

import {
  type AdminPaymentTransactionDatabase,
  createAdminPaymentRepository,
} from "./admin-payment-repository";

describe("admin payment repository", () => {
  it("uses one read-only repeatable-read transaction for order pagination", async () => {
    transaction.mockResolvedValue("snapshot-result");
    const repository = createAdminPaymentRepository({
      transaction,
    } as unknown as AdminPaymentTransactionDatabase);

    await expect(
      repository.withReadOnlyOrderSnapshot(async () => "unused")
    ).resolves.toBe("snapshot-result");
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
  });
});
