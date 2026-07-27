"use server";

/**
 * 管理端支付查询 Server Action 薄适配器。
 *
 * 使用方：支付概览页、订单管理页及邮箱搜索下拉。这里只校验输入、使用 adminAction
 * 构造真实管理员 Principal 并调用 UOL，不直接查询数据库或复制财务口径。
 */
import {
  type AdminPaymentOrderListOutput,
  type AdminPaymentOverviewOutput,
  type AdminPaymentUserSearchOutput,
  adminPaymentOrderListInputSchema,
  adminPaymentOverviewInputSchema,
  adminPaymentUserSearchInputSchema,
} from "@repo/shared/payment/admin-contract";
import { adminAction } from "@repo/shared/safe-action";
import { invokeOperation } from "@repo/shared/uol";

import { ensureUolInitialized } from "@/server/uol-init";

/** 读取指定或当前自然月的充值支付概览。 */
export const getAdminPaymentOverviewAction = adminAction
  .metadata({ action: "payment.getAdminOverview" })
  .schema(adminPaymentOverviewInputSchema)
  .action(async ({ parsedInput, ctx }): Promise<AdminPaymentOverviewOutput> => {
    await ensureUolInitialized();
    return invokeOperation<AdminPaymentOverviewOutput>(
      "payment.getAdminOverview",
      parsedInput,
      { type: "user", userId: ctx.userId, role: ctx.role }
    );
  });

/** 读取一页全站充值订单。 */
export const listAdminPaymentOrdersAction = adminAction
  .metadata({ action: "payment.listAdminOrders" })
  .schema(adminPaymentOrderListInputSchema)
  .action(
    async ({ parsedInput, ctx }): Promise<AdminPaymentOrderListOutput> => {
      await ensureUolInitialized();
      return invokeOperation<AdminPaymentOrderListOutput>(
        "payment.listAdminOrders",
        parsedInput,
        { type: "user", userId: ctx.userId, role: ctx.role }
      );
    }
  );

/** 按邮箱片段搜索存在充值记录的用户。 */
export const searchAdminPaymentOrderUsersAction = adminAction
  .metadata({ action: "payment.searchAdminOrderUsers" })
  .schema(adminPaymentUserSearchInputSchema)
  .action(
    async ({ parsedInput, ctx }): Promise<AdminPaymentUserSearchOutput> => {
      await ensureUolInitialized();
      return invokeOperation<AdminPaymentUserSearchOutput>(
        "payment.searchAdminOrderUsers",
        parsedInput,
        { type: "user", userId: ctx.userId, role: ctx.role }
      );
    }
  );
