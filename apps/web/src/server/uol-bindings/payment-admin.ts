/**
 * 管理端支付 UOL 真实执行绑定。
 *
 * 使用方：uol-bindings.ts 启动副作用导入。统一使用部署级 APP_TIME_ZONE 作为财务
 * 报表时区，确保不同管理员看到相同的自然日与默认自然月边界。
 */
import {
  adminPaymentOrderListOutputSchema,
  adminPaymentOverviewOutputSchema,
  adminPaymentUserSearchOutputSchema,
} from "@repo/shared/payment/admin-contract";
import { getAppTimeZone } from "@repo/shared/time-zone/server";
import { bindOperationExecute, OperationError } from "@repo/shared/uol";
import {
  getAdminPaymentOverview,
  listAdminPaymentOrders,
  searchAdminPaymentUsers,
} from "@repo/shared/uol/operations/payment";

import { databaseAdminPaymentRepository } from "@/features/payment/admin/admin-payment-repository";
import {
  AdminPaymentServiceError,
  loadAdminPaymentOrders,
  loadAdminPaymentOverview,
  searchAdminPaymentOrderUsers,
} from "@/features/payment/admin/admin-payment-service";

/** 将支付应用服务校验错误映射为稳定 UOL 输入错误。 */
async function invokeAdminPaymentService<T>(
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AdminPaymentServiceError) {
      throw new OperationError(error.code, error.message);
    }
    throw error;
  }
}

/** 绑定日期范围支付概览；报告时区固定为部署配置。 */
bindOperationExecute(getAdminPaymentOverview, async (input) =>
  adminPaymentOverviewOutputSchema.parse(
    await invokeAdminPaymentService(() =>
      loadAdminPaymentOverview(
        { timeZone: getAppTimeZone(), input },
        { repository: databaseAdminPaymentRepository }
      )
    )
  )
);

/** 绑定管理员充值订单 keyset 列表；actor 只从 Principal 派生。 */
bindOperationExecute(listAdminPaymentOrders, async (input, principal) => {
  if (principal.type !== "user") {
    throw new OperationError("forbidden", "Admin access required");
  }
  return adminPaymentOrderListOutputSchema.parse(
    await invokeAdminPaymentService(() =>
      loadAdminPaymentOrders(
        { actorUserId: principal.userId, input },
        { repository: databaseAdminPaymentRepository }
      )
    )
  );
});

/** 绑定存在充值记录的用户邮箱搜索。 */
bindOperationExecute(searchAdminPaymentUsers, async (input) =>
  adminPaymentUserSearchOutputSchema.parse(
    await invokeAdminPaymentService(() =>
      searchAdminPaymentOrderUsers(input, {
        repository: databaseAdminPaymentRepository,
      })
    )
  )
);
