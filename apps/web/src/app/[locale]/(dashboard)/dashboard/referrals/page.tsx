/** 推广奖励页面服务端会话与时区装配入口。 */

import { normalizeUserRole } from "@repo/shared/auth/roles";
import { getServerSession } from "@repo/shared/auth/server";
import { logError } from "@repo/shared/logger";
import type { ReferralRelationshipListOutput } from "@repo/shared/referrals/relationship-contract";
import { getUserTimeZone } from "@repo/shared/time-zone/server";
import { invokeOperation } from "@repo/shared/uol";
import { redirect } from "next/navigation";
import type { ReferralDashboardOutput } from "@/features/referrals/actions";
import { ReferralDashboard } from "@/features/referrals/referral-dashboard";
import { ensureUolInitialized } from "@/server/uol-init";

/**
 * 渲染推广统计和独立关系明细页。
 *
 * @param params 当前语言参数。
 * @returns 全量推广统计和全部脱敏关系记录。
 * @sideEffects 读取会话、UOL 数据和用户时区；未登录时重定向。
 */
export default async function ReferralsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const [{ locale }, session] = await Promise.all([params, getServerSession()]);
  if (!session?.user) redirect(`/${locale}/sign-in`);
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
      {},
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
      timeZone={await getUserTimeZone(session.user.id)}
    />
  );
}
