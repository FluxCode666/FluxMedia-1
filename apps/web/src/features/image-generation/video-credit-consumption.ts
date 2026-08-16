/**
 * 视频扣费提交结果的对账策略。
 *
 * 职责：当扣费调用抛错时，以稳定 sourceRef 对应的账本事实区分“明确未扣费”与
 * “数据库已提交但响应中断”。使用方是视频持久 worker；依赖通过函数端口注入，
 * 便于覆盖逐崩溃点且不连接数据库。
 */

/** 视频扣费已收敛，或明确未产生账本记录。 */
export type VideoCreditConsumptionResult =
  | { consumed: true }
  | { consumed: false; error: unknown };

/**
 * 校验消费结果或已存账本金额等于调用方传入的固定报价。
 *
 * 金额不一致不是可重试的瞬态问题：继续处理会把任务的不可变报价与财务真相分叉，
 * 因此必须立刻 fail closed，等待人工介入而不能将任务误判为已扣费。
 */
function assertConsumedAmountMatchesExpected(
  consumedAmount: number,
  expectedAmount: number
): void {
  if (
    !Number.isFinite(consumedAmount) ||
    !Number.isFinite(expectedAmount) ||
    consumedAmount <= 0 ||
    expectedAmount <= 0 ||
    consumedAmount !== expectedAmount
  ) {
    throw new Error("视频消费账本金额与预期报价不一致");
  }
}

/**
 * 执行幂等扣费，并在调用失败时查询账本真相。
 *
 * 账本查询本身失败时必须上抛，让持久 worker 保留 charged 状态重试；此时绝不能
 * 猜测为未扣费并清零任务，否则会在事务已提交但响应丢失时造成少退积分。
 */
export async function reconcileVideoCreditConsumption(input: {
  /** v2 为 videoBillingSnapshot.quotedCredits；v1 为历史按秒金额。 */
  expectedAmount: number;
  /** 消费接口必须回传实际账本金额，幂等重放也同样适用。 */
  consume: () => Promise<{ consumedAmount: number }>;
  /** 查询稳定 sourceRef 的既存消费账本金额；未命中返回 null。 */
  getLedgerConsumptionAmount: () => Promise<number | null>;
  isDefinitiveRejection: (error: unknown) => boolean;
}): Promise<VideoCreditConsumptionResult> {
  let result: { consumedAmount: number };
  try {
    result = await input.consume();
  } catch (error) {
    const ledgerAmount = await input.getLedgerConsumptionAmount();
    if (ledgerAmount !== null) {
      assertConsumedAmountMatchesExpected(ledgerAmount, input.expectedAmount);
      return { consumed: true };
    }
    if (input.isDefinitiveRejection(error)) {
      return { consumed: false, error };
    }
    // COMMIT 响应中断时，另一连接的即时查询可能先于原事务最终提交。未知错误即使
    // 首次未命中账本也必须保留 charged，下一轮以同一 sourceRef 幂等重放。
    throw error;
  }
  assertConsumedAmountMatchesExpected(
    result.consumedAmount,
    input.expectedAmount
  );
  return { consumed: true };
}
