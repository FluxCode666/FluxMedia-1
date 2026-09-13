/**
 * 用户侧最近充值订单读取服务。
 *
 * 使用方：payment.listMyRecentOrders 的 Web 执行绑定。数据库适配器始终以当前
 * Principal 的 userId 过滤，并仅选择钱包列表需要的安全字段。
 */
import { getCreditPaymentDisplayStatus } from "@repo/shared/credits/purchase-orders";
import {
  type UserPaymentOrderListInput,
  type UserPaymentOrderListOutput,
  userPaymentOrderListInputSchema,
  userPaymentOrderListOutputSchema,
} from "@repo/shared/payment/user-order-contract";
import { requestGoJson } from "@/server/go-backend-client";

/** 数据库读取后进入用户态映射的最小订单行。 */
export type UserPaymentOrderRow = {
  id: string;
  provider: string;
  purpose: string;
  status: string;
  currency: string;
  amountMinor: number;
  creditsAmount: number;
  createdAt: Date;
  expiresAt: Date | null;
  fulfilledAt: Date | null;
};

/** 用户订单仓储只接受服务端派生的 userId 与有界条数。 */
export type UserPaymentOrderRepository = {
  listRecentByUser: (input: {
    userId: string;
    limit: number;
  }) => Promise<UserPaymentOrderRow[]>;
};

/** PostgreSQL 仓储：按用户、创建时间和订单 ID 稳定倒序读取充值订单。 */
export const databaseUserPaymentOrderRepository: UserPaymentOrderRepository = {
  async listRecentByUser(input) {
    // Go derives the user from the authenticated cookie. Keep the legacy
    // repository shape for callers/tests while removing the Next DB boundary.
    const output = await requestGoJson<{
      records: Array<{
        id: string;
        provider: string;
        purpose: string;
        status: string;
        currency: string;
        amountMinor: number;
        creditsAmount: number;
        createdAt: string;
        fulfilledAt: string | null;
      }>;
    }>(`/api/credits/payment-orders?limit=${encodeURIComponent(String(input.limit))}`);
    return output.records.map((row) => ({
      ...row,
      createdAt: new Date(row.createdAt),
      expiresAt: null,
      fulfilledAt: row.fulfilledAt ? new Date(row.fulfilledAt) : null,
    }));
  },
};

/**
 * 读取并映射当前用户最近充值订单。
 *
 * @param request 当前用户、查询条数、用户时区与统一快照时间。
 * @param dependencies 可替换仓储，便于 DB-free 测试用户隔离和状态映射。
 * @returns 已通过用户侧白名单契约校验的最近订单列表。
 * @throws 输入、数据库字段或输出不符合契约时显式抛出 ZodError。
 */
export async function loadUserRecentPaymentOrders(
  request: {
    userId: string;
    input: UserPaymentOrderListInput;
    timeZone: string;
    asOf?: Date;
  },
  dependencies: {
    repository: UserPaymentOrderRepository;
  } = { repository: databaseUserPaymentOrderRepository }
): Promise<UserPaymentOrderListOutput> {
  const input = userPaymentOrderListInputSchema.parse(request.input);
  const asOf = request.asOf ?? new Date();
  const records = await dependencies.repository.listRecentByUser({
    userId: request.userId,
    limit: input.limit,
  });

  return userPaymentOrderListOutputSchema.parse({
    asOf: asOf.toISOString(),
    timeZone: request.timeZone,
    records: records.map((order) => ({
      id: order.id,
      provider: order.provider,
      purpose: order.purpose,
      status: getCreditPaymentDisplayStatus({
        status: order.status,
        expiresAt: order.expiresAt,
        now: asOf,
      }),
      currency: order.currency,
      amountMinor: order.amountMinor,
      creditsAmount: order.creditsAmount,
      createdAt: order.createdAt.toISOString(),
      fulfilledAt: order.fulfilledAt?.toISOString() ?? null,
    })),
  });
}
