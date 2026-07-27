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
 * 执行幂等扣费，并在调用失败时查询账本真相。
 *
 * 账本查询本身失败时必须上抛，让持久 worker 保留 charged 状态重试；此时绝不能
 * 猜测为未扣费并清零任务，否则会在事务已提交但响应丢失时造成少退积分。
 */
export async function reconcileVideoCreditConsumption(input: {
  consume: () => Promise<unknown>;
  hasLedgerConsumption: () => Promise<boolean>;
  isDefinitiveRejection: (error: unknown) => boolean;
}): Promise<VideoCreditConsumptionResult> {
  try {
    await input.consume();
    return { consumed: true };
  } catch (error) {
    if (await input.hasLedgerConsumption()) return { consumed: true };
    if (input.isDefinitiveRejection(error)) {
      return { consumed: false, error };
    }
    // COMMIT 响应中断时，另一连接的即时查询可能先于原事务最终提交。未知错误即使
    // 首次未命中账本也必须保留 charged，下一轮以同一 sourceRef 幂等重放。
    throw error;
  }
}
