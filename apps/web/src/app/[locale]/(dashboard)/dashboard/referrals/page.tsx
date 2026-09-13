/** 推广奖励页面服务端会话与时区装配入口。 */

import { getServerSession } from "@repo/shared/auth/server";
import type { ReferralRelationshipListOutput } from "@repo/shared/referrals/relationship-contract";
import { redirect } from "next/navigation";
import type { ReferralDashboardOutput } from "@/features/referrals/actions";
import { ReferralDashboard } from "@/features/referrals/referral-dashboard";
import { requestGoJson } from "@/server/go-backend-client";

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
  const [initialDashboard, initialRelationships, profile] = await Promise.all([
    requestGoJson<ReferralDashboardOutput>("/api/referrals/dashboard"),
    requestGoJson<ReferralRelationshipListOutput>(
      "/api/referrals/relationships"
    ),
    requestGoJson<{ timeZone?: string; defaultTimeZone?: string }>(
      "/api/user/profile"
    ),
  ]);
  return (
    <ReferralDashboard
      initialDashboard={initialDashboard}
      initialRelationships={initialRelationships}
      timeZone={profile.timeZone || profile.defaultTimeZone || "UTC"}
    />
  );
}
