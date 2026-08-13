/** 推广奖励页面服务端会话与时区装配入口。 */

import { normalizeUserRole } from "@repo/shared/auth/roles";
import { getServerSession } from "@repo/shared/auth/server";
import { logError } from "@repo/shared/logger";
import type { ReferralRelationshipListOutput } from "@repo/shared/referrals/pagination-contract";
import { getUserTimeZone } from "@repo/shared/time-zone/server";
import { invokeOperation } from "@repo/shared/uol";
import { redirect } from "next/navigation";
import { loadPaginationConfig } from "@/features/pagination/server";
import type { ReferralDashboardOutput } from "@/features/referrals/actions";
import { ReferralDashboard } from "@/features/referrals/referral-dashboard";
import {
  buildReferralRelationshipPageHref,
  buildReferralRelationshipPageSizeHref,
  parseReferralRelationshipPagination,
  type ReferralSearchParams,
} from "@/features/referrals/referral-pagination";
import { ensureUolInitialized } from "@/server/uol-init";

/**
 * 渲染推广统计和独立关系明细页。
 *
 * @param params 当前语言参数。
 * @param searchParams 未信任的 relationshipPage/relationshipPageSize 状态。
 * @returns 全量推广统计和当前页脱敏关系记录。
 * @sideEffects 读取会话、分页配置、UOL 数据和用户时区；未登录或越界时重定向。
 */
export default async function ReferralsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<ReferralSearchParams>;
}) {
  const [{ locale }, session, rawSearchParams, paginationConfig] =
    await Promise.all([
      params,
      getServerSession(),
      searchParams,
      loadPaginationConfig(),
    ]);
  if (!session?.user) redirect(`/${locale}/sign-in`);
  const pagination = parseReferralRelationshipPagination(
    rawSearchParams,
    paginationConfig
  );
  let initialDashboard: ReferralDashboardOutput | null = null;
  let initialRelationships: ReferralRelationshipListOutput | null = null;
  await ensureUolInitialized();
  const principal = {
    type: "user" as const,
    userId: session.user.id,
    role: normalizeUserRole(session.user.role),
  };
  const [dashboardResult, relationshipResult] = await Promise.allSettled([
    invokeOperation<ReferralDashboardOutput>(
      "referral.getMyDashboard",
      {},
      principal
    ),
    invokeOperation<ReferralRelationshipListOutput>(
      "referral.listMyRelationships",
      pagination,
      principal
    ),
  ]);
  if (dashboardResult.status === "fulfilled") {
    initialDashboard = dashboardResult.value;
  } else {
    logError(dashboardResult.reason, {
      source: "referral-dashboard",
      stage: "summary-prefetch",
      userId: session.user.id,
    });
  }
  if (relationshipResult.status === "fulfilled") {
    initialRelationships = relationshipResult.value;
    if (relationshipResult.value.page !== pagination.page) {
      redirect(
        `/${locale}${buildReferralRelationshipPageHref(
          rawSearchParams,
          relationshipResult.value.page
        )}`
      );
    }
  } else {
    logError(relationshipResult.reason, {
      source: "referral-dashboard",
      stage: "relationships-prefetch",
      userId: session.user.id,
    });
  }
  return (
    <ReferralDashboard
      initialDashboard={initialDashboard}
      initialRelationships={initialRelationships}
      pageSizeOptions={paginationConfig.pageSizeOptions.map((pageSize) => ({
        size: pageSize,
        href: buildReferralRelationshipPageSizeHref(rawSearchParams, pageSize),
      }))}
      timeZone={await getUserTimeZone(session.user.id)}
    />
  );
}
